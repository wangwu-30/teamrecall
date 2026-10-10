import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd: cwd ?? process.cwd(), timeout: 30_000 });
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await git(["branch", "--show-current"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function gitHasRemote(remote: string, cwd?: string): Promise<boolean> {
  try {
    const { stdout } = await git(["remote"], cwd);
    return stdout.split("\n").includes(remote);
  } catch {
    return false;
  }
}

export async function isGitWorktreeDirty(cwd?: string): Promise<boolean> {
  try {
    const { stdout } = await git(["status", "--porcelain"], cwd);
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

export async function gitAddAndCommit(
  files: string[],
  message: string,
  cwd?: string,
): Promise<void> {
  if (files.length === 0) return;
  await git(["add", "--", ...files], cwd);
  try {
    await git(["diff", "--cached", "--quiet", "--", ...files], cwd);
    return;
  } catch {}
  await git(["commit", "-m", message, "--", ...files], cwd);
}
