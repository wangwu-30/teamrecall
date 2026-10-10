import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AGENTS_INDEX_MAX_LINES,
  CLAUDE_INDEX_IMPORT,
  MAX_ACTIVE_MEMORIES,
  TEAMRECALL_END,
  TEAMRECALL_START,
} from "./constants.js";
import type { CompiledOutput, Memory } from "./types.js";
import { exists, readText, replaceManagedBlock, writeAtomic } from "./utils/atomic.js";

export { TEAMRECALL_END, TEAMRECALL_START };

export async function compileMemories(
  _projectDir: string,
  memories: Memory[],
): Promise<CompiledOutput> {
  const activeMemories = memories
    .filter((memory) => memory.frontmatter.status === "active")
    .slice(0, MAX_ACTIVE_MEMORIES);

  return {
    agents_md: generateAgentsMdBlock(activeMemories),
    index_md: generateIndexMd(activeMemories),
    claude_rules: generateClaudeRules(activeMemories),
    cursor_rules: generateCursorRules(activeMemories),
  };
}

function generateIndexMd(memories: Memory[]): string {
  const lines = [
    "# Team Memory Index",
    "",
    "Team memories captured from code review. Referenced automatically by Claude Code, Codex, and Cursor.",
    "",
  ];

  const byKind = new Map<string, Memory[]>();
  for (const memory of memories) {
    const kind = memory.frontmatter.kind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(memory);
  }

  const kindTitles = {
    gotcha: "⚠️ Gotchas",
    decision: "🎯 Decisions",
    convention: "📏 Conventions",
    map: "🗺️ Maps",
  };

  for (const [kind, heading] of Object.entries(kindTitles)) {
    const group = byKind.get(kind) || [];
    if (group.length === 0) continue;
    lines.push(`## ${heading}`, "");
    for (const memory of group) {
      lines.push(`- **${memory.frontmatter.id}**: ${extractTitle(memory.body)} ${formatEvidence(memory.frontmatter.evidence)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function generateAgentsMdBlock(memories: Memory[]): string {
  if (memories.length === 0) {
    return "No active team memories.";
  }

  const header = [
    "## Team Memory",
    "",
    `The team has ${memories.length} active memories from code review:`,
    "",
  ];
  const footer = ["", "See `.memory/INDEX.md` for full details."];
  const reserved = header.length + footer.length;
  const items: string[] = [];

  for (const memory of memories) {
    const title = extractTitle(memory.body);
    const paths = memory.frontmatter.paths.length > 0
      ? ` (${memory.frontmatter.paths.slice(0, 2).join(", ")})`
      : "";
    items.push(`- **${memory.frontmatter.id}**: ${title}${paths}`);
    if (reserved + items.length + 1 > AGENTS_INDEX_MAX_LINES) {
      items.pop();
      items.push(`- …and ${memories.length - items.length} more`);
      break;
    }
  }

  const block = [...header, ...items, ...footer].join("\n");
  const lines = block.split("\n");
  if (lines.length > AGENTS_INDEX_MAX_LINES) {
    return lines.slice(0, AGENTS_INDEX_MAX_LINES).join("\n");
  }
  return block;
}

function generateClaudeRules(memories: Memory[]): Map<string, string> {
  const rules = new Map<string, string>();

  for (const memory of memories) {
    const paths = memory.frontmatter.paths;
    const frontmatter = paths.length > 0
      ? ["---", "paths:", ...paths.map((glob) => `  - ${JSON.stringify(glob)}`), "---"].join("\n")
      : "---\n---";

    const content = [
      frontmatter,
      "",
      `# ${memory.frontmatter.id}: ${extractTitle(memory.body)}`,
      "",
      memory.body,
      "",
      `*From ${memory.frontmatter.evidence.pr || "code review"} by @${memory.frontmatter.author}*`,
      "",
    ].join("\n");

    rules.set(`${memory.frontmatter.id}.md`, content);
  }

  return rules;
}

function generateCursorRules(memories: Memory[]): Map<string, string> {
  const rules = new Map<string, string>();

  for (const memory of memories) {
    const title = extractTitle(memory.body);
    const paths = memory.frontmatter.paths;
    const frontmatter = paths.length > 0
      ? [
          "---",
          `description: ${JSON.stringify(`${memory.frontmatter.id}: ${title}`)}`,
          `globs: ${paths.join(", ")}`,
          "alwaysApply: false",
          "---",
        ].join("\n")
      : [
          "---",
          `description: ${JSON.stringify(`${memory.frontmatter.id}: ${title}`)}`,
          "alwaysApply: true",
          "---",
        ].join("\n");

    const content = [
      frontmatter,
      "",
      `# ${memory.frontmatter.id}: ${title}`,
      "",
      memory.body,
      "",
      `*From ${memory.frontmatter.evidence.pr || "code review"} by @${memory.frontmatter.author}*`,
      "",
    ].join("\n");

    rules.set(`teamrecall-${memory.frontmatter.id}.mdc`, content);
  }

  return rules;
}

export function extractTitle(body: string): string {
  const firstLine = body.trim().split("\n")[0] || "";
  return firstLine.replace(/^#+\s*/, "").slice(0, 80);
}

function formatEvidence(evidence: { pr?: string; review_url?: string; commits?: string[] }): string {
  const parts: string[] = [];
  if (evidence.pr) parts.push(`[${evidence.pr}]`);
  if (evidence.review_url) parts.push(`([review](${evidence.review_url}))`);
  return parts.length > 0 ? `— ${parts.join(" ")}` : "";
}

export async function writeCompiledFiles(
  projectDir: string,
  compiled: CompiledOutput,
): Promise<string[]> {
  const written: string[] = [];

  const indexPath = path.join(projectDir, ".memory", "INDEX.md");
  await writeAtomic(indexPath, compiled.index_md);
  written.push(indexPath);

  const agentsMdPath = path.join(projectDir, "AGENTS.md");
  const updatedAgentsMd = replaceManagedBlock(
    await readText(agentsMdPath),
    TEAMRECALL_START,
    TEAMRECALL_END,
    compiled.agents_md,
  );
  await writeAtomic(agentsMdPath, updatedAgentsMd);
  written.push(agentsMdPath);

  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (await exists(claudeMdPath)) {
    const currentClaudeMd = await readText(claudeMdPath);
    if (!currentClaudeMd.includes(CLAUDE_INDEX_IMPORT)) {
      await writeAtomic(claudeMdPath, `${currentClaudeMd.trimEnd()}\n\n${CLAUDE_INDEX_IMPORT}\n`);
      written.push(claudeMdPath);
    }
  }

  const claudeRulesDir = path.join(projectDir, ".claude", "rules", "teamrecall");
  await fs.mkdir(claudeRulesDir, { recursive: true });
  for (const [filename, content] of compiled.claude_rules.entries()) {
    const filepath = path.join(claudeRulesDir, filename);
    await writeAtomic(filepath, content);
    written.push(filepath);
  }

  const cursorRulesDir = path.join(projectDir, ".cursor", "rules");
  await fs.mkdir(cursorRulesDir, { recursive: true });
  for (const [filename, content] of compiled.cursor_rules.entries()) {
    const filepath = path.join(cursorRulesDir, filename);
    await writeAtomic(filepath, content);
    written.push(filepath);
  }

  return written;
}
