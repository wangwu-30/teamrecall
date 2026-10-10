import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { exists } from "./utils/atomic.js";
import { getCurrentBranch, gitHasRemote } from "./utils/git.js";
import { humanCommentBodies, type AuthoredComment } from "./human-comments.js";
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
    "number,title,body,url,author,commits,files,mergedAt,state",
  ], cwd)) as {
    number: number;
    title: string;
    body: string;
    url: string;
    author?: { login?: string };
    commits?: Array<{ oid?: string; messageHeadline?: string }>;
    files?: Array<{ path?: string }>;
    mergedAt?: string | null;
    state?: string;
  };

  let diff = "";
  try {
    diff = await run("gh", ["pr", "diff", pr], cwd);
  } catch {
    diff = "";
  }

  const authored = await fetchAuthoredComments(pr, cwd);
  const human_review_comments = humanCommentBodies(authored);
  const merged = Boolean(view.mergedAt) || view.state === "MERGED";
  const review_comments = merged
    ? unique(authored.map((comment) => comment.body.trim()).filter(Boolean))
    : human_review_comments;
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
    merged,
    review_comments,
    human_review_comments,
    commit_messages,
    commits,
    files: (view.files ?? []).map((file) => file.path).filter((item): item is string => Boolean(item)),
  };
}

export async function fetchAuthoredComments(pr: string, cwd: string): Promise<AuthoredComment[]> {
  const comments: AuthoredComment[] = [];
  const endpoints = [
    `repos/{owner}/{repo}/issues/${pr}/comments`,
    `repos/{owner}/{repo}/pulls/${pr}/comments`,
    `repos/{owner}/{repo}/pulls/${pr}/reviews`,
  ];
  for (const endpoint of endpoints) {
    try {
      const rows = JSON.parse(await run("gh", [
        "api",
        endpoint,
        "--jq", "[.[] | select(.body != null and .body != \"\") | {body, author: .user.login, user_type: .user.type}]",
      ], cwd)) as AuthoredComment[];
      comments.push(...rows.filter((comment) => comment.body?.trim()));
    } catch {
      // Fine when the token cannot read that collection.
    }
  }

  if (comments.length > 0) return comments;

  try {
    const issue = JSON.parse(await run("gh", [
      "pr", "view", pr, "--json", "reviews,comments",
    ], cwd)) as {
      reviews?: Array<{ body?: string; author?: { login?: string } }>;
      comments?: Array<{ body?: string; author?: { login?: string } }>;
    };
    for (const review of issue.reviews ?? []) {
      if (review.body?.trim()) {
        comments.push({ body: review.body.trim(), author: review.author?.login ?? "" });
      }
    }
    for (const comment of issue.comments ?? []) {
      if (comment.body?.trim()) {
        comments.push({ body: comment.body.trim(), author: comment.author?.login ?? "" });
      }
    }
  } catch {
    // Optional fallback when REST is unavailable.
  }

  return comments;
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

export async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = (await run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd)).trim();
    const name = ref.replace(/^refs\/remotes\/origin\//, "");
    if (name) return name;
  } catch {
    // origin/HEAD is not always set.
  }
  try {
    const head = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    if (head && head !== "HEAD") return head;
  } catch {
    // Detached HEAD.
  }
  return "main";
}

export async function startPointForBotBranch(cwd: string): Promise<string | undefined> {
  const def = await getDefaultBranch(cwd);
  try {
    await run("git", ["rev-parse", "--verify", `origin/${def}`], cwd);
    return `origin/${def}`;
  } catch {
    try {
      await run("git", ["rev-parse", "--verify", def], cwd);
      return def;
    } catch {
      return undefined;
    }
  }
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
    return createOrReusePullRequest({
      cwd: input.cwd,
      branch: input.branch,
      title: input.title,
      body: input.body,
      base: input.base,
    });
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

export function pullRequestAlreadyExists(error: string): boolean {
  return /already exists|already a pull request/i.test(error);
}

export async function viewPullRequestUrl(cwd: string, branch: string): Promise<string | null> {
  try {
    const url = (await run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], cwd)).trim();
    return url || null;
  } catch {
    return null;
  }
}

export async function createOrReusePullRequest(input: {
  cwd: string;
  branch: string;
  title: string;
  body: string;
  base?: string;
}): Promise<string | null> {
  const existing = await viewPullRequestUrl(input.cwd, input.branch);
  if (existing) return existing;
  try {
    const args = ["pr", "create", "--title", input.title, "--body", input.body, "--head", input.branch];
    if (input.base) args.push("--base", input.base);
    return (await run("gh", args, input.cwd)).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reused = await viewPullRequestUrl(input.cwd, input.branch);
    if (reused) return reused;
    if (pullRequestAlreadyExists(message)) return null;
    throw error;
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
