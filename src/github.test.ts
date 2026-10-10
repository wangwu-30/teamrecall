import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_AUTHOR_NAME,
  gitIdentityArgs,
  gitPushArgs,
  openPullRequest,
  stageManagedChanges,
} from "./github.js";
import { getCurrentBranch } from "./utils/git.js";

const exec = promisify(execFile);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function gitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-git-"));
  dirs.push(dir);
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.test", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

describe("git identity and staging", () => {
  it("sets github-actions identity on commit", () => {
    const args = gitIdentityArgs();
    expect(args).toContain("user.name=github-actions[bot]");
    expect(args.join(" ")).toContain(GIT_AUTHOR_NAME);
    expect(args.join(" ")).toContain("41898282+github-actions[bot]@users.noreply.github.com");
  });

  it("force-with-lease when rewriting a fixed bot branch", () => {
    expect(gitPushArgs("teamrecall/sweep")).toEqual(["push", "-u", "origin", "teamrecall/sweep"]);
    expect(gitPushArgs("teamrecall/sweep", { force: true })).toEqual([
      "push", "--force-with-lease", "-u", "origin", "teamrecall/sweep",
    ]);
  });

  it("stages deletions of managed memory files with git add -A", async () => {
    const dir = await gitRepo();
    const memory = path.join(dir, ".memory", "memories", "M-001.md");
    await fs.mkdir(path.dirname(memory), { recursive: true });
    await fs.writeFile(memory, "old\n", "utf8");
    await exec("git", ["add", "-A", "--", ".memory"], { cwd: dir });
    await exec("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.test", "commit", "-m", "add memory"], { cwd: dir });
    await fs.rm(memory);
    await fs.mkdir(path.join(dir, ".memory", "retired"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "retired", "M-001.md"), "retired\n", "utf8");

    const dirty = await stageManagedChanges(dir);
    expect(dirty).toBe(true);
    const { stdout } = await exec("git", ["diff", "--cached", "--name-status"], { cwd: dir });
    expect(stdout).toMatch(/D\s+.memory\/memories\/M-001.md/);
    expect(stdout).toMatch(/A\s+.memory\/retired\/M-001.md/);
  });

  it("switches back to the original branch after opening a learn PR", async () => {
    const dir = await gitRepo();
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-001.md"), "new\n", "utf8");

    const url = await openPullRequest({
      cwd: dir,
      branch: "teamrecall/learn-from-pr-42",
      title: "🧠 teamrecall: learned 1 (from #42)",
      body: "test",
    });
    expect(url).toBeNull();
    expect(await getCurrentBranch(dir)).toBe("main");
    const { stdout } = await exec("git", ["log", "-1", "--format=%an", "teamrecall/learn-from-pr-42"], { cwd: dir });
    expect(stdout.trim()).toBe(GIT_AUTHOR_NAME);
  });

  it("force-with-lease updates an existing fixed bot branch", async () => {
    const dir = await gitRepo();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-remote-"));
    dirs.push(remote);
    await exec("git", ["init", "--bare"], { cwd: remote });
    await exec("git", ["remote", "add", "origin", remote], { cwd: dir });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: dir });

    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-001.md"), "one\n", "utf8");
    await expect(openPullRequest({
      cwd: dir,
      branch: "teamrecall/sweep",
      title: "first sweep",
      body: "first",
      force: true,
    })).resolves.toBeNull();
    expect(await getCurrentBranch(dir)).toBe("main");

    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-002.md"), "two\n", "utf8");
    await expect(openPullRequest({
      cwd: dir,
      branch: "teamrecall/sweep",
      title: "second sweep",
      body: "second",
      force: true,
    })).resolves.toBeNull();

    const { stdout } = await exec("git", ["ls-remote", "--heads", "origin", "teamrecall/sweep"], { cwd: dir });
    expect(stdout).toContain("refs/heads/teamrecall/sweep");
    await exec("git", ["fetch", "origin", "teamrecall/sweep"], { cwd: dir });
    const { stdout: message } = await exec("git", ["log", "-1", "--format=%s", "origin/teamrecall/sweep"], { cwd: dir });
    expect(message.trim()).toBe("second sweep");
  }, 20_000);
});
