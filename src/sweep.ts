import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { MANAGED_GIT_PATHS, assertManagedPathsClean, openPullRequest } from "./github.js";
import { formatMemory, isoDate, loadMemories } from "./memory.js";
import type { Memory } from "./types.js";
import { writeAtomic } from "./utils/atomic.js";
import { isGitRepo } from "./utils/git.js";

const exec = promisify(execFile);

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);

export interface SweepFinding {
  id: string;
  reason: "expired" | "path-dead";
  detail: string;
  filepath: string;
}

export interface SweepReport {
  expired: SweepFinding[];
  path_dead: SweepFinding[];
  written: string[];
  pr_url?: string | null;
}

/** Expand `{a,b}` / `{a,{b,c}}` the same way agent globs (Claude/Cursor) do. */
export function expandBraces(glob: string): string[] {
  const group = findBraceGroup(glob);
  if (!group) return [glob];
  return group.alts.flatMap((alt) => expandBraces(`${group.prefix}${alt}${group.suffix}`));
}

function findBraceGroup(glob: string): { prefix: string; alts: string[]; suffix: string } | null {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "\\") {
      i += 1;
      continue;
    }
    if (glob[i] !== "{") continue;
    let depth = 1;
    let current = "";
    const parts: string[] = [];
    for (let j = i + 1; j < glob.length; j++) {
      const ch = glob[j]!;
      if (ch === "\\") {
        current += ch + (glob[j + 1] ?? "");
        j += 1;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        current += ch;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          if (parts.length === 0) break;
          parts.push(current);
          return { prefix: glob.slice(0, i), alts: parts, suffix: glob.slice(j + 1) };
        }
        current += ch;
        continue;
      }
      if (ch === "," && depth === 1) {
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
  }
  return null;
}

export function globToRegExp(glob: string): RegExp {
  let rest = glob;
  let out = "^";
  while (rest.length > 0) {
    if (rest.startsWith("**/")) {
      out += "(?:.*/)?";
      rest = rest.slice(3);
    } else if (rest.startsWith("**")) {
      out += ".*";
      rest = rest.slice(2);
    } else if (rest[0] === "*") {
      out += "[^/]*";
      rest = rest.slice(1);
    } else if (rest[0] === "?") {
      out += "[^/]";
      rest = rest.slice(1);
    } else if (rest[0] === "[") {
      const end = rest.indexOf("]");
      if (end > 0) {
        out += rest.slice(0, end + 1);
        rest = rest.slice(end + 1);
      } else {
        out += "\\[";
        rest = rest.slice(1);
      }
    } else {
      const ch = rest[0]!;
      out += /[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch;
      rest = rest.slice(1);
    }
  }
  return new RegExp(`${out}$`);
}

export function globMatches(glob: string, file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return expandBraces(glob).some((pattern) => globToRegExp(pattern).test(normalized));
}

export async function listRepoFiles(projectDir: string): Promise<string[]> {
  if (await isGitRepo(projectDir)) {
    try {
      const { stdout } = await exec("git", ["ls-files", "-z"], {
        cwd: projectDir,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.split("\0").filter(Boolean);
    } catch {
      return [];
    }
  }
  return walkRepoFiles(projectDir);
}

async function walkRepoFiles(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(projectDir, full).replaceAll("\\", "/"));
      }
    }
  }
  await walk(projectDir);
  return files;
}

export function isPathDead(memory: Memory, files: string[]): boolean {
  const globs = memory.frontmatter.paths.filter(Boolean);
  if (globs.length === 0) return false;
  return !globs.some((glob) => files.some((file) => globMatches(glob, file)));
}

export function isExpired(memory: Memory, today = isoDate()): boolean {
  return memory.frontmatter.review_after < today;
}

export function formatSweepReport(report: SweepReport): string {
  const lines = [
    "# teamrecall sweep",
    "",
    `Path-dead: ${report.path_dead.length}. Expired: ${report.expired.length}.`,
    "",
  ];
  if (report.path_dead.length > 0) {
    lines.push("## Propose retirement (paths match no files)", "");
    for (const finding of report.path_dead) {
      lines.push(`- **${finding.id}**: ${finding.detail}`);
    }
    lines.push("");
  }
  if (report.expired.length > 0) {
    lines.push("## Review checklist (review_after passed)", "");
    for (const finding of report.expired) {
      lines.push(`- [ ] **${finding.id}**: ${finding.detail} — renew, rewrite, or retire?`);
    }
    lines.push("");
  }
  if (report.path_dead.length === 0 && report.expired.length === 0) {
    lines.push("No stale memories.");
    lines.push("");
  }
  return lines.join("\n");
}

export async function runSweep(input: {
  projectDir: string;
  openPr?: boolean;
  today?: string;
}): Promise<SweepReport> {
  const projectDir = path.resolve(input.projectDir);
  if (input.openPr) {
    await assertManagedPathsClean(projectDir);
  }

  const memories = await loadMemories(projectDir);
  const files = await listRepoFiles(projectDir);
  const today = input.today ?? isoDate();
  const expired: SweepFinding[] = [];
  const pathDead: SweepFinding[] = [];

  for (const memory of memories) {
    if (memory.frontmatter.status !== "active") continue;
    if (isExpired(memory, today)) {
      expired.push({
        id: memory.frontmatter.id,
        reason: "expired",
        detail: `review_after ${memory.frontmatter.review_after}`,
        filepath: memory.filepath,
      });
    }
    if (isPathDead(memory, files)) {
      pathDead.push({
        id: memory.frontmatter.id,
        reason: "path-dead",
        detail: `paths ${memory.frontmatter.paths.join(", ")} match no files`,
        filepath: memory.filepath,
      });
    }
  }

  const report: SweepReport = { expired, path_dead: pathDead, written: [] };
  if (!input.openPr) {
    return report;
  }

  const written: string[] = [];
  for (const finding of pathDead) {
    const memory = memories.find((item) => item.frontmatter.id === finding.id);
    if (!memory) continue;
    const dest = path.join(projectDir, ".memory", "retired", path.basename(memory.filepath));
    await writeAtomic(dest, formatMemory({ ...memory.frontmatter, status: "retired" }, memory.body));
    await fs.rm(memory.filepath, { force: true });
    written.push(dest);
  }

  if (pathDead.length > 0 || expired.length > 0) {
    const sweepPath = path.join(projectDir, ".memory", "SWEEP.md");
    await writeAtomic(sweepPath, formatSweepReport(report));
    written.push(sweepPath);
    const compiled = await compileMemories(projectDir, await loadMemories(projectDir));
    written.push(...await writeCompiledFiles(projectDir, compiled));
  }

  report.written = written;
  if (written.length > 0) {
    report.pr_url = await openPullRequest({
      cwd: projectDir,
      branch: "teamrecall/sweep",
      title: `🧠 teamrecall: sweep (${pathDead.length} path-dead, ${expired.length} expired)`,
      body: formatSweepReport(report),
      files: [...MANAGED_GIT_PATHS],
      force: true,
    });
  }

  return report;
}
