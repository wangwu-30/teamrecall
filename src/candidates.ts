import * as path from "node:path";
import { CANDIDATE_CAP, CANDIDATE_TTL_DAYS, CANDIDATES_FILENAME } from "./constants.js";
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
  "some", "any", "all", "each", "every",
]);

const PROCESS_TERMS = new Set([
  "comment", "comments", "review", "description", "paste", "style", "short",
  "brief", "nits", "nit", "function", "entire", "whole",
]);

export function candidatesPath(projectDir: string): string {
  return path.join(projectDir, ".memory", CANDIDATES_FILENAME);
}

export function normalizeGist(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[^a-z0-9.\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function extractTerms(text: string): string[] {
  return unique(
    normalizeGist(text)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

export function normalizePr(pr: string): string {
  return pr.replace(/^#/, "").trim();
}

export function generateCandidateId(existing: ReviewCandidate[]): string {
  const numbers = existing
    .map((candidate) => {
      const match = candidate.id.match(/^C-(\d+)/);
      return match ? Number.parseInt(match[1], 10) : 0;
    })
    .filter((value) => !Number.isNaN(value));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `C-${String(next).padStart(3, "0")}`;
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
    /^C-\d+$/.test(candidate.id) &&
    typeof candidate.gist === "string" &&
    Array.isArray(candidate.terms) &&
    candidate.terms.every((item) => typeof item === "string") &&
    Array.isArray(candidate.files) &&
    candidate.files.every((item) => typeof item === "string") &&
    typeof candidate.pr === "string" &&
    typeof candidate.date === "string"
  );
}

export function isProcessStyle(terms: string[]): boolean {
  return terms.some((term) => PROCESS_TERMS.has(term));
}

export function filesOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  if (left.some((file) => rightSet.has(file))) return true;
  const leftDirs = new Set(left.map((file) => file.split("/")[0]).filter(Boolean));
  return right.some((file) => leftDirs.has(file.split("/")[0] ?? ""));
}

export function candidatesOverlap(
  left: { gist: string; terms: string[]; files: string[] },
  right: { gist: string; terms: string[]; files: string[] },
): { score: number; match: boolean } {
  if (left.gist && left.gist === right.gist) return { score: 100, match: true };
  const terms = intersection(left.terms, right.terms);
  const files = filesOverlap(left.files, right.files);
  const process = isProcessStyle(left.terms) && isProcessStyle(right.terms);
  const match = (terms.length >= 3 && (files || process || terms.length >= 4))
    || (terms.length >= 2 && files);
  return {
    score: terms.length + (files ? 2 : 0) + (process ? 1 : 0),
    match,
  };
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
    if (candidate.promoted_to) continue;
    if (normalizePr(candidate.pr) === normalizePr(currentPr)) continue;
    const { score, match } = candidatesOverlap(probe, candidate);
    if (!match) continue;
    if (!best || score > best.score) best = { candidate, score };
  }
  return best?.candidate;
}

export function candidateFromComment(
  comment: string,
  input: { pr: string; url?: string; files: string[]; date?: string; used: ReviewCandidate[] },
): ReviewCandidate {
  return {
    id: generateCandidateId(input.used),
    gist: normalizeGist(comment),
    terms: extractTerms(comment),
    files: unique(input.files),
    pr: input.pr.startsWith("#") ? input.pr : `#${input.pr}`,
    ...(input.url ? { url: input.url } : {}),
    date: input.date ?? isoDate(),
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
  const open = candidates
    .filter((candidate) => !candidate.promoted_to)
    .filter((candidate) => candidate.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return open.slice(0, cap);
}

export function recordCandidates(
  existing: ReviewCandidate[],
  comments: string[],
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
    const gist = normalizeGist(comment);
    if (!gist) continue;
    if (next.some((candidate) => candidate.gist === gist && normalizePr(candidate.pr) === normalizePr(pr))) {
      continue;
    }
    const created = candidateFromComment(comment, {
      pr,
      url: input.url,
      files: input.files,
      date: input.date,
      used: next,
    });
    const matchedNew = input.promoted.find((item) => {
      if (item.gist && item.gist === gist) return true;
      if (!item.candidate_id) return false;
      const source = existing.find((candidate) => candidate.id === item.candidate_id);
      return Boolean(source && candidatesOverlap(created, source).match);
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
