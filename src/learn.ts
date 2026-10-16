import { emptyUsage, recordCitation, recordRetrieval, retireIfIdle } from "./usage.js";
import * as path from "node:path";
import {
  extractTerms,
  normalizeGist,
  packageFloor,
} from "./candidates.js";
import {
  CANDIDATE_PROMPT_FILES,
  CANDIDATE_PROMPT_K,
  CANDIDATE_PROMPT_PER_COMMENT,
  MAX_ACTIVE_MEMORIES,
  MAX_LEARN_PER_PR,
  PROMPT_COMMITS_CHARS,
  PROMPT_CONTEXT_CHARS,
  PROMPT_MEMORY_K,
  PROMPT_MEMORY_TITLE_CHARS,
} from "./constants.js";
import { bm25ScoresFromIndex, buildBm25Index, tokenize } from "./retrieve.js";
import {
  clampBody,
  parseMemory,
  formatMemory,
  generateMemoryId,
  isoDate,
  memoryFilename,
  reviewAfterDate,
} from "./memory.js";
import { defaultScope } from "./memory.js";
import { globMatches } from "./sweep.js";
import type { LearnOutcome, Memory, MemoryFrontmatter, MemoryKind, MemoryScope, PathsSource, PullRequestContext, ReviewCandidate } from "./types.js";

export interface LearnInput {
  pr_number: string;
  diff: string;
  pr_body: string;
  review_comments: string[];
  commit_messages: string[];
  existing_memories: Memory[];
  candidates?: ReviewCandidate[];
  files?: string[];
  title?: string;
  reviewer_comments?: Array<{ body: string; path?: string }>;
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

export interface PathConflict {
  memory_id: string;
  existing_id: string;
}

export type DistillerKind = "llm" | "deterministic";
export type DistillerReason = "no_llm_secret" | "llm_failed";

export interface LearnPlan {
  action: LearnOutcome["action"];
  outcomes: LearnOutcome[];
  mutations: FileMutation[];
  learned: number;
  updated: number;
  retired: number;
  conflicts: PathConflict[];
  scope_notes: string[];
  distiller: DistillerKind;
  distiller_reason?: DistillerReason;
  summary: string;
  candidates_recorded: number;
}

const ACTIONS: LearnOutcome["action"][] = [
  "reuse",
  "update",
  "merge",
  "propose_retire",
  "new",
  "promote",
  "no_op",
];

export function pathProximity(commentFiles: string[], candidateFiles: string[]): number {
  if (commentFiles.length === 0 || candidateFiles.length === 0) return 0;
  const right = new Set(candidateFiles);
  if (commentFiles.some((file) => right.has(file))) return 3;
  const dirs = new Set(commentFiles.map(parentDir).filter(Boolean));
  if (candidateFiles.some((file) => dirs.has(parentDir(file)))) return 2;
  const packages = new Set(commentFiles.map(packageFloor).filter(Boolean));
  if (candidateFiles.some((file) => packages.has(packageFloor(file)))) return 1;
  return 0;
}

function parentDir(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

export function selectPromptCandidates(
  candidates: ReviewCandidate[],
  input: {
    review_comments: string[];
    reviewer_comments?: Array<{ body: string; path?: string }>;
    files?: string[];
    title?: string;
    body?: string;
  },
  k = CANDIDATE_PROMPT_K,
): ReviewCandidate[] {
  const open = candidates.filter((candidate) => !candidate.promoted_to);
  if (open.length <= k) return open;
  const comments = (input.reviewer_comments?.length
    ? input.reviewer_comments
    : input.review_comments.map((body) => ({ body, path: undefined as string | undefined })));
  const queries = comments.length > 0 ? comments : [{ body: [input.title, input.body].filter(Boolean).join(" "), path: undefined }];
  // Candidate gists/terms are lower-cased before splitting, so `onTestFinished` is stored as "ontestfinished".
  // Index and query both camel-split tokens and whole lower-cased words so identifiers match either way.
  const both = (text: string) => [...tokenize(text), ...extractTerms(text)];
  const docs = open.map((candidate) => both(`${candidate.gist} ${candidate.terms.join(" ")}`));
  const index = buildBm25Index(docs);
  const meta = open.map((candidate) => ({
    files: new Set(candidate.files),
    dirs: new Set(candidate.files.map(parentDir).filter(Boolean)),
    packages: new Set(candidate.files.map(packageFloor).filter(Boolean)),
  }));
  const perComment = Math.min(CANDIDATE_PROMPT_PER_COMMENT, k);
  const perCommentRanked: Array<Array<{ candidate: ReviewCandidate; score: number }>> = [];
  for (const comment of queries) {
    const raw = bm25ScoresFromIndex(both(comment.body), index);
    const commentFiles = comment.path ? [comment.path] : (input.files ?? []);
    const ranked = open
      .map((candidate, docIndex) => ({
        candidate,
        score: (raw[docIndex] ?? 0) + pathBoost(commentFiles, meta[docIndex]),
      }))
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
      .slice(0, perComment);
    perCommentRanked.push(ranked);
  }
  const selected = new Map<string, { candidate: ReviewCandidate; score: number }>();
  for (let slot = 0; slot < perComment; slot++) {
    for (const ranked of perCommentRanked) {
      const item = ranked[slot];
      if (!item) continue;
      const prev = selected.get(item.candidate.id);
      if (!prev || item.score > prev.score) selected.set(item.candidate.id, item);
      if (selected.size >= k) {
        return [...selected.values()]
          .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
          .map((item) => item.candidate);
      }
    }
  }
  return [...selected.values()]
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
    .slice(0, k)
    .map((item) => item.candidate);
}

function pathBoost(
  commentFiles: string[],
  meta?: { files: Set<string>; dirs: Set<string>; packages: Set<string> },
): number {
  if (!meta || commentFiles.length === 0) return 0;
  if (commentFiles.some((file) => meta.files.has(file))) return 6;
  if (commentFiles.map(parentDir).some((dir) => dir && meta.dirs.has(dir))) return 4;
  if (commentFiles.map(packageFloor).some((pkg) => pkg && meta.packages.has(pkg))) return 2;
  return 0;
}

export function formatPromptCandidate(candidate: ReviewCandidate): string {
  const files = candidate.files.slice(0, CANDIDATE_PROMPT_FILES);
  const extra = candidate.files.length > CANDIDATE_PROMPT_FILES
    ? ` +${candidate.files.length - CANDIDATE_PROMPT_FILES}`
    : "";
  const fileList = files.length > 0 ? `${files.join(", ")}${extra}` : "—";
  return `- ${candidate.id}: ${candidate.gist} (from ${candidate.pr}; files: ${fileList})`;
}

export function capPromptContext(
  prBody: string,
  comments: string[],
  budget = PROMPT_CONTEXT_CHARS,
): { body: string; comments: string } {
  const bodyText = prBody.trim() ? prBody : "(empty)";
  if (comments.length === 0) {
    return { body: truncateHead(bodyText, budget), comments: "(none)" };
  }
  const bodyCap = Math.floor(budget * 0.4);
  const body = truncateHead(bodyText, bodyCap);
  const commentBudget = Math.max(0, budget - body.length);
  return { body, comments: capCommentHeads(comments, commentBudget) };
}

function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 16);
  return `${text.slice(0, keep)}\n...(truncated)`;
}

function capCommentHeads(comments: string[], budget: number): string {
  const sep = "\n\n---\n\n";
  const overhead = sep.length * Math.max(0, comments.length - 1);
  let per = Math.floor(Math.max(0, budget - overhead) / Math.max(comments.length, 1));
  per = Math.max(40, per);
  const render = (width: number) => comments.map((comment) => truncateHead(comment, width)).join(sep);
  let out = render(per);
  while (out.length > budget && per > 40) {
    per = Math.max(40, Math.floor(per * 0.75));
    const next = render(per);
    if (next.length >= out.length) break;
    out = next;
  }
  if (out.length > budget) return truncateHead(out, budget);
  return out;
}

export function capCommitMessages(messages: string[], budget = PROMPT_COMMITS_CHARS): string {
  if (messages.length === 0) return "(none)";
  return capCommentHeads(messages, budget);
}

export function selectPromptMemories(
  memories: Memory[],
  input: {
    review_comments: string[];
    reviewer_comments?: Array<{ body: string; path?: string }>;
    files?: string[];
    title?: string;
    body?: string;
  },
  k = PROMPT_MEMORY_K,
): Memory[] {
  memories = memories.filter(m => m.frontmatter.status === "active" || m.frontmatter.status === "candidate");
  if (memories.length <= k) return memories;
  const query = tokenize([
    ...(input.reviewer_comments ?? []).map((comment) => comment.body),
    ...input.review_comments,
    input.title ?? "",
    input.body ?? "",
    ...(input.files ?? []),
  ].join(" "));
  const index = buildBm25Index(memories.map((memory) => tokenize(`${firstLine(memory.body)} ${memory.body}`)));
  const scores = bm25ScoresFromIndex(query, index);
  return memories
    .map((memory, docIndex) => ({ memory, score: scores[docIndex] ?? 0 }))
    .sort((left, right) => right.score - left.score || left.memory.frontmatter.id.localeCompare(right.memory.frontmatter.id))
    .slice(0, k)
    .map((item) => item.memory);
}

export function generateDistillationPrompt(input: LearnInput): string {
  const existingIndex = selectPromptMemories(input.existing_memories, {
    review_comments: input.review_comments,
    reviewer_comments: input.reviewer_comments,
    files: input.files,
    title: input.title,
    body: input.pr_body,
  })
    .map((memory) => `- ${memory.frontmatter.id}: [${memory.frontmatter.status}] ${firstLine(memory.body).slice(0, PROMPT_MEMORY_TITLE_CHARS)}`)
    .join("\n");
  const candidateIndex = selectPromptCandidates(input.candidates ?? [], {
    review_comments: input.review_comments,
    reviewer_comments: input.reviewer_comments,
    files: input.files,
    title: input.title,
    body: input.pr_body,
  })
    .map((candidate) => formatPromptCandidate(candidate))
    .join("\n");
  const context = capPromptContext(input.pr_body, input.review_comments);
  const commits = capCommitMessages(input.commit_messages);

  return `You are reviewing a closed pull request to extract reusable engineering knowledge for the team.
This PR may be merged or closed without merging. Human review comments are valid evidence either way.

PR #${input.pr_number}

## PR Description
${context.body}

## Review Comments
${context.comments}

## Commit Messages
${commits}

## Diff Summary
${input.diff.slice(0, 3000)}${input.diff.length > 3000 ? "\n...(truncated)" : ""}

## Existing Team Memories
${existingIndex || "(none)"}

## Recurrence candidates (not yet memories; never compile these)
${candidateIndex || "(none)"}
If this PR repeats the same rule as a candidate, set \`action\` to \`promote\` and \`candidate_id\` to \`C-xxx\` (or \`same_as\`).
A first-time style/process comment should be \`no_op\` (it will be stored as a candidate). A clearly reusable path-scoped rule may still be \`new\`.

---

Your task: Decide if this PR contains reusable engineering knowledge worth capturing.

A memory must have:
1. Observable trigger condition (when to apply it)
2. Decision it changes (not just facts)
3. Broader applicability beyond this specific PR

Reusability gate (required for new, promote, reuse and update):
- Name a future, different PR where this changes a decision. A repeated word or nearby file is not reuse.
- Can the rule stand without this PR's concrete filenames, variable names, API internals or one-off implementation steps?
- Is it an evidenced team convention, rather than a fact description or generic engineering advice?
Reject if any check fails; do not invent a broad policy by generalizing a local fix. Use no_op.
Positive examples (only when supported by human review):
1. For bug fixes, add a regression test that fails before the fix and exercises the real integration boundary.
2. When adding an API to documentation, mark its introduction version using the team's version annotation.
3. For implementation comments, explain only non-obvious rationale briefly; omit narration of the code.
Negative examples (one-off repairs, not standing team rules):
1. In the trace parser, subtract one from the mapped column and remove the browser-only snapshot branch.
2. Export this test provider object directly instead of wrapping it in a factory like the coverage provider.
3. Reset this mock constructor's prototype to the base object when switching back to its empty implementation.

New rules are stored as candidate, never immediately active. Promote proposes a reusable rule from a raw review candidate;
activation still requires the configured number of distinct subsequent PR citations. Existing candidate M-ids can be reused.
Only return reuse/update/merge when current human review actually applies the same rule; retrieval alone is not a citation.

You own where the rule applies. Output \`applies_to\` globs for the *rule*, not the file the comment happened to sit on.
Generic examples: \`src/auth/**\`, \`docs/**\`, \`**/*.css\`. Keep dot-directories. Do not copy an exact evidence filename unless that file *is* the rule.

Always set \`scope\` explicitly (do not leave it for the heuristic):
- \`always\` — the rule is about the PR itself (description, process, style) and should be in the root index
- \`triggered\` — the rule applies only under \`applies_to\`

Set \`triggers\` as machine-checkable conditions: glob AND optional \`contains\` (literal substring on added diff lines) AND optional \`pr\` (\`title:\` / \`body:\` / \`size:\` / \`files:>=N\`).

Choose ONE outcome (respond with ONLY the JSON, no other text):

\`\`\`json
{
  "action": "reuse|update|merge|propose_retire|new|promote|no_op",
  "memory_id": "M-xxx (if reuse/update/merge/propose_retire)",
  "candidate_id": "C-xxx (if promote / same as a recurrence candidate)",
  "same_as": "C-xxx",
  "title": "Short title (if new/update/promote)",
  "kind": "gotcha|decision|convention|map (if new)",
  "applies_to": ["src/auth/**"],
  "paths": ["alias of applies_to if you prefer"],
  "scope": "always|triggered",
  "triggers": [{"glob": "src/auth/**", "contains": "optional", "pr": "title:auth"}],
  "body": "≤120 words: trigger and decision change (if new/update)",
  "reasoning": "Why this action",
  "contradicts": false,
  "conflict_with": "M-xxx if this contradicts an existing memory",
  "memories": []
}
\`\`\`

If a new memory overlaps paths with an existing active memory and disagrees with it, set \`contradicts: true\` and \`conflict_with\` to that id. Do not silently drop either memory.

Actions:
- **reuse**: This PR validates an existing memory (no change needed)
- **update**: Strengthen/correct an existing memory with new evidence
- **merge**: Consolidate overlapping memories
- **propose_retire**: This PR shows a memory is outdated
- **new**: Create a new memory (max 3 per PR, only if clearly useful for future PRs)
- **promote**: This PR repeats recurrence candidate C-xxx — write a memory with evidence from both PRs
- **no_op**: No reusable knowledge (most PRs should be no_op; style comments wait for recurrence)

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
    applyAppliesTo(parsed);
    hydrateCandidateId(parsed);
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

export function applyAppliesTo(outcome: LearnOutcome): LearnOutcome {
  if ((!outcome.paths || outcome.paths.length === 0) && outcome.applies_to?.length) {
    outcome.paths = outcome.applies_to;
  }
  for (const child of outcome.memories ?? []) applyAppliesTo(child);
  return outcome;
}

export function hydrateCandidateId(outcome: LearnOutcome): LearnOutcome {
  if (!outcome.candidate_id && outcome.same_as) outcome.candidate_id = outcome.same_as;
  if (outcome.action === "new" && outcome.candidate_id) outcome.action = "promote";
  for (const child of outcome.memories ?? []) hydrateCandidateId(child);
  return outcome;
}

export function applyCandidateDecision(outcome: LearnOutcome, candidates: ReviewCandidate[]): LearnOutcome {
  hydrateCandidateId(outcome);
  if (outcome.candidate_id && candidates.some((candidate) => candidate.id === outcome.candidate_id)) {
    outcome.action = "promote";
  }
  for (const child of outcome.memories ?? []) applyCandidateDecision(child, candidates);
  return outcome;
}

export function maybePromoteFromCandidates(
  outcome: LearnOutcome,
  candidates: ReviewCandidate[],
  _context: PullRequestContext,
  _options?: { deterministic?: boolean },
): LearnOutcome {
  applyCandidateDecision(outcome, candidates);
  return outcome;
}

export function distinctEvidencePrs(...values: Array<string | string[] | undefined>): string[] {
  const found: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const number = item.replace(/^#/, "").trim();
      if (number) found.push(`#${number}`);
    }
  }
  return unique(found);
}

export function allowAlways(
  pathsSource: PathsSource | undefined,
  prs: string[],
  reviewers: string[] = [],
): boolean {
  if (pathsSource === "human") return true;
  // Same maintainer repeating a process rule on >=3 distinct PRs is strong evidence too (e.g. vitest's AI-disclosure policy).
  return (prs.length >= 2 && unique(reviewers).length >= 2) || prs.length >= 3;
}

export function gateAlwaysScope(
  requested: MemoryScope,
  pathsSource: PathsSource | undefined,
  prs: string[],
  reviewers: string[] = [],
): { scope: MemoryScope; downgraded: boolean } {
  if (requested !== "always") return { scope: requested, downgraded: false };
  if (allowAlways(pathsSource, prs, reviewers)) return { scope: "always", downgraded: false };
  return { scope: "triggered", downgraded: true };
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
  trackedFiles: string[] = [],
  experimentalPaths = false,
  reviewCandidates: ReviewCandidate[] = [],
  usageOptions: { threshold?: number; retrievedIds?: string[] } = {},
): LearnPlan {
  const lessons = (raw.memories && raw.memories.length > 0 ? raw.memories : [raw])
    .map((outcome) => applyCandidateDecision(outcome, reviewCandidates))
    .map((outcome) => forceUpdateIfDuplicate(outcome, existing))
    .slice(0, MAX_LEARN_PER_PR);

  const threshold = usageOptions.threshold ?? 2;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || !Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error("promotion_min_prs must be a positive integer and review_ttl_days must be positive");
  }
  const mutations: FileMutation[] = [];
  let idleRetired = 0;
  const working = existing.map(memory => {
    let frontmatter = retireIfIdle(memory.frontmatter, isoDate(), ttlDays);
    if (frontmatter.status !== memory.frontmatter.status) idleRetired++;
    if (usageOptions.retrievedIds?.includes(frontmatter.id)) frontmatter = recordRetrieval(frontmatter, isoDate());
    if (frontmatter !== memory.frontmatter) mutations.push({ path: memory.filepath, content: formatMemory(frontmatter, memory.body) });
    return { ...memory, frontmatter };
  });
  existing = working;
  const outcomes: LearnOutcome[] = [];
  const conflicts: PathConflict[] = [];
  const scope_notes: string[] = [];
  let learned = 0;
  let updated = 0;
  let retired = idleRetired;
  const usedIds = existing.map((memory) => memory.frontmatter.id);
  let activeCount = existing.filter((memory) => memory.frontmatter.status === "active").length;

  for (const outcome of lessons) {
    if (outcome.action === "no_op") {
      outcomes.push(outcome);
      continue;
    }

    const planned = planOne(outcome, existing, context, projectDir, usedIds, ttlDays, trackedFiles, experimentalPaths, reviewCandidates);
    outcomes.push(planned.outcome);
    for (const mutation of planned.mutations) {
      if (mutation.content) {
        const parsed = parseMemory(mutation.content);
        if (parsed) {
          let fm = parsed.frontmatter;
          const previous = existing.find(m => m.frontmatter.id === fm.id);
          if (["candidate", "active"].includes(fm.status) && ["reuse", "update", "merge", "promote"].includes(outcome.action)) {
            fm = recordCitation(fm, context.number, isoDate(), threshold);
          }
          if (fm.status === "active" && previous?.frontmatter.status !== "active") {
            if (activeCount >= MAX_ACTIVE_MEMORIES) fm = { ...fm, status: "candidate" };
            else activeCount++;
          }
          mutation.content = formatMemory(fm, parsed.body);
          const next = { frontmatter: fm, body: parsed.body, filepath: mutation.path };
          if (previous) existing[existing.indexOf(previous)] = next;
          else existing.push(next);
        }
      }
      // Last mutation for a file wins, including retrieval metadata plus a citation.
      const index = mutations.findIndex(item => item.path === mutation.path);
      if (index >= 0) mutations[index] = mutation;
      else mutations.push(mutation);
    }
    if (planned.scopeNote) scope_notes.push(planned.scopeNote);
    learned += planned.learned;
    updated += planned.updated;
    retired += planned.retired;
    activeCount = existing.filter(m => m.frontmatter.status === "active").length;
    usedIds.push(...planned.usedIds);
    conflicts.push(...detectConflicts(planned.outcome, existing));
  }

  const action = summarizeAction(outcomes);
  return {
    action,
    outcomes,
    mutations,
    learned,
    updated,
    retired,
    conflicts,
    scope_notes,
    distiller: "llm",
    summary: buildSummary(learned, updated, retired, context.number),
    candidates_recorded: 0,
  };
}

export function pathsOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => a === b || globPrefixesOverlap(a, b)));
}

function globPrefixesOverlap(a: string, b: string): boolean {
  const strip = (glob: string) => glob.replace(/\*\*.*$/, "").replace(/\/$/, "");
  const left = strip(a);
  const right = strip(b);
  if (!left || !right) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function detectConflicts(outcome: LearnOutcome, existing: Memory[]): PathConflict[] {
  if (outcome.action !== "new" || !outcome.contradicts) return [];
  const paths = outcome.paths ?? [];
  const hinted = outcome.conflict_with;
  const overlaps = existing
    .filter((memory) => memory.frontmatter.status === "active")
    .filter((memory) => memory.frontmatter.id !== outcome.memory_id)
    .filter((memory) => pathsOverlap(paths, memory.frontmatter.paths))
    .filter((memory) => !hinted || memory.frontmatter.id === hinted);
  const targets = overlaps;
  return targets.map((memory) => ({
    memory_id: outcome.memory_id || "new",
    existing_id: memory.frontmatter.id,
  }));
}

function planOne(
  outcome: LearnOutcome,
  existing: Memory[],
  context: PullRequestContext,
  projectDir: string,
  usedIds: string[],
  ttlDays: number,
  trackedFiles: string[],
  experimentalPaths: boolean,
  reviewCandidates: ReviewCandidate[],
): { outcome: LearnOutcome; mutations: FileMutation[]; learned: number; updated: number; retired: number; usedIds: string[]; scopeNote?: string } {
  const created = isoDate();
  const evidence = {
    pr: `#${context.number}`,
    review_url: context.url || undefined,
    commits: context.commits.slice(0, 5),
  };

  if (outcome.action === "new" || outcome.action === "promote") {
    const matched = outcome.action === "promote"
      ? reviewCandidates.find((candidate) => candidate.id === outcome.candidate_id)
      : undefined;
    if (outcome.action === "promote" && !matched) {
      return {
        outcome: { ...outcome, action: "no_op", reasoning: `Unknown candidate ${outcome.candidate_id}` },
        mutations: [],
        learned: 0,
        updated: 0,
        retired: 0,
        usedIds: [],
      };
    }
    if (matched?.promoted_to) {
      const target = existing.find((memory) => memory.frontmatter.id === matched.promoted_to);
      if (target) {
        return planOne({ ...outcome, action: "update", memory_id: target.frontmatter.id }, existing,
          context, projectDir, usedIds, ttlDays, trackedFiles, experimentalPaths, reviewCandidates);
      }
    }
    const reviewer = matchingReviewer(context, matched, outcome.body);
    const id = generateMemoryId(usedIds);
    const title = outcome.title || firstLine(outcome.body || matched?.gist || "Untitled lesson");
    const body = clampBody(outcome.body || title);
    const inferFiles = unique([
      ...(matched?.files ?? []),
      ...context.files,
    ]);
    const resolved = experimentalPaths
      ? resolveMemoryPaths(outcome.paths, trackedFiles, unique([...(matched?.files ?? []), ...evidenceFiles(context)]))
      : {
        paths: outcome.paths?.length ? outcome.paths : inferPathsV02(inferFiles),
        source: (outcome.paths?.length ? "distiller" : "inferred") as PathsSource,
      };
    const paths = resolved.paths;
    const prs = distinctEvidencePrs(matched?.pr, `#${context.number}`);
    const reviewers = unique([matched?.reviewer, reviewer]);
    const requested = outcome.scope ?? defaultScope(paths, body);
    const gated = gateAlwaysScope(requested, resolved.source, prs, reviewers);
    const frontmatter: MemoryFrontmatter = {
      id,
      kind: (outcome.kind as MemoryKind) || inferKind(body),
      paths,
      paths_source: resolved.source,
      scope: gated.scope,
      ...(outcome.triggers && outcome.triggers.length > 0 ? { triggers: outcome.triggers } : {}),
      evidence: { ...evidence, prs, reviewers },
      author: reviewer,
      created,
      review_after: reviewAfterDate(created, ttlDays),
      status: "candidate",
      usage: emptyUsage(matched?.pr ?? context.number),
    };
    const filename = memoryFilename(id, title);
    return {
      outcome: { ...outcome, memory_id: id, title, body, candidate_id: matched?.id ?? outcome.candidate_id },
      mutations: [{
        path: path.join(projectDir, ".memory", "memories", filename),
        content: formatMemory(frontmatter, body),
      }],
      learned: 1,
      updated: 0,
      retired: 0,
      usedIds: [id],
      scopeNote: gated.downgraded
        ? `${id}: always → triggered (needs ≥2 distinct PRs and ≥2 distinct reviewers unless human-authored; seen ${prs.join(", ")} / ${reviewers.join(", ") || "—"})`
        : undefined,
    };
  }

  const target = existing.find((memory) => memory.frontmatter.id === outcome.memory_id);
  if (!target || !["candidate", "active"].includes(target.frontmatter.status)) {
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
    return {
      outcome,
      mutations: [
        { path: target.filepath, content: formatMemory(retired, target.body) },
      ],
      learned: 0,
      updated: 0,
      retired: 1,
      usedIds: [],
    };
  }

  return planUpdate(outcome, target, context, created, evidence, ttlDays, trackedFiles, experimentalPaths);
}

export function matchingReviewer(
  context: PullRequestContext,
  matched?: ReviewCandidate,
  body?: string,
): string {
  const comments = context.reviewer_comments ?? [];
  const needle = body || matched?.gist || "";
  if (needle) {
    const gist = normalizeGist(needle);
    const terms = extractTerms(needle);
    const hit = comments.find((comment) => normalizeGist(comment.body) === gist)
      || comments.find((comment) => {
        const shared = extractTerms(comment.body).filter((term) => terms.includes(term));
        return shared.length >= 3;
      });
    if (hit) return hit.author;
  }
  if (comments.length > 0) return comments[comments.length - 1]!.author;
  return matched?.reviewer
    || context.author
    || "teamrecall";
}

function planUpdate(
  outcome: LearnOutcome,
  target: Memory,
  context: PullRequestContext,
  created: string,
  evidence: { pr: string; review_url?: string; commits: string[] },
  ttlDays: number,
  trackedFiles: string[],
  experimentalPaths: boolean,
  extra?: { extraPr?: string; extraReviewer?: string },
): { outcome: LearnOutcome; mutations: FileMutation[]; learned: number; updated: number; retired: number; usedIds: string[]; scopeNote?: string } {
  const resolved = outcome.paths && outcome.paths.length > 0
    ? (experimentalPaths
      ? resolveMemoryPaths(outcome.paths, trackedFiles, evidenceFiles(context))
      : { paths: outcome.paths, source: "distiller" as PathsSource })
    : undefined;
  const paths = resolved?.paths ?? target.frontmatter.paths;
  const pathsSource = resolved?.source ?? target.frontmatter.paths_source ?? "human";
  const prs = distinctEvidencePrs(target.frontmatter.evidence.prs, target.frontmatter.evidence.pr, extra?.extraPr, `#${context.number}`);
  const reviewers = unique([
    ...(target.frontmatter.evidence.reviewers ?? []),
    extra?.extraReviewer,
    matchingReviewer(context, undefined, outcome.body),
  ]);
  const requested = outcome.scope ?? target.frontmatter.scope ?? defaultScope(paths, target.body);
  const gated = gateAlwaysScope(requested, pathsSource, prs, reviewers);
  const nextFrontmatter: MemoryFrontmatter = {
    ...target.frontmatter,
    usage: target.frontmatter.usage ?? emptyUsage(target.frontmatter.evidence?.pr),
    paths,
    paths_source: pathsSource,
    scope: gated.scope,
    triggers: outcome.triggers ?? target.frontmatter.triggers,
    evidence: {
      ...target.frontmatter.evidence,
      ...evidence,
      prs,
      reviewers,
      commits: unique([
        ...(target.frontmatter.evidence.commits ?? []),
        ...evidence.commits,
      ]).slice(0, 8),
    },
    review_after: reviewAfterDate(created, ttlDays),
  };
  const body = outcome.action === "reuse" ? target.body : clampBody(outcome.body || target.body);
  return {
    outcome: { ...outcome, action: outcome.action === "promote" ? "update" : outcome.action, memory_id: target.frontmatter.id },
    mutations: [{ path: target.filepath, content: formatMemory(nextFrontmatter, body) }],
    learned: 0,
    updated: 1,
    retired: 0,
    usedIds: [],
    scopeNote: gated.downgraded
      ? `${target.frontmatter.id}: always → triggered (needs ≥2 distinct PRs and ≥2 distinct reviewers unless human-authored; seen ${prs.join(", ")} / ${reviewers.join(", ") || "—"})`
      : undefined,
  };
}

export function buildLearnPrTitle(
  learned: number,
  updated: number,
  prNumber: string,
  retired = 0,
  candidatesRecorded = 0,
): string {
  const parts: string[] = [];
  if (learned) parts.push(`learned ${learned}`);
  if (updated) parts.push(`updated ${updated}`);
  if (retired) parts.push(`retired ${retired}`);
  if (parts.length === 0 && candidatesRecorded > 0) {
    return `🧠 teamrecall: recorded ${candidatesRecorded} candidate${candidatesRecorded === 1 ? "" : "s"} (from #${prNumber})`;
  }
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
    ...(context.merged
      ? []
      : [
          "",
          "This PR was closed without merging. Human review comments are treated as evidence the same way as on merged PRs.",
        ]),
    "",
    "| Memory | Action | PR | Review | Commits |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Only `.memory/` and compiled agent files are touched.",
    "",
    plan.outcomes.map((outcome) => `- **${outcome.action}** ${outcome.memory_id ?? ""}: ${outcome.reasoning}`).join("\n"),
    ...scopeNotesSection(plan),
    ...deterministicSection(plan),
    ...conflictSections(plan),
  ].join("\n");
}

export const DETERMINISTIC_DISTILLER_NOTE = [
  "This run used the **deterministic recorder** because neither `CLAUDE_CODE_OAUTH_TOKEN` nor `OPENAI_API_KEY` was set.",
  "Zero-secret mode only records recurrence candidates and compiles existing hand-written memories.",
  "Recurrence promotion needs an LLM engine (`claude` / `codex` CLI, or `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY`).",
].join("\n");

export const LLM_FAILED_DISTILLER_NOTE = [
  "This run used the **deterministic recorder** because the LLM call failed.",
  "Candidates were recorded; no memory was auto-written. The failure is not the same as having no LLM secret set.",
].join("\n");

function scopeNotesSection(plan: LearnPlan): string[] {
  if (plan.scope_notes.length === 0) return [];
  return ["", "## Scope", "", ...plan.scope_notes.map((note) => `- ${note}`)];
}

function deterministicSection(plan: LearnPlan): string[] {
  if (plan.distiller !== "deterministic") return [];
  const note = plan.distiller_reason === "llm_failed"
    ? LLM_FAILED_DISTILLER_NOTE
    : DETERMINISTIC_DISTILLER_NOTE;
  return ["", "## Distiller", "", note];
}

function conflictSections(plan: LearnPlan): string[] {
  if (plan.conflicts.length === 0) return [];
  const lines = ["", "## Possible conflicts"];
  for (const conflict of plan.conflicts) {
    lines.push("", `### Possible conflict with ${conflict.existing_id}`);
    lines.push(`Newly proposed ${conflict.memory_id} overlaps paths with ${conflict.existing_id} and the distiller marked it as contradicting.`);
    lines.push("Review both memories before merging; do not silently keep both if they disagree.");
  }
  return lines;
}

export function fallbackOutcomeFromReviews(context: PullRequestContext): LearnOutcome {
  if ((context.reviewer_comments ?? []).length === 0) {
    return { action: "no_op", reasoning: "No eligible reviewer comments" };
  }
  return {
    action: "no_op",
    reasoning: "Zero-secret mode records candidates only; recurrence promotion needs an LLM engine",
  };
}

function inferKind(body: string): MemoryKind {
  if (/\b(never|gotcha|pitfall|don't|do not)\b/i.test(body)) return "gotcha";
  if (/\b(we decided|decision|choose|prefer)\b/i.test(body)) return "decision";
  if (/\b(lives in|see |map|located)\b/i.test(body)) return "map";
  return "convention";
}

export function evidenceFiles(context: PullRequestContext): string[] {
  return context.evidence_files.length > 0 ? context.evidence_files : context.files;
}

/** Only true repo-wide globs. Extension globs such as star-star/*.test.ts stay specific. */
export function isRepoWideGlob(glob: string): boolean {
  const normalized = glob.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized === "**" || normalized === "**/*" || normalized === "*";
}

export function isOverlyBroadTopLevel(glob: string): boolean {
  return isRepoWideGlob(glob);
}

export function globCoverage(glob: string, files: string[]): number {
  if (files.length === 0) return 0;
  return files.filter((file) => globMatches(glob, file)).length / files.length;
}

export const MAX_INFER_PATH_GLOBS = 5;
const WORKSPACE_ROOTS = new Set(["packages", "crates", "apps"]);

function deepestCommonDir(files: string[]): string {
  const parts = files.map((file) => file.split("/").slice(0, -1));
  if (parts.length === 0) return "";
  let prefix = parts[0] ?? [];
  for (const next of parts.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < next.length && prefix[i] === next[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) return "";
  }
  return prefix.join("/");
}

function isTooShallow(dir: string): boolean {
  if (!dir) return true;
  const parts = dir.split("/").filter(Boolean);
  return Boolean(WORKSPACE_ROOTS.has(parts[0] ?? "") && parts.length < 2);
}

function packageDir(file: string): string {
  const parts = file.split("/");
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return "";
  if (WORKSPACE_ROOTS.has(dirs[0] ?? "") && dirs.length >= 2) return `${dirs[0]}/${dirs[1]}`;
  return dirs.join("/");
}

function extensionOf(file: string): string {
  const slash = file.lastIndexOf("/");
  const dot = file.lastIndexOf(".");
  return dot > slash ? file.slice(dot) : "";
}

interface PathGroup {
  dir: string;
  files: string[];
}

function mergeGroups(groups: PathGroup[], max: number): PathGroup[] {
  let next = [...groups];
  while (next.length > max) {
    let bestI = -1;
    let bestJ = -1;
    let bestDir = "";
    let bestDepth = -1;
    for (let i = 0; i < next.length; i++) {
      for (let j = i + 1; j < next.length; j++) {
        const ancestor = deepestCommonDir([...next[i]!.files, ...next[j]!.files]);
        if (!ancestor || isTooShallow(ancestor)) continue;
        const depth = ancestor.split("/").length;
        if (depth > bestDepth) {
          bestDepth = depth;
          bestI = i;
          bestJ = j;
          bestDir = ancestor;
        }
      }
    }
    if (bestI < 0) {
      const ancestor = deepestCommonDir(next.flatMap((group) => group.files));
      if (ancestor && !isTooShallow(ancestor)) {
        return [{ dir: ancestor, files: next.flatMap((group) => group.files) }];
      }
      next.sort((a, b) => b.files.length - a.files.length || a.dir.localeCompare(b.dir));
      next = next.slice(0, max);
      break;
    }
    const merged: PathGroup = {
      dir: bestDir,
      files: [...next[bestI]!.files, ...next[bestJ]!.files],
    };
    next = next.filter((_, index) => index !== bestI && index !== bestJ);
    next.push(merged);
  }
  return next;
}

/** v0.2 default: top-level directory globs, or repo-wide if only root/dot files. */
export function inferPathsV02(files: string[]): string[] {
  const dirs = files
    .map((file) => file.split("/")[0])
    .filter((part) => part && !part.startsWith("."));
  const uniqueDirs = unique(dirs).slice(0, 2);
  if (uniqueDirs.length === 0) return ["**/*"];
  return uniqueDirs.map((dir) => `${dir}/**/*`);
}

export function inferPaths(files: string[], experimental = false): string[] {
  return experimental ? inferPathsExperimental(files) : inferPathsV02(files);
}

/** Narrower inference used when experimental.retrieval / --experimental-paths is on. */
export function inferPathsExperimental(files: string[]): string[] {
  const normalized = unique(files.map((item) => item.replaceAll("\\", "/")).filter(Boolean));
  if (normalized.length === 0) return [];

  const globs: string[] = [];
  const nested: string[] = [];
  for (const file of normalized) {
    if (file.includes("/")) nested.push(file);
    else globs.push(file);
  }

  if (nested.length > 0) {
    const common = deepestCommonDir(nested);
    const groups: PathGroup[] = [];
    if (common && !isTooShallow(common)) {
      groups.push({ dir: common, files: nested });
    } else {
      const byPackage = new Map<string, string[]>();
      for (const file of nested) {
        const dir = packageDir(file);
        if (!dir) continue;
        const group = byPackage.get(dir) ?? [];
        group.push(file);
        byPackage.set(dir, group);
      }
      for (const [dir, groupFiles] of byPackage) groups.push({ dir, files: groupFiles });
    }
    const capped = mergeGroups(groups, Math.max(1, MAX_INFER_PATH_GLOBS - globs.length));
    for (const group of capped) globs.push(`${group.dir}/**`);
    if (capped.length <= MAX_INFER_PATH_GLOBS) {
      for (const group of capped) {
        if (globs.length >= MAX_INFER_PATH_GLOBS) break;
        const exts = unique(group.files.map(extensionOf).filter(Boolean));
        if (exts.length === 1) globs.push(`${group.dir}/**/*${exts[0]}`);
      }
    }
  }

  return unique(globs).slice(0, MAX_INFER_PATH_GLOBS);
}

export function resolveMemoryPaths(
  proposed: string[] | undefined,
  tracked: string[],
  evidence: string[],
): { paths: string[]; source: PathsSource } {
  const candidates = unique((proposed ?? []).map((glob) => glob.replaceAll("\\", "/")));
  if (candidates.length === 0) return { paths: inferPathsExperimental(evidence), source: "inferred" };
  const universe = unique([...tracked, ...evidence]);
  const specific: string[] = [];
  let sawRepoWide = false;
  for (const glob of candidates) {
    if (isRepoWideGlob(glob)) {
      sawRepoWide = true;
      continue;
    }
    if (universe.length === 0 || universe.some((file) => globMatches(glob, file))) {
      specific.push(glob);
    }
  }
  if (specific.length > 0) return { paths: specific, source: "distiller" };
  if (sawRepoWide) return { paths: ["**"], source: "distiller" };
  return { paths: inferPathsExperimental(evidence), source: "inferred" };
}

export function keepSpecificPaths(
  proposed: string[] | undefined,
  tracked: string[],
  evidence: string[],
): string[] {
  return resolveMemoryPaths(proposed, tracked, evidence).paths;
}

function summarizeAction(outcomes: LearnOutcome[]): LearnOutcome["action"] {
  if (outcomes.some((outcome) => outcome.action === "new" || outcome.action === "promote")) return "new";
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

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
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
