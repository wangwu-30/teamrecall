import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Memory, CompiledOutput } from "./types.js";
import { exists, readText, replaceManagedBlock, writeAtomic } from "./utils/atomic.js";

const TEAMRECALL_START = "<!-- teamrecall:start -->";
const TEAMRECALL_END = "<!-- teamrecall:end -->";

export async function compileMemories(
  projectDir: string,
  memories: Memory[],
): Promise<CompiledOutput> {
  const activeMemories = memories.filter((m) => m.frontmatter.status === "active");

  const indexContent = generateIndexMd(activeMemories);
  const agentsBlock = generateAgentsMdBlock(activeMemories);
  const claudeRules = generateClaudeRules(activeMemories);
  const cursorRules = generateCursorRules(activeMemories);

  return {
    agents_md: agentsBlock,
    index_md: indexContent,
    claude_rules: claudeRules,
    cursor_rules: cursorRules,
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
  for (const mem of memories) {
    const kind = mem.frontmatter.kind;
    if (!byKind.has(kind)) {
      byKind.set(kind, []);
    }
    byKind.get(kind)!.push(mem);
  }

  const kindTitles = {
    gotcha: "⚠️ Gotchas",
    decision: "🎯 Decisions",
    convention: "📏 Conventions",
    map: "🗺️ Maps",
  };

  for (const [kind, title] of Object.entries(kindTitles)) {
    const mems = byKind.get(kind) || [];
    if (mems.length === 0) continue;

    lines.push(`## ${title}`, "");
    for (const mem of mems) {
      const title = extractTitle(mem.body);
      const evidence = formatEvidence(mem.frontmatter.evidence);
      lines.push(`- **${mem.frontmatter.id}**: ${title} ${evidence}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateAgentsMdBlock(memories: Memory[]): string {
  if (memories.length === 0) {
    return "No active team memories.";
  }

  const lines = [
    "## Team Memory",
    "",
    `The team has ${memories.length} active memories from code review:`,
    "",
  ];

  for (const mem of memories.slice(0, 10)) {
    const title = extractTitle(mem.body);
    const paths = mem.frontmatter.paths.length > 0
      ? ` (${mem.frontmatter.paths.slice(0, 2).join(", ")})`
      : "";
    lines.push(`- **${mem.frontmatter.id}**: ${title}${paths}`);
  }

  if (memories.length > 10) {
    lines.push(`- …and ${memories.length - 10} more`);
  }

  lines.push("", "See `.memory/INDEX.md` for full details.");

  return lines.join("\n");
}

function generateClaudeRules(memories: Memory[]): Map<string, string> {
  const rules = new Map<string, string>();

  for (const mem of memories) {
    const filename = `${mem.frontmatter.id}.md`;
    const content = [
      "---",
      `paths: ${JSON.stringify(mem.frontmatter.paths)}`,
      "---",
      "",
      `# ${mem.frontmatter.id}: ${extractTitle(mem.body)}`,
      "",
      mem.body,
      "",
      `*From ${mem.frontmatter.evidence.pr || "code review"} by @${mem.frontmatter.author}*`,
    ].join("\n");

    rules.set(filename, content);
  }

  return rules;
}

function generateCursorRules(memories: Memory[]): Map<string, string> {
  const rules = new Map<string, string>();

  for (const mem of memories) {
    const filename = `teamrecall-${mem.frontmatter.id}.mdc`;
    const globs = mem.frontmatter.paths.length > 0
      ? mem.frontmatter.paths
      : ["**/*"];

    const content = [
      "---",
      `globs: ${JSON.stringify(globs)}`,
      "---",
      "",
      `# ${mem.frontmatter.id}: ${extractTitle(mem.body)}`,
      "",
      mem.body,
      "",
      `*From ${mem.frontmatter.evidence.pr || "code review"} by @${mem.frontmatter.author}*`,
    ].join("\n");

    rules.set(filename, content);
  }

  return rules;
}

function extractTitle(body: string): string {
  const lines = body.trim().split("\n");
  const firstLine = lines[0] || "";
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
  const currentAgentsMd = await readText(agentsMdPath);
  const updatedAgentsMd = replaceManagedBlock(
    currentAgentsMd,
    TEAMRECALL_START,
    TEAMRECALL_END,
    compiled.agents_md,
  );
  await writeAtomic(agentsMdPath, updatedAgentsMd);
  written.push(agentsMdPath);

  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (await exists(claudeMdPath)) {
    const currentClaudeMd = await readText(claudeMdPath);
    const importLine = "@.memory/INDEX.md";
    if (!currentClaudeMd.includes(importLine)) {
      const updated = currentClaudeMd.trimEnd() + `\n\n${importLine}\n`;
      await writeAtomic(claudeMdPath, updated);
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
