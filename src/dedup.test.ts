import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ruleSimilarity } from "./dedup.js";
import { checkDuplicate, forceUpdateIfDuplicate, planLearnOutcomes } from "./learn.js";
import { runLearn } from "./learn-run.js";
import { formatMemory, loadMemories, parseMemory } from "./memory.js";
import { emptyUsage } from "./usage.js";
import type { LearnOutcome, Memory, PullRequestContext, ReviewCandidate } from "./types.js";

const version = "When documenting a newly introduced public API or configuration option, include the team's <Version> annotation in its heading, using the version that introduces it.";
const cleanup = "When deciding whether to remove introduction-version annotations, tie removal to a new-major documentation rollover, since earlier major documentation remains available. Removing an experimental designation alone does not justify removing version annotations.";
const ai = "When submitting an AI-assisted PR, write the contribution disclosure personally without AI involvement. If the contributor is an automated agent, explicitly disclose that status.";
const aiReply = "When a reviewer asks whether a contribution or response used AI, the contributor must personally write the answer without AI assistance. This process rule is supported by human review in PRs #10403 and #10438.";
const candidate: ReviewCandidate = { id: "C-5c2f35b9ec11", gist: aiReply, terms: [], files: [], pr: "#10403", date: "2026-05-24", reviewer: "bob" };
function memory(body = version, overrides: Partial<Memory["frontmatter"]> = {}): Memory {
  return { filepath: "/tmp/project/.memory/memories/M-001.md", body, frontmatter: {
    id: "M-001", kind: "convention", paths: ["docs/**"], paths_source: "distiller", scope: "triggered",
    evidence: { pr: "#1", prs: ["#1"], reviewers: ["alice"], commits: ["old"] },
    author: "alice", created: "2026-05-01", review_after: "2026-07-30", status: "candidate", usage: emptyUsage("1"), ...overrides,
  } };
}
function context(number = "2"): PullRequestContext {
  return { number, title: "Docs", body: "", url: `https://example.test/pull/${number}`, author: "author", diff: "", merged: true,
    review_comments: [cleanup], human_review_comments: [cleanup], reviewer_comments: [{ body: cleanup, author: "bob" }],
    commit_messages: [], commits: ["new"], files: ["docs/api.md"], evidence_files: ["docs/api.md"] };
}
function proposal(body = cleanup): LearnOutcome {
  return { action: "new", title: "Version annotation lifecycle", body, paths: ["docs/**"], reasoning: "Human review applies this rule" };
}
function resulting(plan: ReturnType<typeof planLearnOutcomes>, id = "M-001"): Memory {
  const mutation = plan.mutations.find(m => parseMemory(m.content ?? "")?.frontmatter.id === id)!;
  return { ...parseMemory(mutation.content!)!, filepath: mutation.path };
}
const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-05-30T12:00:00Z")); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe("same-category write decisions", () => {
  it("updates a version rule in place and preserves both obligations, evidence and applicability", () => {
    const old = memory(version, { status: "active", triggers: [{ glob: "docs/**" }] });
    const plan = planLearnOutcomes({ ...proposal(), scope: "always", paths: ["**"], triggers: [{ glob: "**" }] }, [old], context(), "/tmp/project");
    expect(plan.learned).toBe(0);
    expect(plan.updated).toBe(1);
    expect(plan.outcomes[0]?.action).toBe("update");
    const next = resulting(plan);
    expect(next.filepath).toBe(old.filepath);
    expect(next.body).toContain(version);
    expect(next.body).toContain(cleanup);
    expect(next.frontmatter).toMatchObject({ id: "M-001", status: "active", paths: ["docs/**"], scope: "triggered", triggers: [{ glob: "docs/**" }],
      evidence: { prs: ["#1", "#2"], reviewers: ["alice", "bob"], commits: ["old", "new"] }, usage: { citation_count: 1, cited_prs: ["2"] } });
  });

  it("counts distinct subsequent PRs, promotes at two, and does not count retries", () => {
    const first = planLearnOutcomes(proposal(version), [], context("1"), "/tmp/project");
    const one = resulting(first);
    const second = resulting(planLearnOutcomes(proposal(version), [one], context("2"), "/tmp/project"));
    expect(second.frontmatter.status).toBe("candidate");
    expect(second.frontmatter.usage?.citation_count).toBe(1);
    const retry = resulting(planLearnOutcomes(proposal(version), [second], context("2"), "/tmp/project"));
    expect(retry.frontmatter.usage?.citation_count).toBe(1);
    const third = resulting(planLearnOutcomes(proposal(version), [retry], context("3"), "/tmp/project"));
    expect(third.frontmatter.status).toBe("active");
    expect(third.frontmatter.usage?.cited_prs).toEqual(["2", "3"]);
  });

  it("compares against earlier writes in the same response without inventing a citation", () => {
    const plan = planLearnOutcomes({ action: "new", reasoning: "batch", memories: [proposal(version), proposal(version)] }, [], context("1"), "/tmp/project");
    expect(plan.learned).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.mutations).toHaveLength(1);
    expect(plan.outcomes.map(o => o.memory_id)).toEqual(["M-001", "M-001"]);
    expect(resulting(plan).frontmatter.usage?.citation_count).toBe(0);
  });

  it.each(["reuse", "update", "merge", "propose_retire", "no_op"] as const)("keeps explicit %s with same_as instead of turning it into promote", action => {
    const plan = planLearnOutcomes({ action, memory_id: "M-001", same_as: candidate.id, reasoning: "explicit decision" }, [memory(ai)], context(), "/tmp/project", 90, [], false, [candidate]);
    expect(plan.outcomes[0]?.action).toBe(action);
    expect(plan.learned).toBe(0);
  });

  it("links an AI recurrence to the memory already cited by its source PR", () => {
    const old = memory(ai, { paths: ["**"], evidence: { pr: "#10403", prs: ["#10251", "#10403"], reviewers: ["bob"] },
      usage: { ...emptyUsage("10251"), citation_count: 1, cited_prs: ["10403"] } });
    const plan = planLearnOutcomes({ ...proposal(aiReply), action: "promote", candidate_id: candidate.id, paths: ["**"] }, [old], context("10438"), "/tmp/project", 90, [], false, [candidate]);
    expect(plan.learned).toBe(0);
    expect(plan.outcomes[0]?.candidate_id).toBe(candidate.id);
    expect(resulting(plan).frontmatter).toMatchObject({ id: "M-001", status: "active", usage: { citation_count: 2, cited_prs: ["10403", "10438"] }, evidence: { prs: ["#10251", "#10403", "#10438"] } });
    expect(resulting(plan).body).toContain(aiReply);
  });

  it("does not merge unrelated rules merely because a candidate shares the source PR", () => {
    const old = memory("When handling HTTP requests, validate authentication credentials before accepting request bodies.", { evidence: { prs: ["#10403"] } });
    const plan = planLearnOutcomes({ ...proposal("When handling HTTP requests, record request duration after sending responses."), action: "promote", candidate_id: candidate.id }, [old], context(), "/tmp/project", 90, [], false, [candidate]);
    expect(plan.learned).toBe(1);
  });

  it("deduplicates a Chinese rule without sharing only grammatical characters", () => {
    const old = memory("当新增公共 API 文档时，应在标题标注引入版本。");
    const same = proposal("新增公共 API 的文档需要在标题标注引入版本。");
    expect(forceUpdateIfDuplicate(same, [old]).memory_id).toBe("M-001");
    expect(forceUpdateIfDuplicate(proposal("当新增公共 API 文档时，应在标题标注弃用状态。"), [old]).action).toBe("new");
  });

  it.each(["retired", "superseded", "abandoned"] as const)("does not match %s memories", status => {
    const plan = planLearnOutcomes(proposal(version), [memory(version, { status, superseded_by: status === "superseded" ? "M-009" : undefined })], context(), "/tmp/project");
    expect(plan.learned).toBe(1);
    expect(plan.outcomes[0]?.memory_id).toBe("M-002");
  });

  it("retires idle memories before matching and never reactivates a retired promoted_to target", () => {
    const old = memory(version, { created: "2026-01-01" });
    const plan = planLearnOutcomes(proposal(version), [old], context(), "/tmp/project");
    expect(plan.retired).toBe(1);
    expect(plan.learned).toBe(1);
    expect(resulting(plan).frontmatter.status).toBe("retired");
    const promoted = planLearnOutcomes({ ...proposal(), action: "promote", candidate_id: candidate.id }, [memory(version, { status: "retired" }), memory(cleanup, { id: "M-002", status: "active" })], context(), "/tmp/project", 90, [], false, [{ ...candidate, promoted_to: "M-001" }]);
    expect(promoted.outcomes[0]?.action).toBe("no_op");
    expect(promoted.mutations).toHaveLength(0);
  });

  it("uses inferred paths for matching, rejects disjoint paths and chooses ties stably", () => {
    expect(planLearnOutcomes({ ...proposal(version), paths: undefined }, [memory()], context(), "/tmp/project").learned).toBe(0);
    expect(forceUpdateIfDuplicate({ ...proposal(version), paths: ["src/**"] }, [memory()]).action).toBe("new");
    expect(checkDuplicate(version, ["docs/**"], [memory(version, { id: "M-002" }), memory()]).existing_id).toBe("M-001");
  });

  it("preserves human-authored applicability without re-resolving old paths", () => {
    const old = memory(version, { paths: ["legacy-docs/**"], paths_source: "human", scope: "always",
      evidence: { pr: "#1", prs: ["#1"], reviewers: ["bob"] } });
    const plan = planLearnOutcomes(proposal(version), [old], context(), "/tmp/project", 90, ["docs/api.md"], true);
    expect(plan.learned).toBe(1); // Explicit disjoint scope is not a duplicate.
    const same = planLearnOutcomes({ ...proposal(version), paths: ["**"] }, [old], context(), "/tmp/project", 90, ["docs/api.md"], true);
    expect(same.learned).toBe(0);
    expect(resulting(same).frontmatter).toMatchObject({ paths: ["legacy-docs/**"], paths_source: "human", scope: "always" });
  });

  it("matches using the experimental paths that will actually be written", () => {
    const plan = planLearnOutcomes({ ...proposal(version), paths: ["invalid/**"] }, [memory()], context(), "/tmp/project", 90, ["docs/api.md"], true);
    expect(plan.learned).toBe(0);
    expect(resulting(plan).frontmatter.paths).toEqual(["docs/**"]);
  });

  it("keeps explicit contradictions for review", () => {
    const plan = planLearnOutcomes({ ...proposal(version), contradicts: true, conflict_with: "M-001" }, [memory(version, { status: "active" })], context(), "/tmp/project");
    expect(plan.learned).toBe(1);
    expect(plan.conflicts).toEqual([{ memory_id: "M-002", existing_id: "M-001" }]);
  });

  it("reuses without silently truncating a supplement that needs explicit consolidation", () => {
    const body = `${version} ${"Preserve this separately evidenced obligation. ".repeat(16)}`.trim();
    const incoming = `${body} ${cleanup}`;
    const plan = planLearnOutcomes(proposal(incoming), [memory(body)], context(), "/tmp/project");
    expect(plan.learned).toBe(0);
    expect(plan.outcomes[0]?.action).toBe("reuse");
    expect(resulting(plan).body).toBe(body);
    expect(plan.outcomes[0]?.reasoning).toContain(`explicit consolidation needed for: ${incoming}`);
  });

  it("loads the configurable threshold through runLearn and persists the matched ID", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-dedup-")); dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-001.md"), formatMemory(memory().frontmatter, version));
    await fs.writeFile(path.join(dir, ".memory", "config.yml"), "dedup_similarity_threshold: 0.3\n");
    const result = await runLearn({ projectDir: dir, pr: "2", openPr: false, deps: { fetchPr: async () => context(), distill: async () => JSON.stringify(proposal()) } });
    expect(result.plan.updated).toBe(1);
    expect(await loadMemories(dir)).toHaveLength(1);
    await fs.writeFile(path.join(dir, ".memory", "config.yml"), "dedup_similarity_threshold: 1\n");
    // Reset the memory so the second proposal is still a supplement, not identical text.
    await fs.writeFile(path.join(dir, ".memory", "memories", "M-001.md"), formatMemory(memory().frontmatter, version));
    const strict = await runLearn({ projectDir: dir, pr: "3", openPr: false, deps: { fetchPr: async () => context("3"), distill: async () => JSON.stringify(proposal()) } });
    expect(strict.plan.learned).toBe(1);
  });

  it.each([0, -1, 1.1, NaN, Infinity])("rejects invalid threshold %s", threshold => {
    expect(() => planLearnOutcomes(proposal(), [], context(), "/tmp/project", 90, [], false, [], { dedupThreshold: threshold })).toThrow("dedup_similarity_threshold");
  });
});

describe("independent same-topic counterexamples", () => {
  it.each([
    ["When handling HTTP requests, validate authentication credentials before accepting request bodies.", "When handling HTTP requests, record request duration after sending responses."],
    ["Authentication handlers must validate credentials before accepting incoming requests.", "Authentication handlers must not validate user credentials because requests are verified by the gateway."],
    ["Use cursor pagination for database queries that return large result sets.", "Use offset pagination for database queries that return large result sets."],
    ["When logging authentication events, include the request identifier but never include user passwords.", "When logging authentication events, include user passwords but never include the request identifier."],
    [version, "When documenting a deprecated public API, include the team's `<Deprecated />` component in its section heading to make the deprecation visible."],
  ])("keeps different decisions separate even with linked evidence: %s", (left, right) => {
    expect(ruleSimilarity(left, right, true)).toBeLessThan(0.3);
    expect(forceUpdateIfDuplicate(proposal(right), [memory(left)], 0.3, "1").action).toBe("new");
  });
});
