import { describe, expect, it } from "vitest";
import { compileMemories } from "./compiler.js";
import type { Memory } from "./types.js";

describe("compileMemories", () => {
  it("generates empty output for no memories", async () => {
    const compiled = await compileMemories("/tmp", []);
    expect(compiled.index_md).toContain("# Team Memory Index");
    expect(compiled.agents_md).toContain("No active team memories");
    expect(compiled.claude_rules.size).toBe(0);
    expect(compiled.cursor_rules.size).toBe(0);
  });

  it("compiles active memories only", async () => {
    const memories: Memory[] = [
      {
        frontmatter: {
          id: "M-001",
          kind: "gotcha",
          paths: ["src/**/*.ts"],
          evidence: { pr: "#42" },
          author: "alice",
          created: "2026-10-10",
          review_after: "2027-01-08",
          status: "active",
        },
        body: "Use retries only in the gateway wrapper.",
        filepath: "/tmp/.memory/memories/M-001.md",
      },
      {
        frontmatter: {
          id: "M-002",
          kind: "decision",
          paths: ["**/*"],
          evidence: { pr: "#50" },
          author: "bob",
          created: "2026-10-11",
          review_after: "2027-01-09",
          status: "retired",
        },
        body: "Old decision (retired).",
        filepath: "/tmp/.memory/retired/M-002.md",
      },
    ];

    const compiled = await compileMemories("/tmp", memories);
    expect(compiled.agents_md).toContain("M-001");
    expect(compiled.agents_md).not.toContain("M-002");
    expect(compiled.claude_rules.size).toBe(1);
    expect(compiled.cursor_rules.size).toBe(1);
  });

  it("generates Claude rules with paths frontmatter", async () => {
    const memories: Memory[] = [
      {
        frontmatter: {
          id: "M-001",
          kind: "gotcha",
          paths: ["src/**/*.ts", "lib/**/*.ts"],
          evidence: { pr: "#42" },
          author: "alice",
          created: "2026-10-10",
          review_after: "2027-01-08",
          status: "active",
        },
        body: "# Retry Logic\n\nUse retries only in the gateway wrapper.",
        filepath: "/tmp/.memory/memories/M-001.md",
      },
    ];

    const compiled = await compileMemories("/tmp", memories);
    const claudeRule = compiled.claude_rules.get("M-001.md");
    expect(claudeRule).toBeTruthy();
    expect(claudeRule).toContain('paths: ["src/**/*.ts","lib/**/*.ts"]');
    expect(claudeRule).toContain("# M-001: Retry Logic");
  });

  it("generates Cursor rules with globs frontmatter", async () => {
    const memories: Memory[] = [
      {
        frontmatter: {
          id: "M-001",
          kind: "gotcha",
          paths: ["src/**/*.ts"],
          evidence: { pr: "#42" },
          author: "alice",
          created: "2026-10-10",
          review_after: "2027-01-08",
          status: "active",
        },
        body: "Use retries only in the gateway wrapper.",
        filepath: "/tmp/.memory/memories/M-001.md",
      },
    ];

    const compiled = await compileMemories("/tmp", memories);
    const cursorRule = compiled.cursor_rules.get("teamrecall-M-001.mdc");
    expect(cursorRule).toBeTruthy();
    expect(cursorRule).toContain('globs: ["src/**/*.ts"]');
  });
});
