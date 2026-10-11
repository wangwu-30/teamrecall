import { describe, expect, it } from "vitest";
import {
  candidatesOverlap,
  extractTerms,
  matchCandidate,
  normalizeGist,
  pruneCandidates,
  recordCandidates,
} from "./candidates.js";
import type { ReviewCandidate } from "./types.js";

function candidate(partial: Partial<ReviewCandidate> & { id: string; gist: string }): ReviewCandidate {
  return {
    terms: extractTerms(partial.gist),
    files: [],
    pr: "#1",
    date: "2026-10-01",
    ...partial,
  };
}

describe("normalizeGist / extractTerms", () => {
  it("collapses a review comment into a stable gist and terms", () => {
    const gist = normalizeGist("Keep review comments short. Don't paste a whole function into a PR comment.");
    expect(gist).toContain("keep review comments short");
    expect(extractTerms(gist)).toEqual(expect.arrayContaining(["keep", "review", "comments", "short", "paste", "function"]));
  });
});

describe("candidatesOverlap", () => {
  it("matches a keep-comments-short style recurrence", () => {
    const first = {
      gist: normalizeGist("Keep review comments short. Do not paste a whole function into a PR comment."),
      terms: extractTerms("Keep review comments short. Do not paste a whole function into a PR comment."),
      files: [],
    };
    const second = {
      gist: normalizeGist("Please keep review comments short — don't paste an entire function into the PR comment."),
      terms: extractTerms("Please keep review comments short — don't paste an entire function into the PR comment."),
      files: [],
    };
    expect(candidatesOverlap(first, second).match).toBe(true);
  });

  it("does not match unrelated comments", () => {
    const first = {
      gist: normalizeGist("Keep review comments short."),
      terms: extractTerms("Keep review comments short. Do not paste a whole function into a PR comment."),
      files: [],
    };
    const second = {
      gist: normalizeGist("Register retries only in the gateway wrapper."),
      terms: extractTerms("Register retries only in the gateway wrapper so callers see one policy."),
      files: ["src/gateway.ts"],
    };
    expect(candidatesOverlap(first, second).match).toBe(false);
  });
});

describe("matchCandidate / prune / record", () => {
  it("skips the same PR and promoted candidates", () => {
    const open = candidate({
      id: "C-001",
      gist: normalizeGist("Keep review comments short. Do not paste a whole function into a PR comment."),
      pr: "#10",
    });
    const promoted = { ...open, id: "C-002", promoted_to: "M-001" };
    expect(matchCandidate(open.gist, [], [open], "10")).toBeUndefined();
    expect(matchCandidate(open.gist, [], [promoted], "22")).toBeUndefined();
    expect(matchCandidate(
      "Please keep review comments short and do not paste a whole function.",
      [],
      [open],
      "22",
    )?.id).toBe("C-001");
  });

  it("drops expired and promoted candidates and caps the rest", () => {
    const kept = candidate({ id: "C-002", gist: "newer", date: "2026-09-01" });
    const pruned = pruneCandidates([
      candidate({ id: "C-001", gist: "old", date: "2026-01-01" }),
      { ...kept, promoted_to: "M-001" },
      kept,
    ], { now: "2026-10-11", ttlDays: 180, cap: 1 });
    expect(pruned.map((item) => item.id)).toEqual(["C-002"]);
  });

  it("records a new candidate and marks a promotion", () => {
    const existing = [candidate({
      id: "C-001",
      gist: normalizeGist("Keep review comments short. Do not paste a whole function into a PR comment."),
      pr: "#10",
    })];
    const next = recordCandidates(existing, [
      "Please keep review comments short — don't paste an entire function into the PR comment.",
    ], {
      pr: "22",
      files: [],
      date: "2026-10-11",
      promoted: [{ candidate_id: "C-001", memory_id: "M-001" }],
    });
    expect(next.some((item) => item.id === "C-001")).toBe(false);
    expect(next.every((item) => !item.promoted_to)).toBe(true);
    expect(next.some((item) => candidatesOverlap(item, existing[0]!).match)).toBe(false);
  });
});
