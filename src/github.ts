import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  const { stdout } = await exec(command, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
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

export interface OpenPrInput {
  cwd: string;
  branch: string;
  title: string;
  body: string;
  files: string[];
  base?: string;
}

export async function openPullRequest(input: OpenPrInput): Promise<string | null> {
  if (input.files.length === 0) return null;
  await run("git", ["checkout", "-B", input.branch], input.cwd);
  await run("git", ["add", "--", ...input.files], input.cwd);
  try {
    await run("git", ["diff", "--cached", "--quiet", "--", ...input.files], input.cwd);
    return null;
  } catch {
    // Cached diff is non-empty, continue.
  }
  await run("git", ["commit", "-m", input.title, "--", ...input.files], input.cwd);
  await run("git", ["push", "-u", "origin", input.branch], input.cwd);
  const args = ["pr", "create", "--title", input.title, "--body", input.body];
  if (input.base) args.push("--base", input.base);
  return (await run("gh", args, input.cwd)).trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
