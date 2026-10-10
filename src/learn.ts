import * as path from "node:path";
import { MAX_ACTIVE_MEMORIES, MAX_LEARN_PER_PR } from "./constants.js";
import {
  clampBody,
  formatMemory,
  generateMemoryId,
  isoDate,
  memoryFilename,
  reviewAfterDate,
} from "./memory.js";
import type { LearnOutcome, Memory, MemoryFrontmatter, MemoryKind, PullRequestContext } from "./types.js";

export interface LearnInput {
  pr_number: string;
  diff: string;
  pr_body: string;
  review_comments: string[];
  commit_messages: string[];
  existing_memories: Memory[];
}

export interface DedupResult {
  is_duplicate: boolean;
  existing_id?: string;
  reason: string;
}

export interface FileMutation {
  path: string;
  content?: string;
  delete?: boolean;
}

export interface LearnPlan {
  action: LearnOutcome["action"];
  outcomes: LearnOutcome[];
  mutations: FileMutation[];
  learned: number;
  updated: number;
  retired: number;
  summary: string;
}

const ACTIONS: LearnOutcome["action"][] = [
  "reuse",
  "update",
  "merge",
  "propose_retire",
  "new",
  "no_op",
];

export function generateDistillationPrompt(input: LearnInput): string {
  const existingIndex = input.existing_memories
    .map((memory) => `- ${memory.frontmatter.id}: ${firstLine(memory.body)} (paths: ${memory.frontmatter.paths.join(", ")})`)
    .join("\n");

  return `You are reviewing a merged pull request to extract reusable engineering knowledge for the team.

PR #${input.pr_number}

## PR Description
${input.pr_body || "(empty)"}

## Review Comments
${input.review_comments.length > 0 ? input.review_comments.join("\n\n---\n\n") : "(none)"}

## Commit Messages
${input.commit_messages.join("\n") || "(none)"}

## Diff Summary
${input.diff.slice(0, 3000)}${input.diff.length > 3000 ? "\n...(truncated)" : ""}

## Existing Team Memories
${existingIndex || "(none)"}

---

Your task: Decide if this PR contains reusable engineering knowledge worth capturing.

A memory must have:
1. Observable trigger condition (when to apply it)
2. Decision it changes (not just facts)
3. Broader applicability beyond this specific PR

Choose ONE outcome (respond with ONLY the JSON, no other text):

\`\`\`json
{
  "action": "reuse|update|merge|propose_retire|new|no_op",
  "memory_id": "M-xxx (if reuse/update/merge/propose_retire)",
  "title": "Short title (if new/update)",
  "kind": "gotcha|decision|convention|map (if new)",
  "paths": ["glob patterns (if new/update)"],
  "body": "≤120 words: trigger and decision change (if new/update)",
  "reasoning": "Why this action",
  "memories": []
}
\`\`\`

Actions:
- **reuse**: This PR validates an existing memory (no change needed)
- **update**: Strengthen/correct an existing memory with new evidence
- **merge**: Consolidate overlapping memories
- **propose_retire**: This PR shows a memory is outdated
- **new**: Create a new memory (max 3 per PR, only if clearly useful for future PRs)
- **no_op**: No reusable knowledge (most PRs should be no_op)

Bias toward no_op. Only create new memories if they would change future decisions.`;
}

export function parseDistillationResponse(response: string): LearnOutcome {
  try {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = (jsonMatch ? jsonMatch[1] : response).trim();
    const parsed = JSON.parse(jsonStr) as LearnOutcome;
    if (!ACTIONS.includes(parsed.action) || !parsed.reasoning) {
      throw new Error("Missing or invalid action/reasoning");
    }
    return parsed;
  } catch (error) {
    return {
      action: "no_op",
      reasoning: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function checkDuplicate(title: string, paths: string[], existing: Memory[]): DedupResult {
  const normalizedTitle = title.toLowerCase().trim();

  for (const memory of existing) {
    const existingTitle = firstLine(memory.body).toLowerCase().trim();
    const titleSimilar = levenshteinDistance(normalizedTitle, existingTitle) < 5;
    const pathsOverlap = paths.some((glob) => memory.frontmatter.paths.includes(glob));
    if (titleSimilar && pathsOverlap) {
      return {
        is_duplicate: true,
        existing_id: memory.frontmatter.id,
        reason: `Similar to existing ${memory.frontmatter.id}`,
      };
    }
  }

  return { is_duplicate: false, reason: "No duplicate found" };
}

export function forceUpdateIfDuplicate(outcome: LearnOutcome, existing: Memory[]): LearnOutcome {
  if (outcome.action !== "new") return outcome;
  const title = outcome.title || firstLine(outcome.body || "");
  const paths = outcome.paths || [];
  const dup = checkDuplicate(title, paths, existing);
  if (!dup.is_duplicate) return outcome;
  return {
    ...outcome,
    action: "update",
    memory_id: dup.existing_id,
    reasoning: `${outcome.reasoning} Forced update: ${dup.reason}`,
  };
}

export function planLearnOutcomes(
  raw: LearnOutcome,
  existing: Memory[],
  context: PullRequestContext,
  projectDir: string,
  ttlDays = 90,
): LearnPlan {
  const candidates = (raw.memories && raw.memories.length > 0 ? raw.memories : [raw])
    .map((outcome) => forceUpdateIfDuplicate(outcome, existing))
    .slice(0, MAX_LEARN_PER_PR);

  const mutations: FileMutation[] = [];
  const outcomes: LearnOutcome[] = [];
  let learned = 0;
  let updated = 0;
  let retired = 0;
  const usedIds = existing.map((memory) => memory.frontmatter.id);
  let activeCount = existing.filter((memory) => memory.frontmatter.status === "active").length;

  for (const outcome of candidates) {
    if (outcome.action === "no_op" || outcome.action === "reuse") {
      outcomes.push(outcome);
      continue;
    }

    if (outcome.action === "new" && activeCount >= MAX_ACTIVE_MEMORIES) {
      outcomes.push({
        ...outcome,
        action: "no_op",
        reasoning: `Active memory cap (${MAX_ACTIVE_MEMORIES}) reached`,
      });
      continue;
    }

    const planned = planOne(outcome, existing, context, projectDir, usedIds, ttlDays);
    outcomes.push(planned.outcome);
    mutations.push(...planned.mutations);
    learned += planned.learned;
    updated += planned.updated;
    retired += planned.retired;
    activeCount += planned.learned - planned.retired;
    usedIds.push(...planned.usedIds);
  }

  const action = summarizeAction(outcomes);
  return {
    action,
    outcomes,
    mutations,
    learned,
    updated,
    retired,
    summary: buildSummary(learned, updated, retired, context.number),
  };
}

function planOne(
  outcome: LearnOutcome,
  existing: Memory[],
  context: PullRequestContext,
  projectDir: string,
  usedIds: string[],
  ttlDays: number,
): { outcome: LearnOutcome; mutations: FileMutation[]; learned: number; updated: number; retired: number; usedIds: string[] } {
  const created = isoDate();
  const evidence = {
    pr: `#${context.number}`,
    review_url: context.url || undefined,
    commits: context.commits.slice(0, 5),
  };

  if (outcome.action === "new") {
    const id = generateMemoryId(usedIds);
    const title = outcome.title || firstLine(outcome.body || "Untitled lesson");
    const body = clampBody(outcome.body || title);
    const frontmatter: MemoryFrontmatter = {
      id,
      kind: (outcome.kind as MemoryKind) || inferKind(body),
      paths: outcome.paths && outcome.paths.length > 0 ? outcome.paths : inferPaths(context.files),
      evidence,
      author: context.author || "teamrecall",
      created,
      review_after: reviewAfterDate(created, ttlDays),
      status: "active",
    };
    const filename = memoryFilename(id, title);
    return {
      outcome: { ...outcome, memory_id: id, title, body },
      mutations: [{
        path: path.join(projectDir, ".memory", "memories", filename),
        content: formatMemory(frontmatter, body),
      }],
      learned: 1,
      updated: 0,
      retired: 0,
      usedIds: [id],
    };
  }

  const target = existing.find((memory) => memory.frontmatter.id === outcome.memory_id);
  if (!target) {
    return {
      outcome: { ...outcome, action: "no_op", reasoning: `Unknown memory ${outcome.memory_id}` },
      mutations: [],
      learned: 0,
      updated: 0,
      retired: 0,
      usedIds: [],
    };
  }

  if (outcome.action === "propose_retire") {
    const retired = {
      ...target.frontmatter,
      status: "retired" as const,
    };
    const dest = path.join(projectDir, ".memory", "retired", path.basename(target.filepath));
    return {
      outcome,
      mutations: [
        { path: dest, content: formatMemory(retired, target.body) },
        { path: target.filepath, delete: true },
      ],
      learned: 0,
      updated: 0,
      retired: 1,
      usedIds: [],
    };
  }

  const nextFrontmatter: MemoryFrontmatter = {
    ...target.frontmatter,
    paths: outcome.paths && outcome.paths.length > 0 ? outcome.paths : target.frontmatter.paths,
    evidence: {
      ...target.frontmatter.evidence,
      ...evidence,
      commits: unique([
        ...(target.frontmatter.evidence.commits ?? []),
        ...evidence.commits,
      ]).slice(0, 8),
    },
    review_after: reviewAfterDate(created, ttlDays),
  };
  const body = clampBody(outcome.body || target.body);
  return {
    outcome,
    mutations: [{ path: target.filepath, content: formatMemory(nextFrontmatter, body) }],
    learned: 0,
    updated: 1,
    retired: 0,
    usedIds: [],
  };
}

export function buildLearnPrTitle(learned: number, updated: number, prNumber: string): string {
  const parts: string[] = [];
  if (learned) parts.push(`learned ${learned}`);
  if (updated) parts.push(`updated ${updated}`);
  if (parts.length === 0) parts.push("no-op");
  return `🧠 teamrecall: ${parts.join(", ")} (from #${prNumber})`;
}

export function buildLearnPrBody(plan: LearnPlan, context: PullRequestContext): string {
  const rows = plan.outcomes.map((outcome) => {
    const id = outcome.memory_id || "—";
    const review = context.url ? `[review](${context.url})` : "—";
    const commits = context.commits.slice(0, 3).join(", ") || "—";
    return `| ${id} | ${outcome.action} | #${context.number} | ${review} | ${commits} |`;
  });

  return [
    `Auto-learned from #${context.number} (\`${context.title}\`).`,
    "",
    "| Memory | Action | PR | Review | Commits |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Only `.memory/` and compiled agent files are touched.",
    "",
    plan.outcomes.map((outcome) => `- **${outcome.action}** ${outcome.memory_id ?? ""}: ${outcome.reasoning}`).join("\n"),
  ].join("\n");
}

export function fallbackOutcomeFromReviews(context: PullRequestContext): LearnOutcome {
  const directive = context.review_comments.find((comment) => isDirective(comment));
  if (!directive) {
    return { action: "no_op", reasoning: "No reusable directive in review comments" };
  }
  const body = clampBody(directive.replace(/\s+/g, " "));
  return {
    action: "new",
    title: firstLine(body),
    kind: inferKind(body),
    paths: inferPaths(context.files),
    body,
    reasoning: "Deterministic fallback from a review directive",
  };
}

function isDirective(text: string): boolean {
  return /\b(never|always|must|don't|do not|should only|retries?|convention|don't use)\b/i.test(text)
    && text.trim().length >= 40;
}

function inferKind(body: string): MemoryKind {
  if (/\b(never|gotcha|pitfall|don't|do not)\b/i.test(body)) return "gotcha";
  if (/\b(we decided|decision|choose|prefer)\b/i.test(body)) return "decision";
  if (/\b(lives in|see |map|located)\b/i.test(body)) return "map";
  return "convention";
}

function inferPaths(files: string[]): string[] {
  const dirs = files
    .map((file) => file.split("/")[0])
    .filter((part) => part && !part.startsWith("."));
  const uniqueDirs = unique(dirs).slice(0, 2);
  if (uniqueDirs.length === 0) return ["**/*"];
  return uniqueDirs.map((dir) => `${dir}/**/*`);
}

function summarizeAction(outcomes: LearnOutcome[]): LearnOutcome["action"] {
  if (outcomes.some((outcome) => outcome.action === "new")) return "new";
  if (outcomes.some((outcome) => outcome.action === "update" || outcome.action === "merge")) return "update";
  if (outcomes.some((outcome) => outcome.action === "propose_retire")) return "propose_retire";
  if (outcomes.some((outcome) => outcome.action === "reuse")) return "reuse";
  return "no_op";
}

function buildSummary(learned: number, updated: number, retired: number, prNumber: string): string {
  return `learned ${learned}, updated ${updated}, retired ${retired} (from #${prNumber})`;
}

function firstLine(body: string): string {
  return body.trim().split("\n")[0] || "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
