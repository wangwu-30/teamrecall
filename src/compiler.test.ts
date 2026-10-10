import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS_INDEX_MAX_LINES, CLAUDE_INDEX_IMPORT, TEAMRECALL_END, TEAMRECALL_START } from "./constants.js";
import { compileMemories, generateAgentsMdBlock, writeCompiledFiles } from "./compiler.js";
import type { Memory } from "./types.js";

function memory(partial: Partial<Memory["frontmatter"]> & { id: string; body?: string; status?: Memory["frontmatter"]["status"] }): Memory {
  return {
    frontmatter: {
      id: partial.id,
      kind: partial.kind ?? "gotcha",
      paths: partial.paths ?? ["src/**/*.ts"],
      evidence: partial.evidence ?? { pr: "#42" },
      author: partial.author ?? "alice",
      created: partial.created ?? "2026-10-10",
      review_after: partial.review_after ?? "2027-01-08",
      status: partial.status ?? "active",
    },
    body: partial.body ?? "Use retries only in the gateway wrapper.",
    filepath: `/tmp/.memory/memories/${partial.id}.md`,
  };
}

describe("compileMemories", () => {
  it("generates empty output for no memories", async () => {
    const compiled = await compileMemories("/tmp", []);
    expect(compiled.index_md).toContain("# Team Memory Index");
    expect(compiled.agents_md).toContain("No active team memories");
    expect(compiled.claude_rules.size).toBe(0);
    expect(compiled.cursor_rules.size).toBe(0);
  });

  it("compiles active memories only", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({ id: "M-001" }),
      memory({ id: "M-002", status: "retired", body: "Old decision (retired)." }),
    ]);
    expect(compiled.agents_md).toContain("M-001");
    expect(compiled.agents_md).not.toContain("M-002");
    expect(compiled.claude_rules.size).toBe(1);
    expect(compiled.cursor_rules.size).toBe(1);
  });

  it("generates Claude rules with YAML list paths (official docs)", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({
        id: "M-001",
        paths: ["src/**/*.ts", "lib/**/*.ts"],
        body: "# Retry Logic\n\nUse retries only in the gateway wrapper.",
      }),
    ]);
    const claudeRule = compiled.claude_rules.get("M-001.md");
    expect(claudeRule).toContain("paths:");
    expect(claudeRule).toContain('- "src/**/*.ts"');
    expect(claudeRule).toContain('- "lib/**/*.ts"');
    expect(claudeRule).toContain("# M-001: Retry Logic");
  });

  it("generates Cursor rules with comma-separated globs and alwaysApply", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({ id: "M-001", paths: ["src/**/*.ts", "lib/**/*.ts"] }),
    ]);
    const cursorRule = compiled.cursor_rules.get("teamrecall-M-001.mdc");
    expect(cursorRule).toContain("globs: src/**/*.ts, lib/**/*.ts");
    expect(cursorRule).toContain("alwaysApply: false");
    expect(cursorRule).toContain('description: "M-001:');
  });

  it("keeps the AGENTS.md index at or under 40 lines", async () => {
    const memories = Array.from({ length: 40 }, (_, index) =>
      memory({ id: `M-${String(index + 1).padStart(3, "0")}`, body: `Lesson ${index + 1}` }),
    );
    const block = generateAgentsMdBlock(memories);
    expect(block.split("\n").length).toBeLessThanOrEqual(AGENTS_INDEX_MAX_LINES);
    expect(block).toContain("more");
  });
});

describe("writeCompiledFiles", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("writes only managed files and is idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-compile-"));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Project\n", "utf8");
    const compiled = await compileMemories(dir, [memory({ id: "M-001" })]);
    const first = await writeCompiledFiles(dir, compiled);
    const second = await writeCompiledFiles(dir, compiled);

    expect(first.some((file) => file.endsWith("AGENTS.md"))).toBe(true);
    expect(first.some((file) => file.endsWith(path.join(".memory", "INDEX.md")))).toBe(true);
    expect(first.some((file) => file.includes(path.join(".claude", "rules", "teamrecall")))).toBe(true);
    expect(first.some((file) => file.includes(path.join(".cursor", "rules")))).toBe(true);
    expect(first.every((file) =>
      file.startsWith(dir) &&
      /AGENTS\.md$|INDEX\.md$|CLAUDE\.md$|\.claude\/rules\/teamrecall\/|\.cursor\/rules\/teamrecall-/.test(file),
    )).toBe(true);

    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain(TEAMRECALL_START);
    expect(agents).toContain(TEAMRECALL_END);
    expect(await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain(CLAUDE_INDEX_IMPORT);
    expect(second.filter((file) => file.endsWith("CLAUDE.md"))).toHaveLength(0);
  });
});
