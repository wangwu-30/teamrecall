import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_BACKFILL_PRS } from "./constants.js";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { fallbackOutcomeFromReviews, planLearnOutcomes } from "./learn.js";
import {
  clampBody,
  formatMemory,
  generateMemoryId,
  isoDate,
  loadMemories,
  memoryFilename,
  reviewAfterDate,
  slugify,
} from "./memory.js";
import type { LearnOutcome, MemoryFrontmatter, PullRequestContext } from "./types.js";
import { exists, isDirectory, readText, writeAtomic } from "./utils/atomic.js";
import { fetchPullRequest, listMergedPullRequests } from "./github.js";

export interface BackfillResult {
  created: string[];
  written: string[];
  from_rules: number;
  from_prs: number;
}

const RULE_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md", ".cursor/rules"];

export async function collectRuleSources(projectDir: string): Promise<Array<{ source: string; content: string }>> {
  const sources: Array<{ source: string; content: string }> = [];
  for (const relative of RULE_FILES) {
    const target = path.join(projectDir, relative);
    if (!(await exists(target))) continue;
    if (await isDirectory(target)) {
      const files = (await fs.readdir(target)).filter((file) => file.endsWith(".mdc") || file.endsWith(".md"));
      for (const file of files) {
        const content = await readText(path.join(target, file));
        if (content) sources.push({ source: `${relative}/${file}`, content });
      }
      continue;
    }
    const content = await readText(target);
    if (content) sources.push({ source: relative, content });
  }
  return sources;
}

export function extractRuleLessons(content: string, source: string): LearnOutcome[] {
  const withoutManaged = content.replace(/<!-- teamrecall:start -->[\s\S]*?<!-- teamrecall:end -->/g, "");
  const sections = withoutManaged.split(/^#{1,3}\s+/m).slice(1);
  const lessons: LearnOutcome[] = [];

  if (sections.length === 0) {
    for (const bullet of bullets(withoutManaged)) {
      lessons.push(ruleLesson(bullet, source));
    }
    return lessons.filter((lesson) => lesson.body && lesson.body.length >= 40).slice(0, 5);
  }

  for (const section of sections) {
    const [title, ...rest] = section.split("\n");
    const body = rest.join(" ").replace(/\s+/g, " ").trim();
    if (!title || body.length < 40) continue;
    lessons.push(ruleLesson(`${title.trim()}. ${body}`, source));
  }

  return lessons.slice(0, 5);
}

function ruleLesson(text: string, source: string): LearnOutcome {
  const body = clampBody(text);
  return {
    action: "new",
    title: body.split(/[.!?]/)[0] || slugify(body),
    kind: "convention",
    paths: ["**/*"],
    body,
    reasoning: `Backfilled from ${source}`,
  };
}

function bullets(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter((line) => line.length >= 40);
}

export async function backfillProject(
  projectDir: string,
  options?: { fetchPrs?: boolean; ttlDays?: number },
): Promise<BackfillResult> {
  const created: string[] = [];
  const existing = await loadMemories(projectDir);
  const usedIds = existing.map((memory) => memory.frontmatter.id);
  const ttlDays = options?.ttlDays ?? 90;
  let fromRules = 0;
  let fromPrs = 0;

  for (const { source, content } of await collectRuleSources(projectDir)) {
    const lessons = extractRuleLessons(content, source);
    for (const lesson of lessons) {
      const file = await writeNewMemory(projectDir, lesson, usedIds, {
        number: "backfill",
        title: source,
        body: "",
        url: "",
        author: "teamrecall",
        diff: "",
        review_comments: [],
        human_review_comments: [],
        merged: true,
        commit_messages: [],
        commits: [],
        files: [source],
      }, ttlDays);
      if (file) {
        created.push(file);
        fromRules += 1;
      }
    }
  }

  if (options?.fetchPrs !== false) {
    try {
      const numbers = await listMergedPullRequests(projectDir, DEFAULT_BACKFILL_PRS);
      for (const number of numbers) {
        if (fromPrs >= 3) break;
        const context = await fetchPullRequest(number, projectDir);
        const outcome = fallbackOutcomeFromReviews(context);
        if (outcome.action !== "new") continue;
        const latest = await loadMemories(projectDir);
        const plan = planLearnOutcomes(outcome, latest, context, projectDir, ttlDays);
        for (const mutation of plan.mutations) {
          if (!mutation.content || mutation.delete) continue;
          await writeAtomic(mutation.path, mutation.content);
          created.push(mutation.path);
          fromPrs += 1;
        }
      }
    } catch {
      // gh is optional on day one; rule backfill still provides value.
    }
  }

  const compiled = await compileMemories(projectDir, await loadMemories(projectDir));
  const written = await writeCompiledFiles(projectDir, compiled);
  return { created, written, from_rules: fromRules, from_prs: fromPrs };
}

async function writeNewMemory(
  projectDir: string,
  lesson: LearnOutcome,
  usedIds: string[],
  context: PullRequestContext,
  ttlDays: number,
): Promise<string | null> {
  if (!lesson.body) return null;
  const id = generateMemoryId(usedIds);
  usedIds.push(id);
  const created = isoDate();
  const frontmatter: MemoryFrontmatter = {
    id,
    kind: lesson.kind ?? "convention",
    paths: lesson.paths ?? ["**/*"],
    evidence: { pr: context.number === "backfill" ? undefined : `#${context.number}` },
    author: context.author,
    created,
    review_after: reviewAfterDate(created, ttlDays),
    status: "active",
  };
  const filename = memoryFilename(id, lesson.title || id);
  const filepath = path.join(projectDir, ".memory", "memories", filename);
  await writeAtomic(filepath, formatMemory(frontmatter, lesson.body));
  return filepath;
}
