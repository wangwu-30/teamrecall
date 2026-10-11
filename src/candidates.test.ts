import { describe, expect, it } from "vitest";
import {
  candidatesOverlap,
  extractTerms,
  generateCandidateId,
  isPromotableQuality,
  matchCandidate,
  mergeCandidateLists,
  normalizeGist,
  pruneCandidates,
  recordCandidates,
  stripHtml,
} from "./candidates.js";
import { isEligibleReviewerComment, reviewerComments } from "./human-comments.js";
import type { ReviewCandidate } from "./types.js";

function candidate(partial: Partial<ReviewCandidate> & { gist: string }): ReviewCandidate {
  const reviewer = partial.reviewer ?? "bob";
  const pr = partial.pr ?? "#1";
  const gist = normalizeGist(partial.gist);
  return {
    id: partial.id ?? generateCandidateId(gist, pr, reviewer),
    terms: extractTerms(partial.gist),
    files: [],
    date: "2026-10-01",
    reviewer,
    pr,
    ...partial,
    gist,
  };
}

describe("normalizeGist / extractTerms", () => {
  it("strips URLs, @names, and stays at most 120 chars", () => {
    const gist = normalizeGist("Keep review comments short. See https://github.com/acme/app/pull/12 @alice.");
    expect(gist).toContain("keep review comments short");
    expect(gist).not.toContain("https");
    expect(gist).not.toContain("alice");
    expect(gist.length).toBeLessThanOrEqual(120);
    const html = normalizeGist('Keep cookies httpOnly. <img src="https://x.test/a.png" alt="x"> <b>never</b> store them.');
    expect(html).toContain("keep cookies httponly");
    expect(html).not.toContain("img");
    expect(html).not.toContain("https");
    expect(html).toContain("never store");
    expect(extractTerms("See https://github.com/acme/app/pull/12")).not.toEqual(
      expect.arrayContaining(["https", "github", "com", "pull"]),
    );
  });

  it("keeps suggestion-block and inline-code contents in the gist", () => {
    const suggestionOnly = normalizeGist("```suggestion\nuse Box<T>\n```");
    expect(suggestionOnly).not.toBe("");
    expect(suggestionOnly).toContain("box<t>");
    expect(suggestionOnly).toContain("suggestion");

    const suggestionIdent = normalizeGist("```suggestion\nawait onTestFinished()\n```");
    expect(suggestionIdent).toContain("ontestfinished");

    const fencedTilde = normalizeGist("~~~suggestion\nexpectTypeOf(value).toEqualTypeOf<string>()\n~~~");
    expect(fencedTilde).toContain("expecttypeof");
    expect(fencedTilde).toContain("toequaltypeof<string>");

    const inline = normalizeGist("Always call `onTestFinished` before cleanup.");
    expect(inline).toContain("ontestfinished");
    expect(inline).not.toMatch(/^always call before cleanup/);
  });
});

describe("code spans survive HTML stripping", () => {
  it("keeps generics and JSX-like tags inside inline code and suggestion blocks", () => {
    expect(normalizeGist("Use `Required<BenchmarkUserOptions>` for the resolved config.")).toContain("required<benchmarkuseroptions>");
    expect(normalizeGist("Prefer `new Set<WeakRef<Mock>>` here.")).toContain("set<weakref<mock>>");
    const doc = normalizeGist("```suggestion\n## test.sequential <Deprecated /> {#test-sequential}\n```");
    expect(doc).toContain("deprecated");
    const ver = normalizeGist("```suggestion\n### vi.when <Version>5.0.0</Version>\n```");
    expect(ver).toContain("version");
  });

  it("does not let an unclosed generic in code swallow the following prose", () => {
    const gist = normalizeGist("Type it as `Pick<Thresholds, 'lines'` then mention => the per-file thresholds option.");
    expect(gist).toContain("thresholds");
    expect(gist).toContain("per-file");
  });

  it("still strips real HTML and images in prose, and mentions/URLs outside code", () => {
    const gist = normalizeGist("<details><summary>Logs</summary>use `Set<WeakRef<Mock>>` @alice <img src=\"x.png\"> https://x.dev/a</details>");
    expect(gist).not.toMatch(/details|summary|img|alice|x\.dev/);
    expect(gist).toContain("set<weakref<mock>>");
  });

  it("keeps @-paths inside code and extracts terms from generic arguments", () => {
    expect(normalizeGist("served from `/@fs/<abs-path>`")).toContain("fs/<abs-path>");
    expect(extractTerms("Use `Pick<Thresholds, 'lines'>` for perFile.")).toEqual(expect.arrayContaining(["thresholds", "lines"]));
    expect(stripHtml("a `<T>` b <b>bold</b>")).toBe("a `<T>` b  bold ");
  });
});

describe("candidatesOverlap", () => {
  it("does not match on top-level packages/ or two generic terms", () => {
    const first = {
      gist: normalizeGist("Please add a changelog entry for this public API."),
      terms: extractTerms("Please add a changelog entry for this public API."),
      files: ["packages/vitest/src/node/cli.ts"],
    };
    const second = {
      gist: normalizeGist("Please export the helper from the package index."),
      terms: extractTerms("Please export the helper from the package index."),
      files: ["packages/browser/src/client.ts"],
    };
    expect(candidatesOverlap(first, second).match).toBe(false);
  });

  it("matches only with the same package floor or same file and 3 distinctive terms", () => {
    const first = {
      gist: normalizeGist("Register retries only in the gateway wrapper."),
      terms: extractTerms("Register retries only in the gateway wrapper so callers see one policy."),
      files: ["src/gateway/retry.ts"],
    };
    const second = {
      gist: normalizeGist("Register retries only in the gateway wrapper, never in services."),
      terms: extractTerms("Register retries only in the gateway wrapper never in the service layer."),
      files: ["src/gateway/client.ts"],
    };
    expect(candidatesOverlap(first, second, [first, second]).match).toBe(true);
  });
});

describe("reviewer filters", () => {
  it("drops author replies, URL-only, thanks, closing, short, and author AI-disclosures", () => {
    const comments = reviewerComments([
      { body: "Keep review comments short. Do not paste a whole function into a PR comment.", author: "bob" },
      { body: "This looks AI-generated; please write the tests by hand.", author: "bob" },
      { body: "I'll fix this in a follow-up.", author: "alice" },
      { body: "https://github.com/acme/app/pull/12", author: "carol" },
      { body: "Thanks!", author: "dave" },
      { body: "Closing this for now.", author: "erin" },
      { body: "Closing as stale.", author: "erin" },
      { body: "Closing in favor of #9.", author: "erin" },
      { body: "Superseded by the rewrite.", author: "erin" },
      { body: "Can you resolve conflicts?", author: "erin" },
      { body: "Looks good here.", author: "erin" },
      { body: "I'm a real person and used ChatGPT to write this.", author: "alice" },
      { body: "Please use httpOnly cookies.", author: "bob", in_reply_to: 99 },
    ], "alice");
    expect(comments.map((item) => item.body)).toEqual([
      "Keep review comments short. Do not paste a whole function into a PR comment.",
      "This looks AI-generated; please write the tests by hand.",
    ]);
    expect(isEligibleReviewerComment({ body: "https://example.com/a", author: "bob" }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({
      body: "https://github.com/astral-sh/ruff/blob/main/crates/ruff_linter/src/rules/foo.rs",
      author: "bob",
    }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({
      body: "```suggestion\nuse Box<T>\n```",
      author: "bob",
    }, "alice")).toBe(true);
    expect(isEligibleReviewerComment({
      body: "```suggestion\n\n```",
      author: "bob",
    }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({
      body: "```suggestion\n   \n```",
      author: "bob",
    }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({
      body: "use Box<T>\n```suggestion\nuse Box<T>\n```",
      author: "bob",
    }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({
      body: "Please delete this unused helper function.\n```suggestion\n\n```",
      author: "bob",
    }, "alice")).toBe(true);
    expect(isEligibleReviewerComment({
      body: "Remove it.\n```suggestion\n\n```",
      author: "bob",
    }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({
      body: "![image](https://github.com/user-attachments/assets/abcd1234.gif)",
      author: "bob",
    }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({ body: "ok", author: "bob" }, "alice")).toBe(false);
    expect(isEligibleReviewerComment({ body: "Use `Box<T>`.", author: "bob" }, "alice")).toBe(true);
    expect(isEligibleReviewerComment({ body: "Use FooBar.", author: "bob" }, "alice")).toBe(true);
    expect(isEligibleReviewerComment({ body: "call foo_bar.", author: "bob" }, "alice")).toBe(true);
    expect(isEligibleReviewerComment({ body: "see retry.rs", author: "bob" }, "alice")).toBe(true);
    expect(isEligibleReviewerComment({ body: "Looks good here.", author: "bob" }, "alice")).toBe(false);
  });
});

describe("matchCandidate / prune / record", () => {
  it("keeps promoted candidates and expires only by time", () => {
    const kept = candidate({ gist: "newer rule about retries in the gateway wrapper", date: "2026-09-01", reviewer: "bob" });
    const promoted = { ...kept, id: generateCandidateId("old", "#2", "bob"), gist: "old", promoted_to: "M-001", date: "2026-09-01" };
    const pruned = pruneCandidates([
      candidate({ gist: "expired", date: "2026-01-01", reviewer: "bob" }),
      promoted,
      kept,
    ], { now: "2026-10-11", ttlDays: 180, cap: 2000 });
    expect(pruned.map((item) => item.id)).toEqual(expect.arrayContaining([kept.id, promoted.id]));
    expect(pruned.some((item) => item.gist === "expired")).toBe(false);
  });

  it("records a hash id and keeps promoted_to after promotion", () => {
    const existing = [candidate({
      gist: "Keep review comments short. Do not paste a whole function into a PR comment.",
      pr: "#10",
      reviewer: "bob",
    })];
    const next = recordCandidates(existing, [{
      body: "Please keep review comments short — don't paste an entire function into the PR comment.",
      author: "carol",
    }], {
      pr: "22",
      files: [],
      date: "2026-10-11",
      promoted: [{ candidate_id: existing[0]!.id, memory_id: "M-001" }],
    });
    expect(next.find((item) => item.id === existing[0]!.id)?.promoted_to).toBe("M-001");
    expect(next.some((item) => item.pr === "#22")).toBe(true);
    expect(existing[0]!.id).toMatch(/^C-[a-f0-9]{12}$/);
    expect(generateCandidateId("a", "#1", "bob")).not.toBe(generateCandidateId("b", "#1", "bob"));
  });

  it("merges candidate lists by id and keeps promoted_to", () => {
    const id = generateCandidateId("gateway retries", "#2", "bob");
    const incoming = [candidate({
      id,
      gist: "newer gist about gateway retries",
      pr: "#2",
      date: "2026-10-11",
      reviewer: "bob",
    })];
    const existing = [candidate({
      id,
      gist: "older gist about gateway retries",
      pr: "#2",
      date: "2026-09-01",
      reviewer: "bob",
      promoted_to: "M-001",
    })];
    const merged = mergeCandidateLists(incoming, existing);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(id);
    expect(merged[0]?.promoted_to).toBe("M-001");
    expect(merged[0]?.date).toBe("2026-10-11");
  });

  it("records a suggestion-only comment instead of dropping an empty gist", () => {
    const next = recordCandidates([], [{
      body: "```suggestion\nuse Box<T>\n```",
      author: "bob",
      path: "src/box.ts",
    }], {
      pr: "42",
      files: ["src/box.ts"],
      date: "2026-10-11",
      promoted: [],
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.gist).toContain("box<t>");
    expect(next[0]?.gist.length).toBeGreaterThan(0);
  });

  it("does not deterministically match two unrelated packages comments", () => {
    const open = candidate({
      gist: "Please add a changelog entry for this public API.",
      files: ["packages/vitest/src/node/cli.ts"],
      pr: "#10",
      reviewer: "bob",
    });
    expect(matchCandidate(
      "Please export the helper from the package index.",
      ["packages/browser/src/client.ts"],
      [open],
      "22",
    )).toBeUndefined();
  });
});

describe("isPromotableQuality", () => {
  it("accepts imperative rules and rejects questions or status notes", () => {
    expect(isPromotableQuality("Keep review comments short. Do not paste a whole function into a PR comment.")).toBe(true);
    expect(isPromotableQuality("Can we move this helper?")).toBe(false);
    expect(isPromotableQuality("Updated.")).toBe(false);
  });
});
