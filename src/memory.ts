import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import type { Memory, MemoryFrontmatter, TeamRecallConfig } from "./types.js";
import { exists } from "./utils/atomic.js";

const DEFAULT_CONFIG: TeamRecallConfig = {
  max_active_memories: 50,
  review_ttl_days: 90,
};

export async function loadConfig(projectDir: string): Promise<TeamRecallConfig> {
  const configPath = path.join(projectDir, ".memory", "config.yml");
  if (!(await exists(configPath))) {
    return DEFAULT_CONFIG;
  }
  const content = await fs.readFile(configPath, "utf8");
  return { ...DEFAULT_CONFIG, ...YAML.parse(content) };
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

function isValidFrontmatter(fm: any): fm is MemoryFrontmatter {
  return (
    typeof fm === "object" &&
    typeof fm.id === "string" &&
    ["gotcha", "decision", "convention", "map"].includes(fm.kind) &&
    Array.isArray(fm.paths) &&
    typeof fm.author === "string" &&
    typeof fm.created === "string" &&
    typeof fm.review_after === "string" &&
    ["active", "retired"].includes(fm.status)
  );
}

export function formatMemory(frontmatter: MemoryFrontmatter, body: string): string {
  return `---\n${YAML.stringify(frontmatter).trim()}\n---\n\n${body.trim()}\n`;
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
