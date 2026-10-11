#!/usr/bin/env node

import { program } from "commander";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { runDoctor } from "./doctor.js";
import { runInitCommand } from "./init.js";
import { runLearn, shouldOpenLearnPr } from "./learn-run.js";
import { loadMemories } from "./memory.js";
import { formatRetrieveText, runRetrieve } from "./retrieve.js";
import { formatSweepReport, runSweep } from "./sweep.js";

program
  .name("teamrecall")
  .description("Git-native team memory for Claude Code, Codex, and Cursor")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize teamrecall in the current repository (non-interactive, re-run safe)")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-y, --yes", "Non-interactive; never prompt (default)", true)
  .option("--json", "Print a machine-readable JSON summary")
  .option("--skip-backfill", "Skip backfill from existing rules / recent PRs")
  .option("--skip-pr", "Do not open a first PR")
  .action(async (options) => {
    const projectDir = path.resolve(options.dir);
    try {
      if (!options.json) console.log(`Initializing teamrecall in ${projectDir}...`);
      const summary = await runInitCommand({
        projectDir,
        backfill: !options.skipBackfill,
        skipPr: Boolean(options.skipPr),
        json: Boolean(options.json),
        yes: options.yes !== false,
      });
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(`\n✓ Created ${summary.created.length} files:`);
      for (const file of summary.created.slice(0, 12)) {
        console.log(`  ${file}`);
      }
      if (summary.skipped.length > 0) {
        console.log(`\nReused ${summary.skipped.length} existing paths (re-run safe).`);
      }
      console.log(`\n${summary.message}`);
      if (summary.pr_url) console.log(`\nOpened PR: ${summary.pr_url}`);
      else if (!options.skipPr) {
        console.log("\nNo first PR opened (nothing to commit, or git/gh unavailable).");
        if (summary.pr_error) console.log(`Could not open the first PR automatically: ${summary.pr_error}`);
      }
      console.log("\nHuman actions (if needed):");
      for (const action of summary.human_actions) {
        console.log(`  - ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      } else {
        console.error(`Error: ${message}`);
      }
      process.exit(1);
    }
  });

program
  .command("compile")
  .description("Compile memories into agent rules")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    try {
      const projectDir = path.resolve(options.dir);
      console.log(`Loading memories from ${projectDir}...`);
      const memories = await loadMemories(projectDir);
      const activeCount = memories.filter((memory) => memory.frontmatter.status === "active").length;
      console.log(`Found ${memories.length} memories (${activeCount} active)`);

      const compiled = await compileMemories(projectDir, memories);
      const written = await writeCompiledFiles(projectDir, compiled);

      console.log(`\n✓ Compiled ${activeCount} memories into ${written.length} files:`);
      for (const file of written.slice(0, 8)) {
        console.log(`  ${path.relative(projectDir, file)}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Check teamrecall installation and configuration")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    try {
      const projectDir = path.resolve(options.dir);
      console.log(`Running diagnostics for ${projectDir}...\n`);
      const result = await runDoctor(projectDir);

      for (const check of result.checks) {
        const icon = check.ok ? "✓" : check.severity === "warning" ? "⚠" : "✗";
        const color = check.ok ? "\x1b[32m" : check.severity === "warning" ? "\x1b[33m" : "\x1b[31m";
        console.log(`${color}${icon}\x1b[0m ${check.name}: ${check.detail}`);
      }

      console.log(`\n${result.ok ? "✓ All checks passed" : "✗ Some checks failed"}`);
      process.exit(result.ok ? 0 : 1);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("learn")
  .description("Learn from a PR (local mode uses claude -p or codex exec, then gh)")
  .argument("<pr>", "PR number (e.g., 42)")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--ci", "CI mode: compile and open a bot PR when there are changes")
  .option("--pr", "Open a bot PR (local learn defaults to no PR)")
  .action(async (pr, options) => {
    try {
      const projectDir = path.resolve(options.dir);
      console.log(`Learning from PR #${pr}...`);
      const result = await runLearn({
        projectDir,
        pr: String(pr),
        openPr: shouldOpenLearnPr({ ci: Boolean(options.ci), pr: Boolean(options.pr) }),
        ci: Boolean(options.ci),
      });

      console.log(`Outcome: ${result.plan.summary}`);
      for (const outcome of result.plan.outcomes) {
        console.log(`- ${outcome.action}${outcome.memory_id ? ` ${outcome.memory_id}` : ""}: ${outcome.reasoning}`);
      }
      if (result.pr_url) console.log(`PR: ${result.pr_url}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("retrieve")
  .description("Rank memories for changed files (BM25 + path/trigger boost). No LLM.")
  .argument("[files...]", "Changed file paths")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--title <title>", "PR or task title")
  .option("--body <body>", "PR or task body")
  .option("-k, --top <n>", "Top-k triggered memories", "5")
  .option("--always-cap <n>", "Max always memories (counts toward injection)", "8")
  .option("--json", "Print JSON instead of text")
  .action(async (files: string[], options) => {
    try {
      const projectDir = path.resolve(options.dir);
      const diff = process.stdin.isTTY ? "" : await readStdin();
      const result = await runRetrieve({
        projectDir,
        files,
        diff,
        title: options.title,
        body: options.body,
        k: Number.parseInt(String(options.top), 10) || 5,
        alwaysCap: Number.parseInt(String(options.alwaysCap), 10) || 8,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      process.stdout.write(formatRetrieveText(result));
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("sweep")
  .description("Flag expired and path-dead memories; optionally open a review PR")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--pr", "Open a PR proposing retirement and a review checklist")
  .action(async (options) => {
    try {
      const projectDir = path.resolve(options.dir);
      const report = await runSweep({ projectDir, openPr: Boolean(options.pr) });
      process.stdout.write(formatSweepReport(report));
      if (report.pr_url) console.log(`PR: ${report.pr_url}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

program.parse();
