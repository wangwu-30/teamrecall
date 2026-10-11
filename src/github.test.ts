import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_AUTHOR_NAME,
  MANAGED_GIT_PATHS,
  authoredCommentApiArgs,
  evidenceFilesFromComments,
  gitIdentityArgs,
  gitPushArgs,
  openPullRequest,
  pullRequestAlreadyExists,
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

  it("collects evidence files from human comments only and paginates gh api", () => {
    expect(evidenceFilesFromComments([
      { body: "bot nit", author: "copilot", user_type: "Bot", path: "src/bot.ts" },
      { body: "human", author: "alice", user_type: "User", path: ".changeset/a.md" },
      { body: "also human", author: "bob", path: "src/a.ts" },
    ])).toEqual([".changeset/a.md", "src/a.ts"]);
    const args = authoredCommentApiArgs("repos/{owner}/{repo}/pulls/1/comments");
    expect(args).toContain("--paginate");
    expect(args[0]).toBe("api");
  });

  it("includes teamrecall workflow files in the managed commit", () => {
    expect(MANAGED_GIT_PATHS).toEqual(expect.arrayContaining([
      ".github/workflows/teamrecall.yml",
      ".github/workflows/teamrecall-sweep.yml",
    ]));
  });

  it("treats an already-open sweep PR as success", () => {
    expect(pullRequestAlreadyExists("a pull request already exists for teamrecall/sweep")).toBe(true);
    expect(pullRequestAlreadyExists("GraphQL: already exists (createPullRequest)")).toBe(true);
    expect(pullRequestAlreadyExists("HTTP 401")).toBe(false);
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

  it("returns a fresh repo to main instead of leaving it on the init branch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-fresh-"));
    dirs.push(dir);
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await fs.mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
    await fs.writeFile(path.join(dir, ".github", "workflows", "teamrecall.yml"), "name: teamrecall\n", "utf8");
    await fs.mkdir(path.join(dir, ".memory"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "README.md"), "mem\n", "utf8");

    await openPullRequest({
      cwd: dir,
      branch: "teamrecall/init",
      title: "🧠 teamrecall: initialize team memory",
      body: "init",
    });
    expect(await getCurrentBranch(dir)).toBe("main");
    const { stdout } = await exec("git", ["show", "teamrecall/init:.github/workflows/teamrecall.yml"], { cwd: dir });
    expect(stdout).toContain("name: teamrecall");
  }, 15_000);
});
