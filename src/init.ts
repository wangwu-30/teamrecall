import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { backfillProject } from "./backfill.js";
import { DEFAULT_TTL_DAYS, MAX_ACTIVE_MEMORIES } from "./constants.js";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { setClaudeSecret } from "./github.js";
import { loadMemories } from "./memory.js";
import type { TeamRecallConfig } from "./types.js";
import { exists, readText, writeAtomic } from "./utils/atomic.js";

export interface InitOptions {
  backfill?: boolean;
  openPr?: boolean;
}

export interface InitResult {
  created: string[];
  written: string[];
  message: string;
  secret_set?: boolean;
}

export async function initProject(projectDir: string, options: InitOptions = {}): Promise<InitResult> {
  const created: string[] = [];
  const memoryDir = path.join(projectDir, ".memory");

  if (await exists(memoryDir)) {
    throw new Error(`.memory directory already exists at ${memoryDir}`);
  }

  try {
    await fs.mkdir(path.join(memoryDir, "memories"), { recursive: true });
    await fs.mkdir(path.join(memoryDir, "retired"), { recursive: true });
    created.push(memoryDir);

    const config: TeamRecallConfig = {
      max_active_memories: MAX_ACTIVE_MEMORIES,
      review_ttl_days: DEFAULT_TTL_DAYS,
    };
    const configPath = path.join(memoryDir, "config.yml");
    await writeAtomic(configPath, YAML.stringify(config));
    created.push(configPath);

    const readmePath = path.join(memoryDir, "README.md");
    await writeAtomic(readmePath, memoryReadme());
    created.push(readmePath);

    const workflowPath = path.join(projectDir, ".github", "workflows", "teamrecall.yml");
    if (!(await exists(workflowPath))) {
      await writeAtomic(workflowPath, await loadWorkflowTemplate());
      created.push(workflowPath);
    }

    let secretSet = false;
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token) {
      secretSet = await setClaudeSecret(token, projectDir);
    }

    let written: string[] = [];
    if (options.backfill) {
      const result = await backfillProject(projectDir);
      created.push(...result.created);
      written = result.written;
    } else {
      const compiled = await compileMemories(projectDir, await loadMemories(projectDir));
      written = await writeCompiledFiles(projectDir, compiled);
    }

    return {
      created,
      written,
      secret_set: secretSet,
      message: initMessage(secretSet),
    };
  } catch (error) {
    await fs.rm(memoryDir, { recursive: true, force: true });
    throw error;
  }
}

export async function loadWorkflowTemplate(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "templates", "github-workflow.yml"),
    path.join(here, "templates", "github-workflow.yml"),
  ];
  for (const candidate of candidates) {
    const content = await readText(candidate);
    if (content) return content;
  }
  throw new Error("Missing templates/github-workflow.yml");
}

function memoryReadme(): string {
  return `# Team Memory

This directory stores team knowledge captured from code review.

## Structure

- \`memories/M-xxx-slug.md\` — Active memories
- \`retired/\` — Superseded memories
- \`INDEX.md\` — Compiled index (auto-generated)
- \`config.yml\` — Configuration

## Memory Format

Each memory is a Markdown file with YAML frontmatter:

\`\`\`yaml
---
id: M-001
kind: gotcha|decision|convention|map
paths: ["src/**/*.ts"]
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
    "✓ Initialized teamrecall",
    "",
    "Next steps:",
    "1. Run `claude setup-token` (uses the team's Claude subscription, no API key).",
    secretSet
      ? "2. CLAUDE_CODE_OAUTH_TOKEN was stored with `gh secret set`."
      : "2. Run `gh secret set CLAUDE_CODE_OAUTH_TOKEN` and paste the token.",
    "3. Review the compiled files and open (or merge) the first memory PR.",
    "",
    "Day-one value: existing CLAUDE.md / .cursorrules and recent review comments are backfilled when you pass --backfill (CLI default).",
    "See `.memory/README.md` for the memory format.",
  ].join("\n");
}
