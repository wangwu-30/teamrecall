import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import { DEFAULT_TTL_DAYS, MAX_BODY_WORDS } from "./constants.js";
import type { Memory, MemoryFrontmatter, MemoryKind, MemoryScope, MemoryStatus, MemoryTrigger, PathsSource, TeamRecallConfig } from "./types.js";
import { exists } from "./utils/atomic.js";

const DEFAULT_CONFIG: TeamRecallConfig = {
  max_active_memories: 50,
  review_ttl_days: DEFAULT_TTL_DAYS,
  retrieve_always_cap: 8,
};

const KINDS: MemoryKind[] = ["gotcha", "decision", "convention", "map"];
const STATUSES: MemoryStatus[] = ["active", "retired", "superseded", "abandoned"];
const SCOPES: MemoryScope[] = ["always", "triggered"];
const PATH_SOURCES: PathsSource[] = ["distiller", "inferred", "human"];

export async function loadConfig(projectDir: string): Promise<TeamRecallConfig> {
  const configPath = path.join(projectDir, ".memory", "config.yml");
  if (!(await exists(configPath))) {
    return DEFAULT_CONFIG;
  }
  const content = await fs.readFile(configPath, "utf8");
  const parsed = YAML.parse(content) ?? {};
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function loadMemories(projectDir: string): Promise<Memory[]> {
  const memoriesDir = path.join(projectDir, ".memory", "memories");
  if (!(await exists(memoriesDir))) {
    return [];
  }

  const files = await fs.readdir(memoriesDir);
  const memories: Memory[] = [];

  for (const file of files) {
    if (!file.endsWith(".md") || !file.startsWith("M-")) {
      continue;
    }

    const filepath = path.join(memoriesDir, file);
    const content = await fs.readFile(filepath, "utf8");
    const parsed = parseMemory(content);
    if (parsed) {
      memories.push({ ...parsed, filepath });
    }
  }

  return memories.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}

export function parseMemory(content: string): { frontmatter: MemoryFrontmatter; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const frontmatter = YAML.parse(match[1]) as MemoryFrontmatter;
    const body = match[2].trim();
    if (!isValidFrontmatter(frontmatter)) {
      return null;
    }
    return { frontmatter, body };
  } catch {
    return null;
  }
}

export function isValidFrontmatter(fm: unknown): fm is MemoryFrontmatter {
  if (typeof fm !== "object" || fm === null) return false;
  const value = fm as Record<string, unknown>;
  const evidence = value.evidence;
  return (
    typeof value.id === "string" &&
    /^M-\d+$/.test(value.id) &&
    KINDS.includes(value.kind as MemoryKind) &&
    Array.isArray(value.paths) &&
    value.paths.every((item) => typeof item === "string") &&
    (value.scope === undefined || SCOPES.includes(value.scope as MemoryScope)) &&
    (value.paths_source === undefined || PATH_SOURCES.includes(value.paths_source as PathsSource)) &&
    (value.triggers === undefined || (Array.isArray(value.triggers) && value.triggers.every(isValidTrigger))) &&
    (evidence === undefined || typeof evidence === "object") &&
    typeof value.author === "string" &&
    typeof value.created === "string" &&
    typeof value.review_after === "string" &&
    STATUSES.includes(value.status as MemoryStatus) &&
    (value.status !== "superseded" || (typeof value.superseded_by === "string" && /^M-\d+$/.test(value.superseded_by)))
  );
}

export function isValidTrigger(value: unknown): value is MemoryTrigger {
  if (typeof value !== "object" || value === null) return false;
  const trigger = value as Record<string, unknown>;
  if (typeof trigger.glob !== "string" || !trigger.glob.trim()) return false;
  if (trigger.contains !== undefined && typeof trigger.contains !== "string") return false;
  if (trigger.pr !== undefined && typeof trigger.pr !== "string") return false;
  return true;
}

export function defaultScope(paths: string[], _body = ""): MemoryScope {
  if (isBroadPaths(paths)) return "always";
  return "triggered";
}

export function memoryScope(memory: Memory): MemoryScope {
  return memory.frontmatter.scope ?? defaultScope(memory.frontmatter.paths, memory.body);
}

export function isBroadPaths(paths: string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((glob) => glob === "**" || glob === "**/*" || glob === "*");
}

export function validateSupersededBy(memories: Memory[]): string[] {
  const ids = new Set(memories.map((memory) => memory.frontmatter.id));
  const errors: string[] = [];
  for (const memory of memories) {
    if (memory.frontmatter.status !== "superseded") continue;
    const target = memory.frontmatter.superseded_by;
    if (!target) {
      errors.push(`${memory.frontmatter.id} is superseded but missing superseded_by`);
    } else if (!ids.has(target)) {
      errors.push(`${memory.frontmatter.id} superseded_by ${target} does not exist`);
    }
  }
  return errors;
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function clampBody(body: string, maxWords = MAX_BODY_WORDS): string {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return body.trim();
  return words.slice(0, maxWords).join(" ");
}

export function validateMemoryBody(body: string): string[] {
  const errors: string[] = [];
  if (!body.trim()) errors.push("body is empty");
  if (countWords(body) > MAX_BODY_WORDS) {
    errors.push(`body exceeds ${MAX_BODY_WORDS} words`);
  }
  return errors;
}

export function formatMemory(frontmatter: MemoryFrontmatter, body: string): string {
  return `---\n${YAML.stringify(frontmatter).trim()}\n---\n\n${clampBody(body)}\n`;
}

export function generateMemoryId(existingIds: string[]): string {
  const numbers = existingIds
    .map((id) => {
      const match = id.match(/^M-(\d+)/);
      return match ? Number.parseInt(match[1], 10) : 0;
    })
    .filter((n) => !Number.isNaN(n));

  const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `M-${String(nextNum).padStart(3, "0")}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isoDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function reviewAfterDate(created: string, ttlDays = DEFAULT_TTL_DAYS): string {
  const date = new Date(`${created}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + ttlDays);
  return date.toISOString().slice(0, 10);
}

export function memoryFilename(id: string, title: string): string {
  const slug = slugify(title) || "memory";
  return `${id}-${slug}.md`;
}
