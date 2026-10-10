import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { TEAMRECALL_PR_PREFIX } from "./constants.js";
import { MANAGED_GIT_PATHS, commandExists, fetchPullRequest, openPullRequest } from "./github.js";
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

export interface LearnRunDeps {
  fetchPr?: (pr: string, cwd: string) => Promise<PullRequestContext>;
  distill?: (prompt: string) => Promise<string>;
  openPr?: typeof openPullRequest;
}

export interface LearnRunResult {
  plan: LearnPlan;
  written: string[];
  deleted: string[];
  pr_url?: string | null;
  skipped?: string;
}

export const CLAUDE_DISALLOWED_TOOLS =
  "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent,NotebookEdit,Task";

export function shouldOpenLearnPr(flags: { ci?: boolean; pr?: boolean }): boolean {
  return Boolean(flags.ci || flags.pr);
}

export function sanitisedChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.GITHUB_TOKEN;
  delete next.GH_TOKEN;
  return next;
}

export function claudeDistillArgs(): string[] {
  return ["-p", "--disallowedTools", CLAUDE_DISALLOWED_TOOLS];
}

export function runWithStdin(
  command: string,
  args: string[],
  stdin: string,
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options?.env ?? sanitisedChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, options?.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}

export async function distillWithAvailableEngine(prompt: string): Promise<string> {
  if (await commandExists("claude")) {
    return runWithStdin("claude", claudeDistillArgs(), prompt);
  }
  if (await commandExists("codex")) {
    return runWithStdin("codex", ["exec"], prompt);
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
      deleted: [],
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
  const { written, deleted } = await applyMutations(plan);

  const nextMemories = await loadMemories(projectDir);
  const compiled = await compileMemories(projectDir, nextMemories);
  written.push(...await writeCompiledFiles(projectDir, compiled));

  let prUrl: string | null | undefined;
  if (input.openPr && (plan.mutations.length > 0 || deleted.length > 0)) {
    const opener = input.deps?.openPr ?? openPullRequest;
    prUrl = await opener({
      cwd: projectDir,
      branch: `teamrecall/learn-from-pr-${context.number}`,
      title: buildLearnPrTitle(plan.learned, plan.updated, context.number),
      body: buildLearnPrBody(plan, context),
      files: [...MANAGED_GIT_PATHS],
    });
  }

  return { plan, written: unique(written), deleted, pr_url: prUrl };
}

async function applyMutations(plan: LearnPlan): Promise<{ written: string[]; deleted: string[] }> {
  const written: string[] = [];
  const deleted: string[] = [];
  for (const mutation of plan.mutations) {
    if (mutation.delete) {
      await fs.rm(mutation.path, { force: true });
      deleted.push(mutation.path);
      continue;
    }
    if (mutation.content !== undefined) {
      await fs.mkdir(path.dirname(mutation.path), { recursive: true });
      await fs.writeFile(mutation.path, mutation.content, "utf8");
      written.push(mutation.path);
    }
  }
  return { written, deleted };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
