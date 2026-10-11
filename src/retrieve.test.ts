import { describe, expect, it } from "vitest";
import type { Memory } from "./types.js";
import { addedLinesFromDiff, formatRetrieveText, runRetrieve, tokenize } from "./retrieve.js";

function memory(partial: {
  id: string;
  body: string;
  paths?: string[];
  scope?: "always" | "triggered";
  triggers?: Memory["frontmatter"]["triggers"];
}): Memory {
  return {
    frontmatter: {
      id: partial.id,
      kind: "convention",
      paths: partial.paths ?? ["src/**/*.ts"],
      scope: partial.scope,
      triggers: partial.triggers,
      evidence: { pr: "#1" },
      author: "alice",
      created: "2026-10-10",
      review_after: "2027-01-08",
      status: "active",
    },
    body: partial.body,
    filepath: `/tmp/.memory/memories/${partial.id}.md`,
  };
}

describe("tokenize / diff", () => {
  it("splits camelCase and snake_case", () => {
    expect(tokenize("reveal_type in mdtestFile")).toEqual(
      expect.arrayContaining(["reveal", "type", "mdtest", "file"]),
    );
  });

  it("collects added diff lines", () => {
    expect(addedLinesFromDiff("+++ b/a\n+hello\n-old\n context")).toEqual(["hello"]);
  });
});

describe("runRetrieve", () => {
  const changeset = memory({
    id: "M-001",
    scope: "triggered",
    paths: [".changeset/*.md"],
    triggers: [{ glob: ".changeset/*.md" }],
    body: "Every user-facing change needs a changeset file under .changeset.",
  });
  const processRule = memory({
    id: "M-002",
    scope: "always",
    paths: ["**/*"],
    body: "Keep review comments short. Do not paste a whole function into a PR comment.",
  });
  const unrelated = memory({
    id: "M-003",
    scope: "triggered",
    paths: ["crates/ruff_linter/**/*.rs"],
    body: "New ruff lint rules need an mdtest fixture that calls reveal_type.",
  });

  it("retrieves a changeset memory for a .changeset/*.md change and always includes path-independent memories", async () => {
    const result = await runRetrieve({
      memories: [changeset, processRule, unrelated],
      files: [".changeset/loose-hats-cough.md"],
      title: "Fix formatter",
      body: "User-facing CLI change",
      k: 5,
    });
    const ids = result.memories.map((item) => item.id);
    expect(ids).toContain("M-001");
    expect(ids).toContain("M-002");
    expect(result.always.map((item) => item.id)).toEqual(["M-002"]);
    expect(result.matched.map((item) => item.id)).toContain("M-001");
    expect(result.matched.map((item) => item.id)).not.toContain("M-003");
    expect(formatRetrieveText(result)).toMatch(/Always:[\s\S]*M-002/);
    expect(formatRetrieveText(result)).toMatch(/Retrieved:[\s\S]*M-001/);
  });

  it("keeps always memories even when BM25 would not rank them", async () => {
    const result = await runRetrieve({
      memories: [processRule, unrelated],
      files: ["crates/ruff_linter/src/lib.rs"],
      diff: "+fn reveal_type() {}",
      k: 1,
    });
    expect(result.always.map((item) => item.id)).toEqual(["M-002"]);
    expect(result.matched[0]?.id).toBe("M-003");
  });
});
