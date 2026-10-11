import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { backfillProject } from "./backfill.js";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { loadMemories } from "./memory.js";
import type { CompiledOutput } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "testdata", "v02-golden");
const SNAPSHOT_COMPILE = path.join(FIXTURE, "compile.snapshot.txt");
const SNAPSHOT_BACKFILL = path.join(FIXTURE, "backfill.snapshot.txt");

export function serializeCompiled(compiled: CompiledOutput): string {
  const sections = [
    "=== agents.md ===",
    compiled.agents_md,
    "=== index.md ===",
    compiled.index_md,
  ];
  for (const [name, content] of [...compiled.claude_rules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sections.push(`=== claude/${name} ===`, content);
  }
  for (const [name, content] of [...compiled.cursor_rules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sections.push(`=== cursor/${name} ===`, content);
  }
  return `${sections.join("\n").replace(/\n+$/, "")}\n`;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("v0.2 golden compile output", () => {
  it("byte-matches the checked-in snapshot for v0.2-style memories", async () => {
    const memories = await loadMemories(path.join(FIXTURE, "input"));
    expect(memories.map((memory) => memory.frontmatter.id)).toEqual(["M-001", "M-002", "M-003"]);
    expect(memories.every((memory) => memory.frontmatter.scope === undefined)).toBe(true);
    expect(memories[2]?.frontmatter.paths).toEqual([]);

    const compiled = await compileMemories(path.join(FIXTURE, "input"), memories);
    const expected = await fs.readFile(SNAPSHOT_COMPILE, "utf8");
    expect(serializeCompiled(compiled)).toBe(expected);
  });

  it("byte-matches the checked-in snapshot for v0.2-style backfill compile output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-v02-backfill-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      await fs.readFile(path.join(FIXTURE, "input", "CLAUDE.md"), "utf8"),
      "utf8",
    );

    const result = await backfillProject(dir, { fetchPrs: false });
    expect(result.from_rules).toBe(1);
    const memories = await loadMemories(dir);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.frontmatter.paths).toEqual(["**/*"]);
    expect(memories[0]?.frontmatter.scope).toBeUndefined();

    const compiled = await compileMemories(dir, memories);
    const expected = await fs.readFile(SNAPSHOT_BACKFILL, "utf8");
    expect(serializeCompiled(compiled)).toBe(expected);
    expect(compiled.agents_md).toContain("(**/*)");
    expect(compiled.claude_rules.get("M-001.md")).toContain('- "**/*"');
    expect(compiled.cursor_rules.get("teamrecall-M-001.mdc")).toContain("globs: **/*");
  });

  it("writes the same compiled files as the snapshot when persisted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-v02-write-"));
    dirs.push(dir);
    const inputDir = path.join(FIXTURE, "input");
    await fs.cp(path.join(inputDir, ".memory"), path.join(dir, ".memory"), { recursive: true });
    const compiled = await compileMemories(dir, await loadMemories(dir));
    await writeCompiledFiles(dir, compiled);
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("(**/*)");
    expect(await fs.readFile(path.join(dir, ".claude", "rules", "teamrecall", "M-003.md"), "utf8"))
      .toMatch(/^---\n---\n/);
    expect(await fs.readFile(path.join(dir, ".cursor", "rules", "teamrecall-M-003.mdc"), "utf8"))
      .toContain("alwaysApply: true");
  });
});
