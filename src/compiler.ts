import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AGENTS_INDEX_MAX_LINES,
  CLAUDE_INDEX_IMPORT,
  COMPILE_ALWAYS_CAP,
  COMPILE_TRIGGERED_CAP,
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
  const catalog = memories
    .filter((memory) => memory.frontmatter.status === "active")
    .slice(0, MAX_ACTIVE_MEMORIES);
  const abandonedMemories = memories.filter((memory) => memory.frontmatter.status === "abandoned");
  const injected = selectInjectedMemories(catalog);
  const compact = generateCompactIndex(injected, abandonedMemories);

  return {
    agents_md: compact,
    index_md: generateIndexMd(catalog, abandonedMemories),
    compact_index: compact,
    claude_rules: generateClaudeRules(injected),
    cursor_rules: generateCursorRules(injected),
  };
}

export function selectInjectedMemories(active: Memory[]): Memory[] {
  const always = active.filter((memory) => memory.frontmatter.scope === "always").slice(0, COMPILE_ALWAYS_CAP);
  const triggered = active
    .filter((memory) => memory.frontmatter.scope !== "always")
    .slice(0, COMPILE_TRIGGERED_CAP);
  return [...always, ...triggered];
}

function generateIndexMd(active: Memory[], abandoned: Memory[]): string {
  const lines = [
    "# Team Memory Index",
    "",
    "Team memories captured from code review. Referenced automatically by Claude Code, Codex, Cursor, and Copilot.",
    "",
  ];

  const byKind = new Map<string, Memory[]>();
  for (const memory of active) {
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

  if (abandoned.length > 0) {
    lines.push("## Do not reintroduce", "");
    for (const memory of abandoned) {
      lines.push(`- **${memory.frontmatter.id}**: Do not reintroduce: ${extractTitle(memory.body)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function generateCompactIndex(active: Memory[], abandoned: Memory[] = []): string {
  if (active.length === 0 && abandoned.length === 0) {
    return "No active team memories.";
  }

  const header = [
    "## Team Memory",
    "",
    active.length > 0
      ? `The team has ${active.length} active memories from code review:`
      : "No active team memories.",
    "",
  ];
  const footer = ["", "See `.memory/INDEX.md` for full details.", CLAUDE_INDEX_IMPORT];
  const reserved = header.length + footer.length + (abandoned.length > 0 ? 3 : 0);
  const items: string[] = [];
  const ordered = [
    ...active.filter((memory) => memory.frontmatter.scope === "always"),
    ...active.filter((memory) => memory.frontmatter.scope !== "always"),
  ];

  for (const memory of ordered) {
    items.push(compactLine(memory));
    if (reserved + items.length + 1 > AGENTS_INDEX_MAX_LINES) {
      items.pop();
      items.push(`- …and ${active.length - items.length} more`);
      break;
    }
  }

  if (abandoned.length > 0) {
    items.push("", "### Do not reintroduce", "");
    for (const memory of abandoned) {
      items.push(`- **${memory.frontmatter.id}**: Do not reintroduce: ${extractTitle(memory.body)}`);
    }
  }

  const block = [...header, ...items, ...footer].join("\n");
  const lines = block.split("\n");
  if (lines.length > AGENTS_INDEX_MAX_LINES) {
    return lines.slice(0, AGENTS_INDEX_MAX_LINES).join("\n");
  }
  return block;
}

export function generateAgentsMdBlock(memories: Memory[]): string {
  const active = selectInjectedMemories(memories.filter((memory) => memory.frontmatter.status === "active"));
  const abandoned = memories.filter((memory) => memory.frontmatter.status === "abandoned");
  return generateCompactIndex(active, abandoned);
}

export function compactLine(memory: Memory): string {
  if (memory.frontmatter.scope === "always") {
    const oneLiner = memory.body.replace(/\s+/g, " ").trim();
    return `- **${memory.frontmatter.id}** [always]: ${oneLiner}`;
  }
  const title = extractTitle(memory.body);
  const paths = memory.frontmatter.paths.length > 0
    ? ` (${memory.frontmatter.paths.slice(0, 2).join(", ")})`
    : "";
  return `- **${memory.frontmatter.id}**: ${title}${paths}`;
}

export function indexIsCapped(block: string): boolean {
  return block.includes("…and ");
}

function generateClaudeRules(memories: Memory[]): Map<string, string> {
  const rules = new Map<string, string>();

  for (const memory of memories) {
    const explicitAlways = memory.frontmatter.scope === "always";
    const paths = memory.frontmatter.paths;
    const frontmatter = explicitAlways
      ? ["---", "paths:", '  - "**"', "---"].join("\n")
      : paths.length > 0
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
    const always = memory.frontmatter.scope === "always" || paths.length === 0;
    const frontmatter = always
      ? [
          "---",
          `description: ${JSON.stringify(`${memory.frontmatter.id}: ${title}`)}`,
          "alwaysApply: true",
          "---",
        ].join("\n")
      : [
          "---",
          `description: ${JSON.stringify(`${memory.frontmatter.id}: ${title}`)}`,
          `globs: ${paths.join(", ")}`,
          "alwaysApply: false",
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
  await writeAtomic(agentsMdPath, replaceManagedBlock(
    await readText(agentsMdPath),
    TEAMRECALL_START,
    TEAMRECALL_END,
    compiled.agents_md,
  ));
  written.push(agentsMdPath);

  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (await exists(claudeMdPath)) {
    await writeAtomic(claudeMdPath, replaceManagedBlock(
      await readText(claudeMdPath),
      TEAMRECALL_START,
      TEAMRECALL_END,
      compiled.compact_index,
    ));
    written.push(claudeMdPath);
  }

  const copilotPath = path.join(projectDir, ".github", "copilot-instructions.md");
  await writeAtomic(copilotPath, replaceManagedBlock(
    await readText(copilotPath),
    TEAMRECALL_START,
    TEAMRECALL_END,
    compiled.compact_index,
  ));
  written.push(copilotPath);

  const claudeRulesDir = path.join(projectDir, ".claude", "rules", "teamrecall");
  await fs.mkdir(claudeRulesDir, { recursive: true });
  await removeStaleRules(claudeRulesDir, compiled.claude_rules, /^M-.+\.md$/);
  for (const [filename, content] of compiled.claude_rules.entries()) {
    const filepath = path.join(claudeRulesDir, filename);
    await writeAtomic(filepath, content);
    written.push(filepath);
  }

  const cursorRulesDir = path.join(projectDir, ".cursor", "rules");
  await fs.mkdir(cursorRulesDir, { recursive: true });
  await removeStaleRules(cursorRulesDir, compiled.cursor_rules, /^teamrecall-M-.+\.mdc$/);
  for (const [filename, content] of compiled.cursor_rules.entries()) {
    const filepath = path.join(cursorRulesDir, filename);
    await writeAtomic(filepath, content);
    written.push(filepath);
  }

  return written;
}

export async function listStaleGeneratedRules(projectDir: string, activeIds: Set<string>): Promise<string[]> {
  const stale: string[] = [];
  const claudeDir = path.join(projectDir, ".claude", "rules", "teamrecall");
  if (await exists(claudeDir)) {
    for (const file of await fs.readdir(claudeDir)) {
      const match = file.match(/^(M-\d+)\.md$/);
      if (match && !activeIds.has(match[1])) stale.push(path.join(claudeDir, file));
    }
  }
  const cursorDir = path.join(projectDir, ".cursor", "rules");
  if (await exists(cursorDir)) {
    for (const file of await fs.readdir(cursorDir)) {
      const match = file.match(/^teamrecall-(M-\d+)\.mdc$/);
      if (match && !activeIds.has(match[1])) stale.push(path.join(cursorDir, file));
    }
  }
  return stale;
}

async function removeStaleRules(
  dir: string,
  keep: Map<string, string>,
  pattern: RegExp,
): Promise<void> {
  if (!(await exists(dir))) return;
  for (const file of await fs.readdir(dir)) {
    if (pattern.test(file) && !keep.has(file)) {
      await fs.rm(path.join(dir, file), { force: true });
    }
  }
}
