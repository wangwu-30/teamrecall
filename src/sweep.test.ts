import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatMemory } from "./memory.js";
import { formatSweepReport, globMatches, isExpired, isPathDead, runSweep } from "./sweep.js";
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
  });
});

describe("runSweep", () => {
  it("writes a report, retires path-dead memories, and lists expired ones", async () => {
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
    await expect(fs.access(path.join(memDir, "M-001-dead.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, ".memory", "retired", "M-001-dead.md"), "utf8")).resolves.toContain("status: retired");
    await expect(fs.readFile(path.join(memDir, "M-002-old.md"), "utf8")).resolves.toContain("status: active");
    const sweepMd = await fs.readFile(path.join(dir, ".memory", "SWEEP.md"), "utf8");
    expect(sweepMd).toContain("Propose retirement");
    expect(sweepMd).toContain("[ ] **M-002**");
    expect(formatSweepReport(report)).toContain("Path-dead: 1");
  });

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
