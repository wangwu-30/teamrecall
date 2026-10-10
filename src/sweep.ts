import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { MANAGED_GIT_PATHS, assertManagedPathsClean, openPullRequest } from "./github.js";
import { formatMemory, isoDate, loadMemories } from "./memory.js";
import type { Memory } from "./types.js";
import { writeAtomic } from "./utils/atomic.js";

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
    } else {
      const ch = rest[0]!;
      out += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      rest = rest.slice(1);
    }
  }
  return new RegExp(`${out}$`);
}

export function globMatches(glob: string, file: string): boolean {
  return globToRegExp(glob).test(file.replaceAll("\\", "/"));
}

export async function listRepoFiles(projectDir: string): Promise<string[]> {
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

  const written: string[] = [];
  for (const finding of pathDead) {
    const memory = memories.find((item) => item.frontmatter.id === finding.id);
    if (!memory) continue;
    const dest = path.join(projectDir, ".memory", "retired", path.basename(memory.filepath));
    await writeAtomic(dest, formatMemory({ ...memory.frontmatter, status: "retired" }, memory.body));
    await fs.rm(memory.filepath, { force: true });
    written.push(dest);
  }

  const report: SweepReport = { expired, path_dead: pathDead, written };
  if (pathDead.length > 0 || expired.length > 0) {
    const sweepPath = path.join(projectDir, ".memory", "SWEEP.md");
    await writeAtomic(sweepPath, formatSweepReport(report));
    written.push(sweepPath);
    const compiled = await compileMemories(projectDir, await loadMemories(projectDir));
    written.push(...await writeCompiledFiles(projectDir, compiled));
  }

  if (input.openPr && written.length > 0) {
    report.pr_url = await openPullRequest({
      cwd: projectDir,
      branch: "teamrecall/sweep",
      title: `🧠 teamrecall: sweep (${pathDead.length} path-dead, ${expired.length} expired)`,
      body: formatSweepReport(report),
      files: [...MANAGED_GIT_PATHS],
    });
  }

  return report;
}
