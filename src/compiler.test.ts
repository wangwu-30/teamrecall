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
      scope: partial.scope,
      triggers: partial.triggers,
      evidence: partial.evidence ?? { pr: "#42" },
      author: partial.author ?? "alice",
      created: partial.created ?? "2026-10-10",
      review_after: partial.review_after ?? "2027-01-08",
      status: partial.status ?? "active",
      ...(partial.superseded_by ? { superseded_by: partial.superseded_by } : {}),
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
    expect(compiled.compact_index).toContain("No active team memories");
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

  it("indexes abandoned memories as do-not-reintroduce and skips superseded", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({ id: "M-001" }),
      memory({
        id: "M-002",
        status: "abandoned",
        body: "Tried storing tokens in localStorage; dropped because XSS.",
      }),
      memory({
        id: "M-003",
        status: "superseded",
        superseded_by: "M-001",
        body: "Old retry rule.",
      }),
    ]);
    expect(compiled.index_md).toContain("Do not reintroduce: Tried storing tokens in localStorage");
    expect(compiled.compact_index).toContain("Do not reintroduce: Tried storing tokens");
    expect(compiled.index_md).not.toContain("Old retry rule");
    expect(compiled.claude_rules.has("M-002.md")).toBe(false);
    expect(compiled.claude_rules.has("M-003.md")).toBe(false);
    expect(compiled.claude_rules.has("M-001.md")).toBe(true);
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

  it("compiles existing unscoped memories like v0.2 path-scoped rules", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({ id: "M-001", paths: ["src/**/*.ts", "lib/**/*.ts"] }),
    ]);
    expect(compiled.agents_md).toContain("**M-001**: Use retries only in the gateway wrapper. (src/**/*.ts, lib/**/*.ts)");
    expect(compiled.agents_md).not.toContain("[always]");
    const claudeRule = compiled.claude_rules.get("M-001.md");
    expect(claudeRule).toContain('- "src/**/*.ts"');
    expect(claudeRule).not.toContain('- "**"');
    const cursorRule = compiled.cursor_rules.get("teamrecall-M-001.mdc");
    expect(cursorRule).toContain("globs: src/**/*.ts, lib/**/*.ts");
    expect(cursorRule).toContain("alwaysApply: false");
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

  it("puts always memories in the root index as full one-liners and triggered as titles", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({
        id: "M-001",
        scope: "always",
        paths: ["**/*"],
        body: "Keep review comments short. Do not paste a whole function into a PR comment.",
      }),
      memory({
        id: "M-002",
        scope: "triggered",
        paths: [".changeset/*.md"],
        body: "Every user-facing change needs a changeset file.",
      }),
    ]);
    expect(compiled.agents_md).toContain("[always]: Keep review comments short.");
    expect(compiled.agents_md).toContain("**M-002**: Every user-facing change needs a changeset file.");
    expect(compiled.agents_md).not.toContain("[always]: Every user-facing change");
    const alwaysRule = compiled.claude_rules.get("M-001.md");
    expect(alwaysRule).toContain('- "**"');
    const triggered = compiled.claude_rules.get("M-002.md");
    expect(triggered).toContain('- ".changeset/*.md"');
    expect(compiled.cursor_rules.get("teamrecall-M-001.mdc")).toContain("alwaysApply: true");
    expect(compiled.cursor_rules.get("teamrecall-M-002.mdc")).toContain("globs: .changeset/*.md");
    expect(compiled.cursor_rules.get("teamrecall-M-002.mdc")).toContain("alwaysApply: false");
  });

  it("compiles empty-path memories as always only when scope is always", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({
        id: "M-004",
        scope: "always",
        paths: [],
        body: "Mention the change in every PR description.",
      }),
    ]);
    expect(compiled.claude_rules.get("M-004.md")).toContain('- "**"');
    expect(compiled.cursor_rules.get("teamrecall-M-004.mdc")).toContain("alwaysApply: true");
  });

  it("does not compile triggered memories with empty paths into always-loaded rule files", async () => {
    const compiled = await compileMemories("/tmp", [
      memory({
        id: "M-003",
        scope: "triggered",
        paths: [],
        body: "No evidence, so this stays an index title only.",
      }),
    ]);
    expect(compiled.agents_md).toContain("**M-003**: No evidence, so this stays an index title only.");
    expect(compiled.claude_rules.has("M-003.md")).toBe(false);
    expect(compiled.cursor_rules.has("teamrecall-M-003.mdc")).toBe(false);
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
      /AGENTS\.md$|INDEX\.md$|CLAUDE\.md$|copilot-instructions\.md$|\.claude\/rules\/teamrecall\/|\.cursor\/rules\/teamrecall-/.test(file),
    )).toBe(true);

    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain(TEAMRECALL_START);
    expect(agents).toContain(TEAMRECALL_END);
    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain(TEAMRECALL_START);
    expect(claude).toContain("**M-001**");
    expect(claude).toContain(CLAUDE_INDEX_IMPORT);
    expect(claude.startsWith("# Project")).toBe(true);
    const copilot = await fs.readFile(path.join(dir, ".github", "copilot-instructions.md"), "utf8");
    expect(copilot).toContain(TEAMRECALL_START);
    expect(copilot).toContain("**M-001**");
    expect(second.some((file) => file.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("does not rewrite user text outside the CLAUDE.md managed block", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-claude-"));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Project\n\n\n\nKeep the gaps.\n", "utf8");
    const compiled = await compileMemories(dir, [memory({ id: "M-001" })]);
    await writeCompiledFiles(dir, compiled);
    const first = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    await writeCompiledFiles(dir, compiled);
    const second = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(first).toContain("# Project\n\n\n\nKeep the gaps.");
    expect(second).toBe(first);
  });

  it("deletes stale generated rules for memories that are no longer active", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-stale-"));
    dirs.push(dir);
    await writeCompiledFiles(dir, await compileMemories(dir, [
      memory({ id: "M-001" }),
      memory({ id: "M-002" }),
    ]));
    await fs.writeFile(path.join(dir, ".cursor", "rules", "custom.mdc"), "user rule\n", "utf8");

    await writeCompiledFiles(dir, await compileMemories(dir, [memory({ id: "M-001" })]));

    await expect(fs.access(path.join(dir, ".claude", "rules", "teamrecall", "M-001.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, ".claude", "rules", "teamrecall", "M-002.md"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, ".cursor", "rules", "teamrecall-M-002.mdc"))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, ".cursor", "rules", "custom.mdc"), "utf8")).toBe("user rule\n");
  });

  it("keeps 3+ blank lines in user AGENTS.md content across two compiles", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-blanks-"));
    dirs.push(dir);
    const user = "# Guide\n\n\n\nKeep the gaps.\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), user, "utf8");
    const compiled = await compileMemories(dir, [memory({ id: "M-001" })]);
    await writeCompiledFiles(dir, compiled);
    const first = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    await writeCompiledFiles(dir, compiled);
    const second = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(first).toContain("# Guide\n\n\n\nKeep the gaps.");
    expect(second).toBe(first);
  });
});
