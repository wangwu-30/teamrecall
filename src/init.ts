import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import type { TeamRecallConfig } from "./types.js";
import { exists, writeAtomic } from "./utils/atomic.js";

export interface InitResult {
  created: string[];
  message: string;
}

export async function initProject(projectDir: string): Promise<InitResult> {
  const created: string[] = [];
  const memoryDir = path.join(projectDir, ".memory");

  if (await exists(memoryDir)) {
    throw new Error(`.memory directory already exists at ${memoryDir}`);
  }

  await fs.mkdir(path.join(memoryDir, "memories"), { recursive: true });
  await fs.mkdir(path.join(memoryDir, "retired"), { recursive: true });
  created.push(memoryDir);

  const config: TeamRecallConfig = {
    max_active_memories: 50,
    review_ttl_days: 90,
  };
  const configPath = path.join(memoryDir, "config.yml");
  await writeAtomic(configPath, YAML.stringify(config));
  created.push(configPath);

  const readmePath = path.join(memoryDir, "README.md");
  const readmeContent = `# Team Memory

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
  await writeAtomic(readmePath, readmeContent);
  created.push(readmePath);

  const gitignorePath = path.join(projectDir, ".gitignore");
  if (await exists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, "utf8");
    if (!content.includes(".memory/INDEX.md")) {
      const updated = content.trimEnd() + "\n\n# teamrecall (auto-generated)\n.memory/INDEX.md\n";
      await writeAtomic(gitignorePath, updated);
      created.push(gitignorePath);
    }
  }

  return {
    created,
    message: [
      "✓ Initialized teamrecall",
      "",
      "Next steps:",
      "1. Run `teamrecall compile` to generate rules for your agents",
      "2. Run `gh secret set CLAUDE_CODE_OAUTH_TOKEN` to enable auto-learning (optional)",
      "3. Add memories in `.memory/memories/M-xxx-slug.md`",
      "",
      "See `.memory/README.md` for memory format.",
    ].join("\n"),
  };
}
