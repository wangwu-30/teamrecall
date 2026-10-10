import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatMemory } from "./memory.js";
import { formatSweepReport, globMatches, isExpired, isPathDead, listRepoFiles, runSweep } from "./sweep.js";
import type { Memory } from "./types.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function memory(partial: Partial<Memory["frontmatter"]> & { id: string; body?: string }): Memory {
  return {
    frontmatter: {
      id: partial.id,
      kind: partial.kind ?? "gotcha",
      paths: partial.paths ?? ["src/gone/**/*.ts"],
      evidence: {},
      author: "alice",
      created: "2026-01-01",
      review_after: partial.review_after ?? "2026-04-01",
      status: partial.status ?? "active",
    },
    body: partial.body ?? "A lesson.",
    filepath: `/tmp/${partial.id}.md`,
  };
}

describe("sweep matching", () => {
  it("flags expired and path-dead memories", () => {
    expect(isExpired(memory({ id: "M-001", review_after: "2026-01-01" }), "2026-10-10")).toBe(true);
    expect(isExpired(memory({ id: "M-001", review_after: "2026-12-01" }), "2026-10-10")).toBe(false);
    expect(isPathDead(memory({ id: "M-001", paths: ["src/gone/**/*.ts"] }), ["src/keep/a.ts"])).toBe(true);
    expect(isPathDead(memory({ id: "M-001", paths: ["src/keep/**/*.ts"] }), ["src/keep/a.ts"])).toBe(false);
    expect(globMatches("src/**/*.ts", "src/keep/a.ts")).toBe(true);
    expect(globMatches("src/**/*.{ts,js}", "src/keep/a.ts")).toBe(true);
    expect(globMatches("src/**/*.{ts,js}", "src/keep/a.js")).toBe(true);
    expect(globMatches("src/**/*.{ts,js}", "src/keep/a.md")).toBe(false);
    expect(globMatches("{src,lib}/**/*.ts", "lib/x.ts")).toBe(true);
    expect(isPathDead(memory({ id: "M-001", paths: ["src/**/*.{ts,tsx}"] }), ["src/keep/a.ts"])).toBe(false);
  });
});

describe("runSweep", () => {
  it("reports path-dead and expired memories without mutating the tree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-sweep-"));
    dirs.push(dir);
    const memDir = path.join(dir, ".memory", "memories");
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(path.join(dir, "src", "keep"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "keep", "a.ts"), "export {}\n", "utf8");

    const dead = formatMemory({
      id: "M-001",
      kind: "gotcha",
      paths: ["src/gone/**/*.ts"],
      evidence: {},
      author: "alice",
      created: "2026-01-01",
      review_after: "2027-01-01",
      status: "active",
    }, "Dead path lesson.");
    const expired = formatMemory({
      id: "M-002",
      kind: "gotcha",
      paths: ["src/keep/**/*.ts"],
      evidence: {},
      author: "alice",
      created: "2026-01-01",
      review_after: "2026-02-01",
      status: "active",
    }, "Expired but path still live.");
    await fs.writeFile(path.join(memDir, "M-001-dead.md"), dead, "utf8");
    await fs.writeFile(path.join(memDir, "M-002-old.md"), expired, "utf8");

    const report = await runSweep({ projectDir: dir, today: "2026-10-10" });
    expect(report.path_dead.map((item) => item.id)).toEqual(["M-001"]);
    expect(report.expired.map((item) => item.id)).toEqual(["M-002"]);
    expect(report.written).toEqual([]);
    await expect(fs.access(path.join(memDir, "M-001-dead.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, ".memory", "SWEEP.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(memDir, "M-002-old.md"), "utf8")).resolves.toContain("status: active");
    expect(formatSweepReport(report)).toContain("Path-dead: 1");
    expect(formatSweepReport(report)).toContain("[ ] **M-002**");
  });

  it("does not treat brace globs as path-dead when a tracked file matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-sweep-brace-"));
    dirs.push(dir);
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await fs.mkdir(path.join(dir, "src", "keep"), { recursive: true });
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "keep", "a.ts"), "export {}\n", "utf8");
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-010.md"), formatMemory({
      id: "M-010",
      kind: "gotcha",
      paths: ["src/**/*.{ts,js}"],
      evidence: {},
      author: "alice",
      created: "2026-01-01",
      review_after: "2027-01-01",
      status: "active",
    }, "Brace glob lesson."), "utf8");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-m", "seed"], { cwd: dir });

    const report = await runSweep({ projectDir: dir, today: "2026-10-10" });
    expect(report.path_dead).toEqual([]);
  });

  it("ignores untracked and gitignored files when deciding path-dead", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-sweep-git-"));
    dirs.push(dir);
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await fs.mkdir(path.join(dir, "src", "keep"), { recursive: true });
    await fs.mkdir(path.join(dir, "build"), { recursive: true });
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "keep", "a.ts"), "export {}\n", "utf8");
    await fs.writeFile(path.join(dir, ".gitignore"), "build/\n", "utf8");
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-011.md"), formatMemory({
      id: "M-011",
      kind: "gotcha",
      paths: ["build/**/*.js"],
      evidence: {},
      author: "alice",
      created: "2026-01-01",
      review_after: "2027-01-01",
      status: "active",
    }, "Only matches ignored build output."), "utf8");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-m", "seed"], { cwd: dir });
    await fs.writeFile(path.join(dir, "build", "out.js"), "ignored\n", "utf8");
    await fs.writeFile(path.join(dir, "src", "keep", "untracked.ts"), "not committed\n", "utf8");

    const files = await listRepoFiles(dir);
    expect(files).not.toContain("build/out.js");
    expect(files).not.toContain("src/keep/untracked.ts");
    expect(files).toContain("src/keep/a.ts");

    const report = await runSweep({ projectDir: dir, today: "2026-10-10" });
    expect(report.path_dead.map((item) => item.id)).toEqual(["M-011"]);
  });

  it("applies retire + SWEEP.md only when opening a PR", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-sweep-apply-"));
    dirs.push(dir);
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    const memDir = path.join(dir, ".memory", "memories");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "M-001-dead.md"), formatMemory({
      id: "M-001",
      kind: "gotcha",
      paths: ["src/gone/**/*.ts"],
      evidence: {},
      author: "alice",
      created: "2026-01-01",
      review_after: "2027-01-01",
      status: "active",
    }, "Dead path lesson."), "utf8");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-m", "seed"], { cwd: dir });

    const report = await runSweep({ projectDir: dir, openPr: true, today: "2026-10-10" });
    expect(report.path_dead.map((item) => item.id)).toEqual(["M-001"]);
    expect(report.written.some((file) => file.includes("retired"))).toBe(true);
    await expect(fs.access(path.join(memDir, "M-001-dead.md"))).resolves.toBeUndefined();
    const { stdout: retired } = await exec("git", ["show", "teamrecall/sweep:.memory/retired/M-001-dead.md"], { cwd: dir });
    expect(retired).toContain("status: retired");
    const { stdout: sweepMd } = await exec("git", ["show", "teamrecall/sweep:.memory/SWEEP.md"], { cwd: dir });
    expect(sweepMd).toContain("Propose retirement");
  }, 15_000);


  it("refuses sweep --pr when managed paths are dirty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-sweep-pr-"));
    dirs.push(dir);
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", "wip.md"), "dirty\n", "utf8");
    await expect(runSweep({ projectDir: dir, openPr: true })).rejects.toThrow(/uncommitted changes/);
  });
});
