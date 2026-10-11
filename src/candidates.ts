import { createHash } from "node:crypto";
import * as path from "node:path";
import { CANDIDATE_CAP, CANDIDATE_TTL_DAYS, CANDIDATES_FILENAME, GIST_MAX_CHARS } from "./constants.js";
import type { ReviewerComment } from "./human-comments.js";
import { isoDate } from "./memory.js";
import type { ReviewCandidate } from "./types.js";
import { exists, readText, writeAtomic } from "./utils/atomic.js";

const STOPWORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "your", "please", "just",
  "have", "been", "will", "are", "was", "were", "but", "not", "you", "our", "its",
  "into", "about", "than", "then", "they", "them", "can", "could", "would",
  "should", "also", "here", "there", "when", "what", "which", "who", "how",
  "a", "an", "of", "to", "in", "on", "at", "as", "or", "if", "be", "is", "it",
  "we", "i", "do", "does", "did", "don", "doesn", "only", "very", "more",
  "some", "any", "all", "each", "every", "http", "https", "www", "com", "org",
  "github", "pull", "issue", "pr", "comment", "comments", "review", "reviews",
  "function", "functions", "code", "file", "files", "change", "changes",
]);

export function candidatesPath(projectDir: string): string {
  return path.join(projectDir, ".memory", CANDIDATES_FILENAME);
}

export function stripHtml(text: string): string {
  return text
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ");
}

export function stripUrlsAndMentions(text: string): string {
  return stripHtml(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/@[a-z0-9_-]+/gi, " ");
}

export function normalizeGist(text: string): string {
  return stripUrlsAndMentions(text)
    .replace(/(?:```|~~~)suggestion[^\n]*\n?([\s\S]*?)(?:```|~~~)/gi, " suggestion $1 ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, " $1 ")
    .toLowerCase()
    .replace(/[^a-z0-9.\s'<>\/_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GIST_MAX_CHARS);
}

export function toImperativeBody(text: string): string {
  let next = stripUrlsAndMentions(text).replace(/\s+/g, " ").trim();
  next = next.replace(/^please\s+/i, "");
  if (!next) return "";
  next = next.charAt(0).toUpperCase() + next.slice(1);
  return next;
}

export function extractTerms(text: string): string[] {
  return unique(
    stripUrlsAndMentions(text)
      .toLowerCase()
      .replace(/[0-9a-f]{7,}/g, " ")
      .replace(/[0-9]+/g, " ")
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

export function normalizePr(pr: string): string {
  return pr.replace(/^#/, "").trim();
}

export function generateCandidateId(gist: string, pr: string, reviewer: string): string {
  const digest = createHash("sha1")
    .update(`${gist}\0${normalizePr(pr)}\0${reviewer.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
  return `C-${digest}`;
}

export function parseCandidatesJsonl(text: string): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ReviewCandidate;
      if (isValidCandidate(parsed)) candidates.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return candidates;
}

export function serializeCandidatesJsonl(candidates: ReviewCandidate[]): string {
  if (candidates.length === 0) return "";
  return `${candidates.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`;
}

export async function loadCandidates(projectDir: string): Promise<ReviewCandidate[]> {
  const filepath = candidatesPath(projectDir);
  if (!(await exists(filepath))) return [];
  return parseCandidatesJsonl(await readText(filepath));
}

export async function writeCandidates(projectDir: string, candidates: ReviewCandidate[]): Promise<string> {
  const filepath = candidatesPath(projectDir);
  await writeAtomic(filepath, serializeCandidatesJsonl(candidates));
  return filepath;
}

export function isValidCandidate(value: unknown): value is ReviewCandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    /^C-[a-f0-9]{8,16}$/.test(candidate.id) &&
    typeof candidate.gist === "string" &&
    candidate.gist.length <= GIST_MAX_CHARS &&
    Array.isArray(candidate.terms) &&
    candidate.terms.every((item) => typeof item === "string") &&
    Array.isArray(candidate.files) &&
    candidate.files.every((item) => typeof item === "string") &&
    typeof candidate.pr === "string" &&
    typeof candidate.date === "string" &&
    typeof candidate.reviewer === "string"
  );
}

export function packageFloor(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return parts.slice(0, 2).join("/");
}

export function filesAlign(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  if (left.some((file) => rightSet.has(file))) return true;
  const floors = (files: string[]) => new Set(
    files.map(packageFloor).filter((dir) => dir.split("/").length >= 2),
  );
  const leftFloors = floors(left);
  return [...floors(right)].some((dir) => leftFloors.has(dir));
}

export function termIdf(term: string, pool: Array<{ terms: string[] }>): number {
  const n = Math.max(pool.length, 1);
  let df = 0;
  for (const item of pool) {
    if (item.terms.includes(term)) df += 1;
  }
  return Math.log((n + 1) / (df + 1)) + 1;
}

export function distinctiveSharedTerms(
  left: string[],
  right: string[],
  pool: Array<{ terms: string[] }>,
): string[] {
  const shared = intersection(left, right);
  // Tiny pools make every shared term look common (df ≈ n). Use IDF once
  // there are enough candidates for document frequency to mean something.
  if (pool.length < 8) return shared;
  return shared.filter((term) => termIdf(term, pool) >= 1.2);
}

export function candidatesOverlap(
  left: { gist: string; terms: string[]; files: string[] },
  right: { gist: string; terms: string[]; files: string[] },
  pool: Array<{ terms: string[] }> = [left, right],
): { score: number; match: boolean } {
  const distinctive = distinctiveSharedTerms(left.terms, right.terms, pool);
  const aligned = filesAlign(left.files, right.files);
  const match = aligned && distinctive.length >= 3;
  return {
    score: distinctive.length + (aligned ? 2 : 0),
    match,
  };
}

export function isPromotableQuality(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 24) return false;
  if (/\?\s*$/.test(trimmed)) return false;
  if (/^(what|why|how|where|who|is|are|can|could|would|should we)\b/i.test(trimmed)) return false;
  if (/^(lgtm|done|fixed|addressed|updated|pushed|nit|nits|fyi|btw)\b/i.test(trimmed)) return false;
  return /^(keep|use|avoid|never|always|do not|don't|prefer|put|move|register|store|make|add|remove|don't use|do not use)\b/i.test(toImperativeBody(trimmed))
    || /\b(never|always|must|do not|don't|should only)\b/i.test(trimmed);
}

export function matchCandidate(
  comment: string,
  files: string[],
  candidates: ReviewCandidate[],
  currentPr: string,
): ReviewCandidate | undefined {
  const probe = {
    gist: normalizeGist(comment),
    terms: extractTerms(comment),
    files,
  };
  let best: { candidate: ReviewCandidate; score: number } | undefined;
  for (const candidate of candidates) {
    if (normalizePr(candidate.pr) === normalizePr(currentPr)) continue;
    const { score, match } = candidatesOverlap(probe, candidate, [...candidates, probe]);
    if (!match) continue;
    if (!best || score > best.score) best = { candidate, score };
  }
  return best?.candidate;
}

export function candidateFromComment(
  comment: ReviewerComment,
  input: { pr: string; url?: string; files: string[]; date?: string },
): ReviewCandidate {
  const gist = normalizeGist(comment.body);
  const files = unique(comment.path ? [comment.path, ...input.files] : input.files);
  const pr = input.pr.startsWith("#") ? input.pr : `#${input.pr}`;
  return {
    id: generateCandidateId(gist, pr, comment.author),
    gist,
    terms: extractTerms(comment.body),
    files,
    pr,
    ...(input.url ? { url: input.url } : {}),
    date: input.date ?? isoDate(),
    reviewer: comment.author,
  };
}

export function pruneCandidates(
  candidates: ReviewCandidate[],
  options?: { now?: string; ttlDays?: number; cap?: number },
): ReviewCandidate[] {
  const now = options?.now ?? isoDate();
  const ttlDays = options?.ttlDays ?? CANDIDATE_TTL_DAYS;
  const cap = options?.cap ?? CANDIDATE_CAP;
  const cutoff = shiftDays(now, -ttlDays);
  const kept = candidates
    .filter((candidate) => candidate.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  if (kept.length <= cap) return kept;
  const promoted = kept.filter((candidate) => candidate.promoted_to);
  const open = kept.filter((candidate) => !candidate.promoted_to);
  const room = Math.max(0, cap - promoted.length);
  return [...promoted, ...open.slice(0, room)];
}

export function mergeCandidateLists(
  incoming: ReviewCandidate[],
  existing: ReviewCandidate[],
): ReviewCandidate[] {
  const byId = new Map<string, ReviewCandidate>();
  for (const candidate of existing) byId.set(candidate.id, candidate);
  for (const candidate of incoming) {
    const prev = byId.get(candidate.id);
    if (!prev) {
      byId.set(candidate.id, candidate);
      continue;
    }
    const newer = candidate.date >= prev.date ? candidate : prev;
    const older = newer === candidate ? prev : candidate;
    byId.set(candidate.id, {
      ...older,
      ...newer,
      files: unique([...prev.files, ...candidate.files]),
      promoted_to: candidate.promoted_to || prev.promoted_to,
    });
  }
  return pruneCandidates([...byId.values()]);
}

export function recordCandidates(
  existing: ReviewCandidate[],
  comments: ReviewerComment[],
  input: {
    pr: string;
    url?: string;
    files: string[];
    date?: string;
    promoted: Array<{ candidate_id?: string; memory_id?: string; gist?: string }>;
  },
): ReviewCandidate[] {
  let next = existing.map((candidate) => ({ ...candidate }));
  for (const promoted of input.promoted) {
    if (!promoted.candidate_id || !promoted.memory_id) continue;
    next = next.map((candidate) => (
      candidate.id === promoted.candidate_id
        ? { ...candidate, promoted_to: promoted.memory_id }
        : candidate
    ));
  }

  const pr = input.pr.startsWith("#") ? input.pr : `#${input.pr}`;
  for (const comment of comments) {
    const created = candidateFromComment(comment, {
      pr,
      url: input.url,
      files: input.files,
      date: input.date,
    });
    if (!created.gist) continue;
    const already = next.find((candidate) => candidate.id === created.id);
    if (already) continue;
    const matchedNew = input.promoted.find((item) => {
      if (item.gist && item.gist === created.gist) return true;
      if (!item.candidate_id) return false;
      const source = existing.find((candidate) => candidate.id === item.candidate_id);
      return Boolean(source && candidatesOverlap(created, source, [...existing, created]).match);
    });
    if (matchedNew?.memory_id) created.promoted_to = matchedNew.memory_id;
    next.push(created);
  }

  return pruneCandidates(next, { now: input.date });
}

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
