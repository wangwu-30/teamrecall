import type { MemoryFrontmatter, RuleUsage } from "./types.js";

export function emptyUsage(originPr = ""): RuleUsage {
  return { retrieval_count: 0, citation_count: 0, cited_prs: [], origin_pr: normalizePr(originPr) };
}

function normalizePr(pr: string): string { return pr.replace(/^#/, "").trim(); }

export function recordRetrieval(fm: MemoryFrontmatter, today: string): MemoryFrontmatter {
  const usage = fm.usage ?? emptyUsage(fm.evidence?.pr);
  return { ...fm, usage: { ...usage, retrieval_count: usage.retrieval_count + 1, last_retrieved_at: today } };
}

/** A positive distiller decision is a citation, not proof of downstream code adoption.
 * Re-running the same PR cannot supply additional promotion evidence. */
export function recordCitation(fm: MemoryFrontmatter, pr: string, today: string, threshold = 2): MemoryFrontmatter {
  const usage = fm.usage ?? emptyUsage(fm.evidence?.pr);
  const key = normalizePr(pr);
  if (!key || key === usage.origin_pr || usage.cited_prs.includes(key)) return fm;
  const cited_prs = [...usage.cited_prs, key];
  return {
    ...fm,
    status: fm.status === "candidate" && cited_prs.length >= threshold ? "active" : fm.status,
    usage: { ...usage, cited_prs, citation_count: cited_prs.length, last_used_at: today },
  };
}

export function retireIfIdle(fm: MemoryFrontmatter, today: string, ttlDays: number): MemoryFrontmatter {
  if (fm.status !== "candidate" && fm.status !== "active") return fm;
  const lastUse = fm.usage?.last_used_at ?? fm.created;
  const idleDays = (Date.parse(today) - Date.parse(lastUse)) / 86400000;
  return idleDays >= ttlDays ? { ...fm, status: "retired" } : fm;
}
