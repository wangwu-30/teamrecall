import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { exists } from "./utils/atomic.js";
import { getCurrentBranch, gitHasRemote } from "./utils/git.js";
import type { PullRequestContext } from "./types.js";

const exec = promisify(execFile);

export async function commandExists(command: string): Promise<boolean> {
  try {
    await exec("sh", ["-c", `command -v ${command}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec(command, args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout ?? "";
}

export async function fetchPullRequest(pr: string, cwd: string): Promise<PullRequestContext> {
  const view = JSON.parse(await run("gh", [
    "pr", "view", pr, "--json",
    "number,title,body,url,author,commits,files",
  ], cwd)) as {
    number: number;
    title: string;
    body: string;
    url: string;
    author?: { login?: string };
    commits?: Array<{ oid?: string; messageHeadline?: string }>;
    files?: Array<{ path?: string }>;
  };

  let diff = "";
  try {
    diff = await run("gh", ["pr", "diff", pr], cwd);
  } catch {
    diff = "";
  }

  const review_comments = await fetchReviewComments(pr, cwd);
  const commits = (view.commits ?? []).map((commit) => commit.oid).filter((oid): oid is string => Boolean(oid));
  const commit_messages = (view.commits ?? [])
    .map((commit) => commit.messageHeadline)
    .filter((message): message is string => Boolean(message));

  return {
    number: String(view.number ?? pr),
    title: view.title ?? "",
    body: view.body ?? "",
    url: view.url ?? "",
    author: view.author?.login ?? "unknown",
    diff,
    review_comments,
    commit_messages,
    commits,
    files: (view.files ?? []).map((file) => file.path).filter((item): item is string => Boolean(item)),
  };
}

async function fetchReviewComments(pr: string, cwd: string): Promise<string[]> {
  const comments: string[] = [];
  try {
    const issue = JSON.parse(await run("gh", [
      "pr", "view", pr, "--json", "reviews,comments",
    ], cwd)) as {
      reviews?: Array<{ body?: string }>;
      comments?: Array<{ body?: string }>;
    };
    for (const review of issue.reviews ?? []) {
      if (review.body?.trim()) comments.push(review.body.trim());
    }
    for (const comment of issue.comments ?? []) {
      if (comment.body?.trim()) comments.push(comment.body.trim());
    }
  } catch {
    // Optional: inline review comments via the REST API when available.
  }

  try {
    const inline = JSON.parse(await run("gh", [
      "api",
      `repos/{owner}/{repo}/pulls/${pr}/comments`,
      "--jq", "[.[].body]",
    ], cwd)) as string[];
    comments.push(...inline.filter(Boolean));
  } catch {
    // Fine when the token cannot read review threads.
  }

  return unique(comments);
}

export async function listMergedPullRequests(cwd: string, limit: number): Promise<string[]> {
  const rows = JSON.parse(await run("gh", [
    "pr", "list",
    "--state", "merged",
    "--limit", String(limit),
    "--json", "number",
  ], cwd)) as Array<{ number: number }>;
  return rows.map((row) => String(row.number));
}

export async function setClaudeSecret(token: string, cwd: string): Promise<boolean> {
  try {
    await exec("gh", ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--body", token], {
      cwd,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

export const GIT_AUTHOR_NAME = "github-actions[bot]";
export const GIT_AUTHOR_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export const MANAGED_GIT_PATHS = [
  ".memory",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".github/workflows/teamrecall.yml",
  ".github/workflows/teamrecall-sweep.yml",
  ".claude/rules/teamrecall",
  ".cursor/rules",
];

export function gitIdentityArgs(): string[] {
  return [
    "-c", `user.name=${GIT_AUTHOR_NAME}`,
    "-c", `user.email=${GIT_AUTHOR_EMAIL}`,
  ];
}

export interface OpenPrInput {
  cwd: string;
  branch: string;
  title: string;
  body: string;
  files?: string[];
  base?: string;
  force?: boolean;
  startPoint?: string;
}

export function gitPushArgs(branch: string, options?: { force?: boolean }): string[] {
  const args = ["push", "-u", "origin", branch];
  if (options?.force) args.splice(1, 0, "--force-with-lease");
  return args;
}

export function isManagedPath(file: string): boolean {
  const normalized = file.replace(/^"|"$/g, "").replace(/^.* -> /, "");
  return MANAGED_GIT_PATHS.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export async function listDirtyManagedPaths(cwd: string): Promise<string[]> {
  const stdout = await run("git", ["status", "--porcelain", "--untracked-files=all"], cwd);
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => isManagedPath(line.slice(3)));
}

export async function assertManagedPathsClean(cwd: string): Promise<void> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    throw new Error("Refusing to run `learn --pr`: not a git repository. Commit or initialize git first.");
  }
  const dirty = await listDirtyManagedPaths(cwd);
  if (dirty.length === 0) return;
  throw new Error(
    [
      "Refusing to run `learn --pr`: managed paths have uncommitted changes.",
      "Commit or stash them first so they are not swept into the bot commit.",
      ...dirty,
    ].join("\n"),
  );
}

export async function existingManagedPaths(cwd: string): Promise<string[]> {
  const found: string[] = [];
  for (const relative of MANAGED_GIT_PATHS) {
    if (await exists(path.join(cwd, relative))) found.push(relative);
  }
  return found;
}

export async function stageManagedChanges(cwd: string): Promise<boolean> {
  const paths = await existingManagedPaths(cwd);
  if (paths.length === 0) return false;
  await run("git", ["add", "-A", "--", ...paths], cwd);
  try {
    await run("git", ["diff", "--cached", "--quiet", "--", ...paths], cwd);
    return false;
  } catch {
    return true;
  }
}

export async function openPullRequest(input: OpenPrInput): Promise<string | null> {
  const original = await getCurrentBranch(input.cwd);
  try {
    const created = input.startPoint
      ? ["checkout", "-B", input.branch, input.startPoint]
      : ["checkout", "-B", input.branch];
    await run("git", created, input.cwd);
    const dirty = await stageManagedChanges(input.cwd);
    if (!dirty) return null;
    await run("git", [...gitIdentityArgs(), "commit", "-m", input.title], input.cwd);
    if (!(await gitHasRemote("origin", input.cwd))) {
      return null;
    }
    await run("git", gitPushArgs(input.branch, { force: input.force }), input.cwd);
    if (!(await isGithubRemote(input.cwd))) {
      return null;
    }
    const args = ["pr", "create", "--title", input.title, "--body", input.body];
    if (input.base) args.push("--base", input.base);
    return (await run("gh", args, input.cwd)).trim();
  } finally {
    await restoreStartingBranch(input.cwd, original, input.branch);
  }
}

async function restoreStartingBranch(cwd: string, original: string | null, botBranch: string): Promise<void> {
  const target = original && original !== botBranch ? original : original ?? "main";
  if (target === botBranch) return;
  try {
    await run("git", ["checkout", target], cwd);
  } catch {
    await run("git", ["checkout", "-B", target], cwd);
  }
}

export async function isGithubRemote(cwd: string): Promise<boolean> {
  try {
    const url = await run("git", ["remote", "get-url", "origin"], cwd);
    return /github\.com[:/]/i.test(url);
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
