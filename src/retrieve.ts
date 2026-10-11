import { loadConfig, loadMemories, memoryScope } from "./memory.js";
import { globMatches } from "./sweep.js";
import type { Memory, MemoryTrigger } from "./types.js";

export const DEFAULT_RETRIEVE_K = 5;
export const DEFAULT_ALWAYS_CAP = 8;
export const PATH_BOOST = 8;
export const TRIGGER_CONTAINS_BOOST = 4;
const MAX_CONTAINS_PATTERN = 80;
const MAX_CONTAINS_HAYSTACK = 50_000;

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
  alwaysCap?: number;
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
  always_cap: number;
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

function dangerousRegex(source: string): boolean {
  return source.length > MAX_CONTAINS_PATTERN
    || /[*+]{2,}|\{\d{3,}/.test(source)
    || /(\.\*){2,}/.test(source);
}

export function matchContains(needle: string, haystack: string): boolean {
  const trimmed = needle.trim();
  if (!trimmed) return false;
  const hay = haystack.length > MAX_CONTAINS_HAYSTACK
    ? haystack.slice(0, MAX_CONTAINS_HAYSTACK)
    : haystack;
  const wrapped = trimmed.match(/^\/([\s\S]+)\/([a-z]*)$/);
  if (!wrapped) {
    return hay.toLowerCase().includes(trimmed.toLowerCase());
  }
  const source = wrapped[1];
  const flags = wrapped[2] ?? "";
  if (dangerousRegex(source)) {
    return hay.toLowerCase().includes(source.toLowerCase());
  }
  try {
    const re = new RegExp(source, flags.includes("i") ? flags : `${flags}i`);
    return re.test(hay);
  } catch {
    return hay.toLowerCase().includes(source.toLowerCase());
  }
}

export function globHits(glob: string, files: string[]): boolean {
  if (glob === "**" || glob === "**/*") return true;
  return files.some((file) => globMatches(glob, file));
}

export interface PrSignalInput {
  files: string[];
  title?: string;
  body?: string;
}

export function prSignalMatches(signal: string, input: PrSignalInput): boolean {
  const trimmed = signal.trim();
  const named = trimmed.match(/^(title|body|size|files)\s*:\s*(.+)$/i);
  const field = named ? named[1].toLowerCase() : "text";
  const value = named ? named[2] : trimmed;
  const fileCount = input.files.length;
  if (field === "title") return matchContains(value, input.title ?? "");
  if (field === "body") return matchContains(value, input.body ?? "");
  if (field === "size") {
    const size = fileCount <= 3 ? "small" : fileCount <= 15 ? "medium" : "large";
    return size === value.trim().toLowerCase();
  }
  if (field === "files") {
    const cmp = value.trim().match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
    if (!cmp) return false;
    const n = Number(cmp[2]);
    const op = cmp[1] || "=";
    if (op === ">=") return fileCount >= n;
    if (op === "<=") return fileCount <= n;
    if (op === ">") return fileCount > n;
    if (op === "<") return fileCount < n;
    return fileCount === n;
  }
  return matchContains(value, `${input.title ?? ""}\n${input.body ?? ""}`);
}

export function triggerMatches(
  trigger: MemoryTrigger,
  input: { files: string[]; diff?: string; title?: string; body?: string },
): boolean {
  if (!globHits(trigger.glob, input.files)) return false;
  if (trigger.contains) {
    const added = addedLinesFromDiff(input.diff ?? "").join("\n");
    if (!matchContains(trigger.contains, added)) return false;
  }
  if (trigger.pr && !prSignalMatches(trigger.pr, input)) return false;
  return true;
}

export function pathMatches(memory: Memory, files: string[]): boolean {
  if (memory.frontmatter.paths.some((glob) => globHits(glob, files))) return true;
  return Boolean(memory.frontmatter.triggers?.some((trigger) => globHits(trigger.glob, files)));
}

export function triggerContainsMatches(
  memory: Memory,
  input: { files: string[]; diff?: string; title?: string; body?: string },
): boolean {
  return Boolean(memory.frontmatter.triggers?.some((trigger) => {
    if (!trigger.contains) return false;
    return triggerMatches(trigger, input);
  }));
}

export function distinctiveTerms(memory: Memory): string[] {
  const terms: string[] = [];
  for (const glob of memory.frontmatter.paths) terms.push(...tokenize(glob));
  for (const trigger of memory.frontmatter.triggers ?? []) {
    terms.push(...tokenize(trigger.glob));
    if (trigger.contains) terms.push(...tokenize(trigger.contains));
  }
  return terms.filter((token) => !GENERIC_PATH_TOKENS.has(token));
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

function documentTokens(memory: Memory): string[] {
  return tokenize(`${titleOf(memory.body)} ${memory.body} ${distinctiveTerms(memory).join(" ")}`);
}

function scoreMemories(
  memories: Memory[],
  query: string[],
  input: RetrieveInput,
  alwaysReason: boolean,
): RetrievedMemory[] {
  const scores = bm25Scores(query, memories.map(documentTokens));
  return memories.map((memory, index) => {
    let score = scores[index] ?? 0;
    let reason: RetrievedMemory["reason"] = alwaysReason ? "always" : "bm25";
    if (!alwaysReason) {
      if (pathMatches(memory, input.files)) {
        score += PATH_BOOST;
        reason = "glob";
      }
      if (triggerContainsMatches(memory, input)) {
        score += TRIGGER_CONTAINS_BOOST;
        reason = "trigger";
      }
    }
    return toRetrieved(memory, score, reason);
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export async function runRetrieve(input: RetrieveInput): Promise<RetrieveResult> {
  const memories = (input.memories ?? (input.projectDir ? await loadMemories(input.projectDir) : []))
    .filter((memory) => memory.frontmatter.status === "active");
  const k = input.k ?? DEFAULT_RETRIEVE_K;
  let alwaysCap = input.alwaysCap;
  if (alwaysCap === undefined && input.projectDir) {
    const config = await loadConfig(input.projectDir);
    alwaysCap = config.retrieve_always_cap ?? DEFAULT_ALWAYS_CAP;
  }
  alwaysCap = alwaysCap ?? DEFAULT_ALWAYS_CAP;

  const query = tokenize([
    ...input.files,
    input.title ?? "",
    input.body ?? "",
    ...addedLinesFromDiff(input.diff ?? ""),
  ].join(" "));

  const alwaysAll = memories.filter((memory) => memoryScope(memory) === "always");
  const triggered = memories.filter((memory) => memoryScope(memory) === "triggered");

  const always = scoreMemories(alwaysAll, query, input, true).slice(0, alwaysCap);
  const matched = scoreMemories(triggered, query, input, false).slice(0, k);

  return {
    k,
    always_cap: alwaysCap,
    always,
    matched,
    memories: [...always, ...matched],
  };
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
