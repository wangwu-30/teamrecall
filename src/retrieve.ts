import { defaultScope, loadMemories, memoryScope } from "./memory.js";
import { globMatches } from "./sweep.js";
import type { Memory, MemoryTrigger } from "./types.js";

export const DEFAULT_RETRIEVE_K = 5;

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with",
  "this", "that", "from", "only", "use", "used", "using", "into", "be",
  "is", "are", "it", "as", "by", "at", "if", "not", "no", "yes",
]);

const GENERIC_PATH_TOKENS = new Set([
  "src", "lib", "test", "tests", "packages", "crates", "apps", "md", "ts", "js",
]);

export interface RetrieveInput {
  projectDir?: string;
  memories?: Memory[];
  files: string[];
  diff?: string;
  title?: string;
  body?: string;
  k?: number;
}

export interface RetrievedMemory {
  id: string;
  title: string;
  body: string;
  scope: "always" | "triggered";
  paths: string[];
  score: number;
  reason: "always" | "trigger" | "glob" | "bm25";
}

export interface RetrieveResult {
  k: number;
  always: RetrievedMemory[];
  matched: RetrievedMemory[];
  memories: RetrievedMemory[];
}

export function tokenize(text: string): string[] {
  const raw = text.split(/[^A-Za-z0-9]+/).flatMap(splitIdent);
  return raw
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !STOP.has(token));
}

function splitIdent(word: string): string[] {
  return word
    .split(/_+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));
}

export function addedLinesFromDiff(diff: string): string[] {
  const lines: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) lines.push(line.slice(1));
  }
  return lines;
}

export function matchContains(needle: string, haystack: string): boolean {
  const trimmed = needle.trim();
  if (!trimmed) return false;
  const wrapped = trimmed.match(/^\/(.+)\/([a-z]*)$/s);
  try {
    const re = wrapped
      ? new RegExp(wrapped[1], wrapped[2] || "i")
      : new RegExp(trimmed, "i");
    return re.test(haystack);
  } catch {
    return haystack.toLowerCase().includes(trimmed.toLowerCase());
  }
}

export function triggerMatches(
  trigger: MemoryTrigger,
  input: { files: string[]; diff?: string; title?: string; body?: string },
): boolean {
  const globHit = input.files.some((file) => globMatches(trigger.glob, file))
    || trigger.glob === "**"
    || trigger.glob === "**/*";
  if (!globHit && trigger.contains === undefined && trigger.pr === undefined) return false;
  if (trigger.contains) {
    const added = addedLinesFromDiff(input.diff ?? "").join("\n");
    if (!matchContains(trigger.contains, added)) return false;
  }
  if (trigger.pr) {
    const hay = `${input.title ?? ""}\n${input.body ?? ""}\nfiles:${input.files.length}`;
    if (!matchContains(trigger.pr, hay)) return false;
  }
  if (trigger.contains || trigger.pr) return true;
  return globHit;
}

export function memoryMatchesQuery(memory: Memory, input: RetrieveInput): boolean {
  if (memoryScope(memory) === "always") return true;
  if (memory.frontmatter.triggers?.some((trigger) => triggerMatches(trigger, input))) return true;
  return memory.frontmatter.paths.some((glob) => input.files.some((file) => globMatches(glob, file)));
}

export function distinctiveTerms(memory: Memory): string[] {
  const terms: string[] = [];
  for (const glob of memory.frontmatter.paths) {
    for (const part of glob.split(/[^A-Za-z0-9.]+/)) {
      const token = part.replace(/^\./, "").toLowerCase();
      if (token && !GENERIC_PATH_TOKENS.has(token) && token !== "**") terms.push(token);
    }
  }
  for (const trigger of memory.frontmatter.triggers ?? []) {
    terms.push(...tokenize(trigger.glob));
    if (trigger.contains) terms.push(...tokenize(trigger.contains));
  }
  return terms;
}

export function bm25Scores(queryTokens: string[], documents: string[][]): number[] {
  const k1 = 1.5;
  const b = 0.75;
  const n = documents.length;
  if (n === 0) return [];
  const df = new Map<string, number>();
  const lengths = documents.map((doc) => doc.length);
  const avgdl = lengths.reduce((sum, len) => sum + len, 0) / n || 1;
  for (const doc of documents) {
    const seen = new Set(doc);
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const query = new Map<string, number>();
  for (const token of queryTokens) query.set(token, (query.get(token) ?? 0) + 1);

  return documents.map((doc, index) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const [token, qf] of query) {
      const freq = tf.get(token) ?? 0;
      if (freq === 0) continue;
      const nq = df.get(token) ?? 0;
      const idf = Math.log(1 + (n - nq + 0.5) / (nq + 0.5));
      const denom = freq + k1 * (1 - b + b * (lengths[index] / avgdl));
      score += qf * idf * ((freq * (k1 + 1)) / denom);
    }
    return score;
  });
}

function toRetrieved(memory: Memory, score: number, reason: RetrievedMemory["reason"]): RetrievedMemory {
  return {
    id: memory.frontmatter.id,
    title: titleOf(memory.body),
    body: memory.body,
    scope: memoryScope(memory),
    paths: memory.frontmatter.paths,
    score,
    reason,
  };
}

export async function runRetrieve(input: RetrieveInput): Promise<RetrieveResult> {
  const memories = (input.memories ?? (input.projectDir ? await loadMemories(input.projectDir) : []))
    .filter((memory) => memory.frontmatter.status === "active");
  const k = input.k ?? DEFAULT_RETRIEVE_K;
  const alwaysMemories = memories.filter((memory) => memoryScope(memory) === "always");
  const candidates = memories.filter((memory) => {
    if (memoryScope(memory) === "always") return false;
    return memoryMatchesQuery(memory, input);
  });

  const query = tokenize([
    ...input.files,
    input.title ?? "",
    input.body ?? "",
    ...addedLinesFromDiff(input.diff ?? ""),
  ].join(" "));

  const docs = candidates.map((memory) => tokenize(
    `${titleOf(memory.body)} ${memory.body} ${distinctiveTerms(memory).join(" ")}`,
  ));
  const scores = bm25Scores(query, docs);
  const ranked = candidates
    .map((memory, index) => {
      const triggerHit = memory.frontmatter.triggers?.some((trigger) => triggerMatches(trigger, input));
      return toRetrieved(
        memory,
        scores[index] ?? 0,
        triggerHit ? "trigger" : "glob",
      );
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);

  const always = alwaysMemories.map((memory) => toRetrieved(memory, 0, "always"));
  const seen = new Set(always.map((item) => item.id));
  const matched = ranked.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  return { k, always, matched, memories: [...always, ...matched] };
}

export function formatRetrieveText(result: RetrieveResult): string {
  const lines: string[] = [];
  if (result.always.length > 0) {
    lines.push("Always:");
    for (const item of result.always) {
      lines.push(`- ${item.id}: ${item.body.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  lines.push("Retrieved:");
  if (result.matched.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of result.matched) {
      lines.push(`- ${item.id} (${item.score.toFixed(3)}): ${item.title}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function titleOf(body: string): string {
  return body.trim().split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 80) || "";
}

export { defaultScope };
