import { COMPILE_TRIGGERED_CAP } from "./constants.js";
import { loadConfig, loadMemories, memoryScope } from "./memory.js";
import { globMatches } from "./sweep.js";
import type { Memory, MemoryTrigger, PathsSource } from "./types.js";

export const DEFAULT_RETRIEVE_K = 5;
export const DEFAULT_ALWAYS_CAP = 8;
export const PATH_BOOST = 8;
export const TRIGGER_CONTAINS_BOOST = 4;
/** Soft bump for inferred path hits; never a hard tier (stays in [0, 1+boost]). */
export const INFERRED_PATH_BOOST = 0.25;

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

export function matchContains(needle: string, haystack: string): boolean {
  const trimmed = needle.trim();
  if (!trimmed) return false;
  return haystack.toLowerCase().includes(trimmed.toLowerCase());
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

function isRepoWideGlob(glob: string): boolean {
  const normalized = glob.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized === "**" || normalized === "**/*" || normalized === "*";
}

export function pathMatches(memory: Memory, files: string[]): boolean {
  const globs = [
    ...memory.frontmatter.paths,
    ...(memory.frontmatter.triggers ?? []).map((trigger) => trigger.glob),
  ].filter((glob) => glob && !isRepoWideGlob(glob));
  return globs.some((glob) => files.some((file) => globMatches(glob, file)));
}

export function isTrustedPathSource(source: PathsSource | undefined): boolean {
  return source !== "inferred";
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

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface Bm25Index {
  n: number;
  avgdl: number;
  df: Map<string, number>;
  tfs: Array<Map<string, number>>;
  lengths: number[];
  postings: Map<string, number[]>;
}

export function buildBm25Index(documents: string[][]): Bm25Index {
  const n = documents.length;
  const df = new Map<string, number>();
  const tfs: Array<Map<string, number>> = [];
  const lengths: number[] = [];
  const postings = new Map<string, number[]>();
  for (let index = 0; index < documents.length; index++) {
    const doc = documents[index] ?? [];
    lengths.push(doc.length);
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    tfs.push(tf);
    for (const token of tf.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
      const posting = postings.get(token);
      if (posting) posting.push(index);
      else postings.set(token, [index]);
    }
  }
  const avgdl = (lengths.reduce((sum, len) => sum + len, 0) / (n || 1)) || 1;
  return { n, avgdl, df, tfs, lengths, postings };
}

export function bm25ScoresFromIndex(queryTokens: string[], index: Bm25Index): number[] {
  const scores = new Array<number>(index.n).fill(0);
  if (index.n === 0) return scores;
  for (const token of new Set(queryTokens)) {
    const nq = index.df.get(token) ?? 0;
    if (nq === 0) continue;
    const idf = Math.log(1 + (index.n - nq + 0.5) / (nq + 0.5));
    for (const docIndex of index.postings.get(token) ?? []) {
      const freq = index.tfs[docIndex]?.get(token) ?? 0;
      const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * ((index.lengths[docIndex] ?? 0) / index.avgdl));
      scores[docIndex] += idf * ((freq * (BM25_K1 + 1)) / denom);
    }
  }
  return scores;
}

export function bm25Scores(queryTokens: string[], documents: string[][]): number[] {
  return bm25ScoresFromIndex(queryTokens, buildBm25Index(documents));
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
  const raw = bm25ScoresFromIndex(query, buildBm25Index(memories.map(documentTokens)));
  const max = Math.max(0, ...raw);
  const ranked = memories.map((memory, index) => {
    const bm25 = max > 0 ? (raw[index] ?? 0) / max : 0;
    let tier = 0;
    let reason: RetrievedMemory["reason"] = alwaysReason ? "always" : "bm25";
    if (!alwaysReason) {
      const pathHit = pathMatches(memory, input.files);
      const trusted = isTrustedPathSource(memory.frontmatter.paths_source);
      if (pathHit && trusted) {
        tier = 1;
        reason = "glob";
      }
      if (triggerContainsMatches(memory, input)) {
        tier = 2;
        reason = "trigger";
      }
      const inferredHit = pathHit && !trusted && tier === 0;
      return {
        memory,
        tier,
        bm25: bm25 + (inferredHit ? INFERRED_PATH_BOOST : 0),
        reason,
      };
    }
    return { memory, tier, bm25, reason };
  });
  ranked.sort((a, b) => b.tier - a.tier || b.bm25 - a.bm25 || a.memory.frontmatter.id.localeCompare(b.memory.frontmatter.id));
  return ranked.map((item) => toRetrieved(item.memory, item.tier * 2 + item.bm25, item.reason));
}

export async function runRetrieve(input: RetrieveInput): Promise<RetrieveResult> {
  const memories = (input.memories ?? (input.projectDir ? await loadMemories(input.projectDir) : []))
    .filter((memory) => memory.frontmatter.status === "active");
  // Triggered memories are clamped to COMPILE_TRIGGERED_CAP (10) per query.
  const k = Math.min(input.k ?? DEFAULT_RETRIEVE_K, COMPILE_TRIGGERED_CAP);
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
