import { tokenize } from "./retrieve.js";

export const DEFAULT_DEDUP_SIMILARITY_THRESHOLD = 0.3;

const stem = (word: string): string => word.length > 4
  ? word.replace(/ies$/, "y").replace(/(?:ing|ed|s)$/, "") : word;
const STOP = new Set(`when should must please new existing team rule human review pr prs
changes change adding add its their without write include 当 在 时 应 需要 的`.split(/\s+/).map(stem));
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function terms(text: string): string[] {
  const english = tokenize(text.replace(/[\u3400-\u9fff]+/g, " "));
  const han = [...segmenter.segment(text)]
    .filter(part => part.isWordLike && part.segment.length >= 2 && /[\u3400-\u9fff]/.test(part.segment))
    .map(part => part.segment);
  return [...english, ...han].map(stem).filter(term => !STOP.has(term) && !/^\d+$/.test(term));
}

function frequencies(words: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of words) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function decision(text: string): string {
  // A common trigger (e.g. "when handling HTTP requests") is not a common decision.
  return text.replace(/^when\b[^,，]*[,，]\s*/i, "").replace(/^当[^,，]*[,，]\s*/, "");
}

function negativeHeads(text: string): Set<string> {
  const heads = new Set<string>();
  for (const match of text.matchAll(/(?:\b(?:not|never|no|don.t|without)\b\s*|不要|不应|禁止|无需)([^.,;!?。；]+)/gi)) {
    const head = terms(match[1]!)[0];
    if (head) heads.add(head);
  }
  return heads;
}

function polarityConflict(left: string, right: string): boolean {
  const a = new Set(terms(left)), b = new Set(terms(right));
  const na = negativeHeads(left), nb = negativeHeads(right);
  return [...na].some(term => b.has(term) && !nb.has(term))
    || [...nb].some(term => a.has(term) && !na.has(term));
}

function cosine(left: string, right: string): number {
  const a = frequencies(terms(decision(left))), b = frequencies(terms(decision(right)));
  const shared = [...a.keys()].filter(term => b.has(term));
  if (shared.length < 2) return 0;
  // Near-identical templates with a substituted subject (cursor vs offset) differ.
  if ([...a.keys()].filter(term => !b.has(term)).length === 1
    && [...b.keys()].filter(term => !a.has(term)).length === 1) return 0;
  const norm = (values: Map<string, number>) => Math.sqrt([...values.values()].reduce((sum, n) => sum + n * n, 0));
  return shared.reduce((sum, term) => sum + a.get(term)! * b.get(term)!, 0) / (norm(a) * norm(b));
}

/** Similarity alone is insufficient: require ordered equality, linked evidence,
 * or a shared complete phrase emphasized at least twice in one rule. No category dictionary. */
export function ruleSimilarity(left: string, right: string, linkedEvidence = false): number {
  if (!left.trim() || !right.trim() || polarityConflict(left, right)) return 0;
  // Keep word order and negation here; the retrieval tokenizer intentionally drops "not".
  const grammar = new Set(["when", "should", "must", "please", "当", "在", "时", "应", "需要", "的"]);
  const ordered = (text: string) => [...segmenter.segment(text.toLowerCase())]
    .filter(part => part.isWordLike && !grammar.has(part.segment))
    .map(part => stem(part.segment)).join(" ");
  if (ordered(left) === ordered(right)) return 1;
  const phrases = (text: string) => {
    const words = terms(text);
    return frequencies(words.slice(1).map((word, index) => `${words[index]} ${word}`));
  };
  const a = phrases(left), b = phrases(right);
  const emphasizedPhrase = [...a].some(([phrase, count]) => b.has(phrase) && Math.max(count, b.get(phrase)!) >= 2);
  if (!linkedEvidence && !emphasizedPhrase) return 0;
  const sentences = (text: string) => [text, ...text.split(/(?<=[.!?。])\s+/)];
  return Math.min(1, Math.max(...sentences(left).flatMap(l => sentences(right).map(r => cosine(l, r)))));
}

export function validateDedupThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error("dedup_similarity_threshold must be greater than 0 and at most 1");
  }
}
