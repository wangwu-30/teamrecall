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
import { defaultScope } from "./memory.js";
import { globMatches } from "./sweep.js";
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
  distiller: DistillerKind;
  distiller_reason?: DistillerReason;
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
    .map((memory) => `- ${memory.frontmatter.id}: ${firstLine(memory.body)} (paths: ${memory.frontmatter.paths.join(", ")}; scope: ${memory.frontmatter.scope ?? "—"})`)
    .join("\n");

  return `You are reviewing a closed pull request to extract reusable engineering knowledge for the team.
This PR may be merged or closed without merging. Human review comments are valid evidence either way.

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

You own where the rule applies. Output \`applies_to\` globs for the *rule*, not the file the comment happened to sit on.
Generic examples: \`src/auth/**\`, \`docs/**\`, \`**/*.css\`. Keep dot-directories. Do not copy an exact evidence filename unless that file *is* the rule.

Always set \`scope\` explicitly (do not leave it for the heuristic):
- \`always\` — the rule is about the PR itself (description, process, style) and should be in the root index
- \`triggered\` — the rule applies only under \`applies_to\`

Set \`triggers\` as machine-checkable conditions: glob AND optional \`contains\` (literal substring on added diff lines) AND optional \`pr\` (\`title:\` / \`body:\` / \`size:\` / \`files:>=N\`).

Choose ONE outcome (respond with ONLY the JSON, no other text):

\`\`\`json
{
  "action": "reuse|update|merge|propose_retire|new|no_op",
  "memory_id": "M-xxx (if reuse/update/merge/propose_retire)",
  "title": "Short title (if new/update)",
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
    if ((!parsed.paths || parsed.paths.length === 0) && parsed.applies_to?.length) {
      parsed.paths = parsed.applies_to;
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
  trackedFiles: string[] = [],
): LearnPlan {
  const candidates = (raw.memories && raw.memories.length > 0 ? raw.memories : [raw])
    .map((outcome) => forceUpdateIfDuplicate(outcome, existing))
    .slice(0, MAX_LEARN_PER_PR);

  const mutations: FileMutation[] = [];
  const outcomes: LearnOutcome[] = [];
  const conflicts: PathConflict[] = [];
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

    const planned = planOne(outcome, existing, context, projectDir, usedIds, ttlDays, trackedFiles);
    outcomes.push(planned.outcome);
    mutations.push(...planned.mutations);
    learned += planned.learned;
    updated += planned.updated;
    retired += planned.retired;
    activeCount += planned.learned - planned.retired;
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
    distiller: "llm",
    summary: buildSummary(learned, updated, retired, context.number),
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
    const paths = keepSpecificPaths(outcome.paths, trackedFiles, evidenceFiles(context));
    const scope = outcome.scope ?? defaultScope(paths, body);
    const frontmatter: MemoryFrontmatter = {
      id,
      kind: (outcome.kind as MemoryKind) || inferKind(body),
      paths,
      scope,
      ...(outcome.triggers && outcome.triggers.length > 0 ? { triggers: outcome.triggers } : {}),
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
    paths: outcome.paths && outcome.paths.length > 0
      ? keepSpecificPaths(outcome.paths, trackedFiles, evidenceFiles(context))
      : target.frontmatter.paths,
    scope: outcome.scope ?? target.frontmatter.scope,
    triggers: outcome.triggers ?? target.frontmatter.triggers,
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

export function buildLearnPrTitle(
  learned: number,
  updated: number,
  prNumber: string,
  retired = 0,
): string {
  const parts: string[] = [];
  if (learned) parts.push(`learned ${learned}`);
  if (updated) parts.push(`updated ${updated}`);
  if (retired) parts.push(`retired ${retired}`);
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
    ...deterministicSection(plan),
    ...conflictSections(plan),
  ].join("\n");
}

export const DETERMINISTIC_DISTILLER_NOTE = [
  "This run used the **deterministic distiller** because neither `CLAUDE_CODE_OAUTH_TOKEN` nor `OPENAI_API_KEY` was set.",
  "Day-one learn works with zero secrets. Set `CLAUDE_CODE_OAUTH_TOKEN` after `claude setup-token` to enable LLM distillation.",
].join("\n");

export const LLM_FAILED_DISTILLER_NOTE = [
  "This run used the **deterministic distiller** because the LLM call failed.",
  "The failure is not the same as having no LLM secret set.",
].join("\n");

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
  const directive = context.review_comments.find((comment) => isDirective(comment));
  if (!directive) {
    return { action: "no_op", reasoning: "No reusable directive in review comments" };
  }
  const body = clampBody(directive.replace(/\s+/g, " "));
  const paths = inferPaths(evidenceFiles(context));
  return {
    action: "new",
    title: firstLine(body),
    kind: inferKind(body),
    paths,
    scope: defaultScope(paths, body),
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

export function evidenceFiles(context: PullRequestContext): string[] {
  return context.evidence_files.length > 0 ? context.evidence_files : context.files;
}

/** Repo-wide globs with no directory prefix (star-star, *.md). Package-level dir/** is kept. */
export function isRepoWideGlob(glob: string): boolean {
  const normalized = glob.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized === "**"
    || normalized === "**/*"
    || normalized === "*"
    || /^\*\.[^/]+$/.test(normalized)
    || /^\*\*\/\*\.[^/]+$/.test(normalized);
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

export function inferPaths(files: string[]): string[] {
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
    for (const group of capped) {
      if (globs.length >= MAX_INFER_PATH_GLOBS) break;
      const exts = unique(group.files.map(extensionOf).filter(Boolean));
      if (exts.length === 1) globs.push(`${group.dir}/**/*${exts[0]}`);
    }
  }

  return unique(globs).slice(0, MAX_INFER_PATH_GLOBS);
}

export function keepSpecificPaths(
  proposed: string[] | undefined,
  tracked: string[],
  evidence: string[],
): string[] {
  const candidates = unique((proposed ?? []).map((glob) => glob.replaceAll("\\", "/")));
  if (candidates.length === 0) return inferPaths(evidence);
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
  if (specific.length > 0) return specific;
  if (sawRepoWide) return ["**"];
  return inferPaths(evidence);
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
