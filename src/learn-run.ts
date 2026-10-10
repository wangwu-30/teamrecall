import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { TEAMRECALL_PR_PREFIX } from "./constants.js";
import { shouldLearnFromClosedPr } from "./human-comments.js";
import {
  MANAGED_GIT_PATHS,
  assertManagedPathsClean,
  commandExists,
  fetchPullRequest,
  openPullRequest,
  startPointForBotBranch,
} from "./github.js";
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
  env?: NodeJS.ProcessEnv;
  hasLocalEngine?: boolean;
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

export function hasLlmSecret(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || env.OPENAI_API_KEY?.trim());
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
  if (input.openPr && !input.ci) {
    await assertManagedPathsClean(projectDir);
  }
  const fetchPr = input.deps?.fetchPr ?? fetchPullRequest;
  const context = await fetchPr(input.pr, projectDir);

  if (!shouldLearnFromClosedPr(context)) {
    return {
      plan: {
        action: "no_op",
        outcomes: [{
          action: "no_op",
          reasoning: "Closed unmerged PR has no human review comments",
        }],
        mutations: [],
        learned: 0,
        updated: 0,
        retired: 0,
        conflicts: [],
        distiller: "llm",
        summary: `skipped unmerged #${context.number} (no human review comments)`,
      },
      written: [],
      deleted: [],
      skipped: "unmerged-without-human-comments",
    };
  }

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
        conflicts: [],
        distiller: "llm",
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
  let distiller: LearnPlan["distiller"] = "llm";
  let distillerReason: LearnPlan["distiller_reason"];
  const env = input.deps?.env ?? process.env;
  const hasSecret = hasLlmSecret(env);
  const inCi = Boolean(input.ci || env.GITHUB_ACTIONS);
  const hasLocalEngine = input.deps?.hasLocalEngine
    ?? (await commandExists("claude") || await commandExists("codex"));
  const canCallLlm = Boolean(input.deps?.distill) || hasSecret || (hasLocalEngine && !inCi);
  if (!canCallLlm) {
    outcome = fallbackOutcomeFromReviews(context);
    distiller = "deterministic";
    distillerReason = "no_llm_secret";
  } else {
    try {
      const raw = input.deps?.distill
        ? await input.deps.distill(prompt)
        : await distillWithAvailableEngine(prompt);
      outcome = parseDistillationResponse(raw);
    } catch {
      outcome = fallbackOutcomeFromReviews(context);
      distiller = "deterministic";
      distillerReason = hasSecret ? "llm_failed" : "no_llm_secret";
    }
  }

  const plan = planLearnOutcomes(outcome, memories, context, projectDir, config.review_ttl_days);
  plan.distiller = distiller;
  plan.distiller_reason = distillerReason;
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
      title: buildLearnPrTitle(plan.learned, plan.updated, context.number, plan.retired),
      body: buildLearnPrBody(plan, context),
      files: [...MANAGED_GIT_PATHS],
      force: true,
      startPoint: await startPointForBotBranch(projectDir),
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
