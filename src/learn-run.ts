import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { TEAMRECALL_PR_PREFIX } from "./constants.js";
import {
  buildLearnPrBody,
  buildLearnPrTitle,
  fallbackOutcomeFromReviews,
  generateDistillationPrompt,
  parseDistillationResponse,
  planLearnOutcomes,
  type LearnPlan,
} from "./learn.js";
import { loadConfig, loadMemories } from "./memory.js";
import type { LearnOutcome, PullRequestContext } from "./types.js";
import { commandExists, fetchPullRequest, openPullRequest } from "./github.js";

export interface LearnRunDeps {
  fetchPr?: (pr: string, cwd: string) => Promise<PullRequestContext>;
  distill?: (prompt: string) => Promise<string>;
  openPr?: typeof openPullRequest;
}

export interface LearnRunResult {
  plan: LearnPlan;
  written: string[];
  pr_url?: string | null;
  skipped?: string;
}

export async function distillWithAvailableEngine(prompt: string): Promise<string> {
  if (await commandExists("claude")) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("claude", ["-p", prompt], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }
  if (await commandExists("codex")) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("codex", ["exec", prompt], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }
  throw new Error("Neither claude nor codex CLI is available");
}

export async function runLearn(input: {
  projectDir: string;
  pr: string;
  openPr?: boolean;
  ci?: boolean;
  deps?: LearnRunDeps;
}): Promise<LearnRunResult> {
  const projectDir = path.resolve(input.projectDir);
  const fetchPr = input.deps?.fetchPr ?? fetchPullRequest;
  const context = await fetchPr(input.pr, projectDir);

  if (context.title.startsWith(TEAMRECALL_PR_PREFIX)) {
    const memories = await loadMemories(projectDir);
    const compiled = await compileMemories(projectDir, memories);
    const written = await writeCompiledFiles(projectDir, compiled);
    return {
      plan: {
        action: "no_op",
        outcomes: [{ action: "no_op", reasoning: "Recompiled a teamrecall memory PR" }],
        mutations: [],
        learned: 0,
        updated: 0,
        retired: 0,
        summary: `recompiled from #${context.number}`,
      },
      written,
      skipped: "memory-pr-recompile",
    };
  }

  const memories = await loadMemories(projectDir);
  const config = await loadConfig(projectDir);
  const prompt = generateDistillationPrompt({
    pr_number: context.number,
    diff: context.diff,
    pr_body: context.body,
    review_comments: context.review_comments,
    commit_messages: context.commit_messages,
    existing_memories: memories,
  });

  let outcome: LearnOutcome;
  try {
    const raw = input.deps?.distill
      ? await input.deps.distill(prompt)
      : await distillWithAvailableEngine(prompt);
    outcome = parseDistillationResponse(raw);
  } catch {
    outcome = fallbackOutcomeFromReviews(context);
  }

  const plan = planLearnOutcomes(outcome, memories, context, projectDir, config.review_ttl_days);
  const written = await applyMutations(plan);

  const nextMemories = await loadMemories(projectDir);
  const compiled = await compileMemories(projectDir, nextMemories);
  written.push(...await writeCompiledFiles(projectDir, compiled));

  let prUrl: string | null | undefined;
  if (input.openPr && plan.mutations.length > 0) {
    const opener = input.deps?.openPr ?? openPullRequest;
    prUrl = await opener({
      cwd: projectDir,
      branch: `teamrecall/learn-from-pr-${context.number}`,
      title: buildLearnPrTitle(plan.learned, plan.updated, context.number),
      body: buildLearnPrBody(plan, context),
      files: uniqueWriteRoots(written),
    });
  }

  return { plan, written: unique(written), pr_url: prUrl };
}

async function applyMutations(plan: LearnPlan): Promise<string[]> {
  const written: string[] = [];
  for (const mutation of plan.mutations) {
    if (mutation.delete) {
      await fs.rm(mutation.path, { force: true });
      continue;
    }
    if (mutation.content !== undefined) {
      await fs.mkdir(path.dirname(mutation.path), { recursive: true });
      await fs.writeFile(mutation.path, mutation.content, "utf8");
      written.push(mutation.path);
    }
  }
  return written;
}

function uniqueWriteRoots(files: string[]): string[] {
  return unique(files);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
