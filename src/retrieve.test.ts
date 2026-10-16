import { describe, expect, it } from "vitest";
import type { Memory } from "./types.js";
import {
  addedLinesFromDiff,
  distinctiveTerms,
  formatRetrieveText,
  isTrustedPathSource,
  matchContains,
  pathMatches,
  runRetrieve,
  tokenize,
  triggerMatches,
  bm25Scores,
} from "./retrieve.js";

function memory(partial: {
  id: string;
  body: string;
  paths?: string[];
  paths_source?: Memory["frontmatter"]["paths_source"];
  scope?: "always" | "triggered";
  triggers?: Memory["frontmatter"]["triggers"];
}): Memory {
  return {
    frontmatter: {
      id: partial.id,
      kind: "convention",
      paths: partial.paths ?? ["src/**/*.ts"],
      paths_source: partial.paths_source ?? "distiller",
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
  it("emits CJK unigrams and overlapping bigrams", () => {
    expect(tokenize("审批流程")).toEqual(["审", "批", "流", "程", "审批", "批流", "流程"]);
    expect(tokenize("审")).toEqual(["审"]);
    expect(tokenize("㐀㐁 あいう カタカナ 한국어")).toEqual([
      "㐀", "㐁", "㐀㐁", "あ", "い", "う", "あい", "いう",
      "カ", "タ", "カ", "ナ", "カタ", "タカ", "カナ",
      "한", "국", "어", "한국", "국어",
    ]);
  });

  it("does not form bigrams across punctuation, whitespace, or ASCII", () => {
    expect(tokenize("审，批。流 程・カ、ナ！한/국")).toEqual([
      "审", "批", "流", "程", "カ", "ナ", "한", "국",
    ]);
    expect(tokenize("审批retryGuard流程")).toEqual([
      "retry", "guard", "审", "批", "审批", "流", "程", "流程",
    ]);
  });

  it("preserves the original ASCII tokens including stop words and identifiers", () => {
    expect(tokenize("the HTTPServer retryGuard snake_case src/foo.test.ts A x 1 12 using v2")).toEqual([
      "http", "server", "retry", "guard", "snake", "case", "src", "foo", "test", "ts", "12", "v2",
    ]);
    expect(tokenize(" \n，。！？")).toEqual([]);
  });

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
  it.each(["审批", "审", "批", "审批retryGuard", "한국", "국", "カタ", "タ", "㐀"])(
    "retrieves continuous CJK text for %s without path boosts or ID ties",
    async (query) => {
      const result = await runRetrieve({
        memories: [
          memory({ id: "M-001", body: "unrelated content", paths: [], scope: "triggered" }),
          memory({ id: "M-900", body: "审批流程 retryGuard 한국어 カタカナ 㐀㐁", paths: [], scope: "triggered" }),
        ],
        files: [], title: query, k: 1,
      });
      expect(result.matched[0]?.id).toBe("M-900");
      expect(result.matched[0]?.score).toBeGreaterThan(0);
      expect(result.matched[0]?.reason).toBe("bm25");
    },
  );

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
    expect(result.matched[0]?.id).toBe("M-001");
    expect(result.matched[0]?.reason).toBe("glob");
    expect(result.always_cap).toBe(8);
    expect(formatRetrieveText(result)).toMatch(/Always:[\s\S]*M-002/);
    expect(formatRetrieveText(result)).toMatch(/Retrieved:[\s\S]*M-001/);
  });

  it("ranks unmatched memories instead of hard-filtering them out", async () => {
    const result = await runRetrieve({
      memories: [changeset, unrelated],
      files: ["docs/readme.md"],
      title: "mdtest reveal_type fixture",
      k: 5,
    });
    expect(result.matched.map((item) => item.id)).toEqual(expect.arrayContaining(["M-001", "M-003"]));
    expect(result.matched.find((item) => item.id === "M-003")?.reason).toBe("bm25");
  });

  it("caps the always set and still returns top-k triggered", async () => {
    const alwaysMany = Array.from({ length: 10 }, (_, index) => memory({
      id: `M-${String(index + 10).padStart(3, "0")}`,
      scope: "always",
      paths: ["**/*"],
      body: `Always rule ${index} about PR description length.`,
    }));
    const result = await runRetrieve({
      memories: [...alwaysMany, changeset],
      files: [".changeset/a.md"],
      k: 1,
      alwaysCap: 8,
    });
    expect(result.always).toHaveLength(8);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.id).toBe("M-001");
    expect(result.memories).toHaveLength(9);
  });

  it("caps triggered retrieval at 10 even when k is larger", async () => {
    const many = Array.from({ length: 15 }, (_, index) => memory({
      id: `M-${String(index + 20).padStart(3, "0")}`,
      scope: "triggered",
      paths: ["src/**"],
      body: `Triggered rule ${index} about gateway retries in the wrapper.`,
    }));
    const result = await runRetrieve({
      memories: [...many, processRule],
      files: ["src/gateway.ts"],
      k: 20,
    });
    expect(result.k).toBe(10);
    expect(result.matched.length).toBeLessThanOrEqual(10);
    expect(result.always.length).toBeLessThanOrEqual(8);
    expect(result.memories.length).toBeLessThanOrEqual(18);
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

describe("trigger / contains / tokens / pr signals", () => {
  it("requires glob AND contains (does not ignore glob)", () => {
    expect(triggerMatches(
      { glob: ".changeset/*.md", contains: "console" },
      { files: ["src/a.ts"], diff: "+console.log(1)" },
    )).toBe(false);
    expect(triggerMatches(
      { glob: ".changeset/*.md", contains: "console" },
      { files: [".changeset/a.md"], diff: "+console.log(1)" },
    )).toBe(true);
  });

  it("treats contains as a literal substring and never runs regex", () => {
    expect(matchContains("a+b", "a+b")).toBe(true);
    expect(matchContains("foo(", "foo(bar")).toBe(true);
    expect(matchContains("/(a+)+$/", `${"a".repeat(28)}!`)).toBe(false);
    const started = Date.now();
    matchContains("/(a+)+$/", `${"a".repeat(28)}!`);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("saturates BM25 query frequency so a repeated term cannot swamp path rank", () => {
    const score = bm25Scores(Array(300).fill("mdtest"), [["mdtest"], ["other"]])[0];
    expect(score).toBeLessThan(2);
  });

  it("ranks path matches above high BM25 non-matches", async () => {
    const pathHit = memory({
      id: "M-001",
      scope: "triggered",
      paths: [".changeset/*.md"],
      paths_source: "distiller",
      body: "Every user-facing change needs a changeset file under .changeset.",
    });
    const noisy = memory({
      id: "M-009",
      scope: "triggered",
      paths: ["docs/**"],
      body: `${"formatter ".repeat(80)}unrelated docs note`,
    });
    const result = await runRetrieve({
      memories: [pathHit, noisy],
      files: [".changeset/a.md"],
      title: "formatter formatter formatter",
      body: "formatter ".repeat(40),
      k: 2,
    });
    expect(result.matched[0]?.id).toBe("M-001");
    expect(result.matched[0]?.reason).toBe("glob");
  });

  it("sorts by (tier, bm25) so a zero-BM25 path hit beats a max-BM25 non-hit", async () => {
    const pathHit = memory({
      id: "M-002",
      scope: "triggered",
      paths: ["src/auth/**"],
      paths_source: "distiller",
      body: "Keep auth cookies httpOnly.",
    });
    const bm25Only = memory({
      id: "M-001",
      scope: "triggered",
      paths: ["docs/**"],
      body: `${"formatter ".repeat(80)}unrelated docs note`,
    });
    const result = await runRetrieve({
      memories: [bm25Only, pathHit],
      files: ["src/auth/login.ts"],
      title: "formatter formatter formatter",
      body: "formatter ".repeat(40),
      k: 2,
    });
    expect(result.matched.map((item) => item.id)).toEqual(["M-002", "M-001"]);
    expect(result.matched[0]?.reason).toBe("glob");
    expect(result.matched[0]!.score).toBeGreaterThan(result.matched[1]!.score);
  });

  it("does not hard-tier inferred paths; fills remaining slots with BM25", async () => {
    const inferred = memory({
      id: "M-010",
      scope: "triggered",
      paths: ["src/**"],
      paths_source: "inferred",
      body: "A leftover note about retries in the gateway wrapper.",
    });
    const semantic = memory({
      id: "M-011",
      scope: "triggered",
      paths: ["docs/**"],
      paths_source: "inferred",
      body: `${"formatter ".repeat(40)}docs note`,
    });
    const extra = Array.from({ length: 3 }, (_, index) => memory({
      id: `M-02${index}`,
      scope: "triggered",
      paths: ["docs/**"],
      paths_source: "inferred",
      body: `Unrelated note ${index} about logging`,
    }));
    const result = await runRetrieve({
      memories: [inferred, semantic, ...extra],
      files: ["src/a.ts"],
      title: "formatter formatter formatter",
      body: "formatter ".repeat(20),
      k: 5,
    });
    expect(result.matched).toHaveLength(5);
    expect(result.matched.find((item) => item.id === "M-010")?.reason).toBe("bm25");
    expect(result.matched[0]?.id).toBe("M-011");
    expect(result.matched.map((item) => item.id)).toContain("M-010");
  });

  it("treats missing paths_source as trusted so legacy memories keep the hard tier", async () => {
    expect(isTrustedPathSource(undefined)).toBe(true);
    expect(isTrustedPathSource("human")).toBe(true);
    expect(isTrustedPathSource("distiller")).toBe(true);
    expect(isTrustedPathSource("inferred")).toBe(false);

    const legacy = memory({
      id: "M-001",
      scope: "triggered",
      paths: [".changeset/*.md"],
      body: "Every user-facing change needs a changeset file under .changeset.",
    });
    delete legacy.frontmatter.paths_source;
    const noisy = memory({
      id: "M-009",
      scope: "triggered",
      paths: ["docs/**"],
      body: `${"formatter ".repeat(80)}unrelated docs note`,
    });
    const result = await runRetrieve({
      memories: [legacy, noisy],
      files: [".changeset/a.md"],
      title: "formatter formatter formatter",
      body: "formatter ".repeat(40),
      k: 2,
    });
    expect(result.matched[0]?.id).toBe("M-001");
    expect(result.matched[0]?.reason).toBe("glob");
  });

  it("does not treat empty or ** paths as a path match", () => {
    expect(pathMatches(memory({ id: "M-008", body: "x", paths: [] }), ["anything/x.rs"])).toBe(false);
    expect(pathMatches(memory({ id: "M-008", body: "x", paths: ["**/*"] }), ["anything/x.rs"])).toBe(false);
  });

  it("tokenizes dotted path terms the same way as queries", () => {
    const terms = distinctiveTerms({
      frontmatter: {
        id: "M-001",
        kind: "convention",
        paths: ["crates/ruff_linter/resources/mdtest/*.md", "src/foo.test.ts"],
        evidence: {},
        author: "a",
        created: "2026-10-10",
        review_after: "2027-01-08",
        status: "active",
      },
      body: "x",
      filepath: "/tmp/x.md",
    });
    const query = tokenize("src/foo.test.ts");
    expect(query).toEqual(expect.arrayContaining(["foo"]));
    expect(terms).toEqual(expect.arrayContaining(["foo", "mdtest"]));
    expect(terms.some((token) => token.includes("."))).toBe(false);
  });

  it("does not match a files: regex against a synthetic files:N blob", () => {
    expect(triggerMatches(
      { glob: "**", pr: "files:[0-9]{2,}" },
      { files: Array(12).fill("x"), title: "t" },
    )).toBe(false);
    expect(triggerMatches(
      { glob: "**", pr: "files:>=10" },
      { files: Array(12).fill("x"), title: "t" },
    )).toBe(true);
    expect(triggerMatches(
      { glob: "**", pr: "title:changeset" },
      { files: ["src/a.ts"], title: "add changeset" },
    )).toBe(true);
  });
});
