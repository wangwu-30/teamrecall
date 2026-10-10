import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRuleLessons } from "./backfill.js";
import { runDoctor } from "./doctor.js";
import { initProject } from "./init.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-init-"));
  dirs.push(dir);
  return dir;
}

describe("initProject", () => {
  it("scaffolds memory dirs, config, workflow, and compiled AGENTS.md", async () => {
    const dir = await tmp();
    const result = await initProject(dir, { backfill: false, openPr: false });
    expect(result.created.some((file) => file.endsWith(path.join(".memory", "config.yml")))).toBe(true);
    await expect(fs.stat(path.join(dir, ".memory", "memories"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(dir, ".memory", "retired"))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(dir, ".github", "workflows", "teamrecall.yml"), "utf8")).resolves.toContain("teamrecall");
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).resolves.toContain("teamrecall:start");
  });

  it("refuses to re-init", async () => {
    const dir = await tmp();
    await initProject(dir, { backfill: false, openPr: false });
    await expect(initProject(dir)).rejects.toThrow("already exists");
  });

  it("backfills conventions from CLAUDE.md", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      "## Retries\n\nNever retry in the service layer; register retries only in the gateway wrapper so callers see one policy.\n",
      "utf8",
    );
    const result = await initProject(dir, { backfill: true, openPr: false });
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    expect(files.length).toBeGreaterThan(0);
    expect(result.created.some((file) => file.includes(".memory/memories"))).toBe(true);
    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@.memory/INDEX.md");
  });
});

describe("extractRuleLessons", () => {
  it("turns headings into convention memories", () => {
    const lessons = extractRuleLessons(
      "## Auth\n\nNever store session tokens in localStorage; keep them in httpOnly cookies instead.\n",
      "CLAUDE.md",
    );
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0].action).toBe("new");
    expect(lessons[0].kind).toBe("convention");
    expect(lessons[0].body).toMatch(/httpOnly/i);
  });
});

describe("runDoctor", () => {
  it("fails before init and passes after", async () => {
    const dir = await tmp();
    const before = await runDoctor(dir);
    expect(before.ok).toBe(false);
    expect(before.checks.some((check) => check.name === "memory_directory" && !check.ok)).toBe(true);

    await initProject(dir, { backfill: false, openPr: false });
    const after = await runDoctor(dir);
    expect(after.checks.find((check) => check.name === "memory_directory")?.ok).toBe(true);
    expect(after.checks.find((check) => check.name === "memories_directory")?.ok).toBe(true);
  });
});
