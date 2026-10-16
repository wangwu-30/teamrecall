import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyUsage, recordCitation, recordRetrieval, retireIfIdle } from "./usage.js";
import { formatMemory, loadMemories, parseMemory } from "./memory.js";
import { runLearn } from "./learn-run.js";
import { generateDistillationPrompt, planLearnOutcomes } from "./learn.js";
import { runRetrieve } from "./retrieve.js";
import type { MemoryFrontmatter, PullRequestContext } from "./types.js";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
const rule = (): MemoryFrontmatter => ({ id: "M-001", kind: "convention", paths: ["src/**"], scope: "triggered", evidence: { pr: "#1" }, author: "reviewer", created: "2026-06-01", review_after: "2026-08-30", status: "candidate", usage: emptyUsage("#1") });
const context = (number: string): PullRequestContext => ({ number, title: "Review tests", body: "", url: "", author: "author", diff: "", merged: true, review_comments: ["Use real regression tests"], human_review_comments: ["Use real regression tests"], reviewer_comments: [{ body: "Use real regression tests", author: "reviewer" }], commit_messages: [], commits: [], files: ["src/test.ts"], evidence_files: [] });

it("counts retrieval separately and requires two distinct subsequent PR citations", () => {
  let fm = rule();
  for (let i = 0; i < 10; i++) fm = recordRetrieval(fm, "2026-06-02");
  expect(fm.status).toBe("candidate");
  expect(fm.usage?.retrieval_count).toBe(10);
  fm = recordCitation(fm, "#1", "2026-06-02");
  expect(fm.usage?.citation_count).toBe(0);
  fm = recordCitation(fm, "#2", "2026-06-03");
  fm = recordCitation(fm, "2", "2026-06-04");
  expect(fm.usage?.citation_count).toBe(1);
  expect(fm.usage?.last_used_at).toBe("2026-06-03");
  expect(fm.status).toBe("candidate");
  fm = recordCitation(fm, "3", "2026-06-05");
  expect(fm.status).toBe("active");
  expect(parseMemory(formatMemory(fm, "Use real regression tests"))?.frontmatter).toEqual(fm);
  expect(recordCitation(rule(), "2", "2026-06-02", 1).status).toBe("active");
});

it("expires at the idle TTL boundary; retrieval does not renew it but actual use does", () => {
  expect(retireIfIdle(rule(), "2026-08-29", 90).status).toBe("candidate");
  expect(retireIfIdle(recordRetrieval(rule(), "2026-08-29"), "2026-08-30", 90).status).toBe("retired");
  const used = recordCitation(rule(), "2", "2026-08-01", 1);
  expect(retireIfIdle(used, "2026-08-30", 90).status).toBe("active");
  expect(retireIfIdle(used, "2026-10-30", 90).status).toBe("retired");
});

it("loads legacy frontmatter without fabricated historical citations and rejects invalid counters", () => {
  const legacy = { ...rule(), status: "active" as const, usage: undefined };
  expect(parseMemory(formatMemory(legacy, "Rule"))).not.toBeNull();
  expect(recordCitation(legacy, "2", "2026-06-02").usage?.citation_count).toBe(1);
  expect(parseMemory(formatMemory({ ...rule(), usage: { ...emptyUsage(), retrieval_count: -1 } }, "Rule"))).toBeNull();
});

describe("real learning lifecycle", () => {
  it("persists reuse, deduplicates replay, compiles only after threshold and records retrieval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-01"));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-v2-")); dirs.push(dir);
    const learn = (pr: string, action: string) => runLearn({ projectDir: dir, pr, deps: {
      fetchPr: async () => context(pr), distill: async () => JSON.stringify({ action, memory_id: "M-001", title: "Regression tests", body: "For bug fixes, test the real boundary and reproduce the failure.", paths: ["src/**"], reasoning: "Current human review applies the same team rule" }),
    } });
    await learn("1", "new");
    expect((await loadMemories(dir))[0].frontmatter.status).toBe("candidate");
    await learn("1", "reuse"); await learn("2", "reuse"); await learn("2", "reuse");
    let fm = (await loadMemories(dir))[0].frontmatter;
    expect(fm.status).toBe("candidate"); expect(fm.usage?.citation_count).toBe(1);
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).not.toContain("M-001");
    await learn("3", "reuse");
    fm = (await loadMemories(dir))[0].frontmatter;
    expect(fm.status).toBe("active"); expect(fm.usage?.citation_count).toBe(2);
    expect(fm.usage?.retrieval_count).toBe(4);
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("M-001");
    await runRetrieve({ projectDir: dir, files: ["src/test.ts"] });
    expect((await loadMemories(dir))[0].frontmatter.usage?.retrieval_count).toBe(5);
    vi.setSystemTime(new Date("2026-08-30"));
    const expired = await learn("4", "no_op");
    expect(expired.plan.retired).toBe(1);
    expect((await loadMemories(dir))[0].frontmatter.status).toBe("retired");
    expect((await runRetrieve({ projectDir: dir, files: ["src/test.ts"] })).memories).toEqual([]);
    await learn("5", "reuse");
    expect((await loadMemories(dir))[0].frontmatter.status).toBe("retired");
  });

  it("retirement cannot be undone by a later outcome in the same answer", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-02"));
    const memory = { frontmatter: rule(), body: "Rule", filepath: "/tmp/M-001.md" };
    const plan = planLearnOutcomes({ action: "no_op", reasoning: "batch", memories: [
      { action: "propose_retire", memory_id: "M-001", reasoning: "Rejected by reviewer" },
      { action: "reuse", memory_id: "M-001", reasoning: "Duplicate conflicting decision" },
    ] }, [memory], context("2"), "/tmp");
    expect(plan.retired).toBe(1);
    expect(plan.outcomes[1].action).toBe("no_op");
    const writes = plan.mutations.filter(m => m.content).map(m => parseMemory(m.content!)!.frontmatter.status);
    expect(writes).toEqual(["retired"]);
  });
});

it("new and promotion prompts require transferable team decisions and include contrasting examples", () => {
  const prompt = generateDistillationPrompt({ pr_number: "1", diff: "", pr_body: "", review_comments: [], commit_messages: [], existing_memories: [] });
  for (const criterion of ["future, different PR", "filenames, variable names", "team convention", "fact description", "new, promote, reuse and update"]) expect(prompt).toContain(criterion);
  expect(prompt.match(/^\d\. /gm)?.length).toBeGreaterThanOrEqual(9);
  expect(prompt).toContain("trace parser"); expect(prompt).toContain("provider object"); expect(prompt).toContain("mock constructor");
});

it("uses configured thresholds through runLearn and migrates legacy usage without losing the first citation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-02"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-config-")); dirs.push(dir);
  await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
  await fs.writeFile(path.join(dir, ".memory", "config.yml"), "promotion_min_prs: 1\n");
  const filepath = path.join(dir, ".memory", "memories", "M-001.md");
  await fs.writeFile(filepath, formatMemory({ ...rule(), usage: undefined }, "Use real regression tests"));
  await runLearn({ projectDir: dir, pr: "2", deps: {
    fetchPr: async () => context("2"),
    distill: async () => JSON.stringify({ action: "reuse", memory_id: "M-001", reasoning: "Review explicitly applies this rule" }),
  } });
  const fm = (await loadMemories(dir))[0].frontmatter;
  expect(fm.status).toBe("active");
  expect(fm.usage?.origin_pr).toBe("1");
  expect(fm.usage?.citation_count).toBe(1);
});
