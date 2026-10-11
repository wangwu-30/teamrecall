import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { backfillProject } from "./backfill.js";
import { DEFAULT_TTL_DAYS, MAX_ACTIVE_MEMORIES } from "./constants.js";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { runDoctor, type DoctorResult } from "./doctor.js";
import { openPullRequest, setClaudeSecret } from "./github.js";
import { loadMemories } from "./memory.js";
import type { TeamRecallConfig } from "./types.js";
import { exists, readText, writeAtomic } from "./utils/atomic.js";

export interface InitOptions {
  backfill?: boolean;
  openPr?: boolean;
  yes?: boolean;
}

export interface InitResult {
  created: string[];
  written: string[];
  skipped: string[];
  reused: boolean;
  message: string;
  secret_set?: boolean;
}

export interface InitJson {
  ok: boolean;
  reused: boolean;
  created: string[];
  written: string[];
  skipped: string[];
  secret_set: boolean;
  message: string;
  human_actions: string[];
  pr_url: string | null;
  pr_error?: string;
  doctor?: {
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; severity: string; detail: string }>;
  };
  error?: string;
}

export const HUMAN_SECRET_COMMAND = "claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN";
export const HUMAN_ACTIONS_SETTING =
  "GitHub repo Settings → Actions → General → Workflow permissions: enable “Allow GitHub Actions to create and approve pull requests”";

export function humanOnboardingActions(secretSet: boolean): string[] {
  const actions: string[] = [];
  if (!secretSet) actions.push(HUMAN_SECRET_COMMAND);
  actions.push(HUMAN_ACTIONS_SETTING);
  return actions;
}

export function toInitJson(input: {
  result: InitResult;
  projectDir: string;
  prUrl?: string | null;
  prError?: string;
  doctor?: DoctorResult;
  error?: string;
}): InitJson {
  const rel = (file: string) => {
    const relative = path.relative(input.projectDir, file);
    return relative && !relative.startsWith("..") ? relative : file;
  };
  return {
    ok: !input.error,
    reused: input.result.reused,
    created: unique(input.result.created.map(rel)),
    written: unique(input.result.written.map(rel)),
    skipped: unique(input.result.skipped.map(rel)),
    secret_set: Boolean(input.result.secret_set),
    message: input.result.message,
    human_actions: humanOnboardingActions(Boolean(input.result.secret_set)),
    pr_url: input.prUrl ?? null,
    pr_error: input.prError,
    doctor: input.doctor
      ? {
          ok: input.doctor.ok,
          checks: input.doctor.checks.map((check) => ({
            name: check.name,
            ok: check.ok,
            severity: check.severity,
            detail: check.detail,
          })),
        }
      : undefined,
    error: input.error,
  };
}

export async function initProject(projectDir: string, options: InitOptions = {}): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const memoryDir = path.join(projectDir, ".memory");
  const reused = await exists(memoryDir);

  try {
    await fs.mkdir(path.join(memoryDir, "memories"), { recursive: true });
    await fs.mkdir(path.join(memoryDir, "retired"), { recursive: true });
    if (reused) skipped.push(memoryDir);
    else created.push(memoryDir);

    const config: TeamRecallConfig = {
      max_active_memories: MAX_ACTIVE_MEMORIES,
      review_ttl_days: DEFAULT_TTL_DAYS,
      candidates_store: "state_branch",
    };
    await ensureWritten(path.join(memoryDir, "config.yml"), YAML.stringify(config), created, skipped);
    await ensureWritten(path.join(memoryDir, "README.md"), memoryReadme(), created, skipped);

    const workflowPath = path.join(projectDir, ".github", "workflows", "teamrecall.yml");
    await ensureWritten(workflowPath, await loadWorkflowTemplate(), created, skipped);
    const sweepPath = path.join(projectDir, ".github", "workflows", "teamrecall-sweep.yml");
    await ensureWritten(sweepPath, await loadSweepWorkflowTemplate(), created, skipped);

    let secretSet = false;
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token) {
      secretSet = await setClaudeSecret(token, projectDir);
    }

    let written: string[] = [];
    if (options.backfill) {
      const existing = await loadMemories(projectDir);
      if (existing.length > 0) {
        const compiled = await compileMemories(projectDir, existing);
        written = await writeCompiledFiles(projectDir, compiled);
        skipped.push("backfill");
      } else {
        const result = await backfillProject(projectDir);
        created.push(...result.created);
        written = result.written;
      }
    } else {
      const compiled = await compileMemories(projectDir, await loadMemories(projectDir));
      written = await writeCompiledFiles(projectDir, compiled);
    }

    return {
      created,
      written,
      skipped,
      reused,
      secret_set: secretSet,
      message: initMessage(secretSet),
    };
  } catch (error) {
    if (!reused) {
      await fs.rm(memoryDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function runInitCommand(input: {
  projectDir: string;
  backfill?: boolean;
  skipPr?: boolean;
  json?: boolean;
  yes?: boolean;
  deps?: {
    openPr?: typeof openPullRequest;
    doctor?: typeof runDoctor;
  };
}): Promise<InitJson> {
  const result = await initProject(input.projectDir, {
    backfill: input.backfill !== false,
    openPr: !input.skipPr,
    yes: input.yes !== false,
  });

  let prUrl: string | null = null;
  let prError: string | undefined;
  if (!input.skipPr) {
    try {
      const opener = input.deps?.openPr ?? openPullRequest;
      prUrl = (await opener({
        cwd: input.projectDir,
        branch: "teamrecall/init",
        title: "🧠 teamrecall: initialize team memory",
        body: [
          "Scaffolds `.memory/`, compiles agent rules, and backfills lessons from existing CLAUDE.md / AGENTS.md / `.cursor/rules` and recent merged PRs.",
          "",
          "Zero-secret mode records recurrence candidates and compiles hand-written memories. Recurrence promotion needs an LLM engine (`claude` / `codex` CLI or `CLAUDE_CODE_OAUTH_TOKEN`).",
        ].join("\n"),
        files: unique(
          [...result.created, ...result.written].filter((file) => file !== input.projectDir && !file.endsWith(".memory")),
        ),
      })) ?? null;
    } catch (error) {
      prError = error instanceof Error ? error.message : String(error);
    }
  }

  const doctorFn = input.deps?.doctor ?? runDoctor;
  const doctor = await doctorFn(input.projectDir);
  return toInitJson({ result, projectDir: input.projectDir, prUrl, prError, doctor });
}

async function ensureWritten(
  filepath: string,
  content: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (await exists(filepath)) {
    skipped.push(filepath);
    return;
  }
  await writeAtomic(filepath, content);
  created.push(filepath);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function loadTemplate(filename: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "templates", filename),
    path.join(here, "templates", filename),
  ];
  for (const candidate of candidates) {
    const content = await readText(candidate);
    if (content) return content;
  }
  throw new Error(`Missing templates/${filename}`);
}

export async function loadWorkflowTemplate(): Promise<string> {
  return loadTemplate("github-workflow.yml");
}

export async function loadSweepWorkflowTemplate(): Promise<string> {
  return loadTemplate("github-workflow-sweep.yml");
}

function memoryReadme(): string {
  return `# Team Memory

This directory stores team knowledge captured from code review.

## Structure

- \`memories/M-xxx-slug.md\` — Active memories
- \`retired/\` — Retired memories
- Active/abandoned/superseded files stay in \`memories/\` (\`superseded\` needs \`superseded_by\`)
- \`INDEX.md\` — Compiled index (auto-generated)
- \`candidates.jsonl\` — Recurrence gists (never compiled). Default store is the \`teamrecall/state\` branch, which is **public on public repos**. Set \`candidates_store: actions_cache\` in \`config.yml\` to keep them in Actions cache instead.
- \`config.yml\` — Configuration (\`candidates_store: state_branch | actions_cache\`)

## Memory Format

Each memory is a Markdown file with YAML frontmatter:

\`\`\`yaml
---
id: M-001
kind: gotcha|decision|convention|map
paths: [".changeset/*.md"]
scope: always|triggered
triggers:
  - glob: ".changeset/*.md"
    contains: optional literal substring on added diff lines
    pr: optional title/body/size signal
evidence:
  pr: "#42"
  review_url: "https://..."
  commits: ["abc123"]
author: alice
created: "2026-10-10"
review_after: "2027-01-08"
status: active
---

Memory content (≤120 words): what triggers this and what decision it changes.
\`\`\`

Memories are automatically compiled into:
- \`AGENTS.md\` (managed block)
- \`.memory/INDEX.md\`
- \`.claude/rules/teamrecall/*.md\`
- \`.cursor/rules/teamrecall-*.mdc\`
`;
}

function initMessage(secretSet: boolean): string {
  return [
    "✓ Initialized teamrecall (re-run safe; --yes is the default)",
    "",
    "Next steps:",
    secretSet
      ? "1. CLAUDE_CODE_OAUTH_TOKEN was stored with `gh secret set`."
      : `1. Recurrence promotion needs an LLM engine: ${HUMAN_SECRET_COMMAND}`,
    `2. ${HUMAN_ACTIONS_SETTING}`,
    "3. Review the compiled files and merge the first memory PR.",
    "",
    "Day-one value: existing CLAUDE.md / AGENTS.md / .cursor/rules are backfilled. Zero-secret learn only records candidates; set an LLM engine to promote recurrences.",
    "See `.memory/README.md` for the memory format.",
  ].join("\n");
}
