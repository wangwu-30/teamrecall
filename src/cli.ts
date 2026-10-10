#!/usr/bin/env node

import { program } from "commander";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { runDoctor } from "./doctor.js";
import { openPullRequest } from "./github.js";
import { initProject } from "./init.js";
import { runLearn, shouldOpenLearnPr } from "./learn-run.js";
import { loadMemories } from "./memory.js";
import { formatSweepReport, runSweep } from "./sweep.js";

program
  .name("teamrecall")
  .description("Git-native team memory for Claude Code, Codex, and Cursor")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize teamrecall in the current repository")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--skip-backfill", "Skip backfill from existing rules / recent PRs")
  .option("--skip-pr", "Do not open a first PR")
  .action(async (options) => {
    try {
      const projectDir = path.resolve(options.dir);
      console.log(`Initializing teamrecall in ${projectDir}...`);
      const result = await initProject(projectDir, {
        backfill: !options.skipBackfill,
        openPr: !options.skipPr,
      });
      console.log(`\n✓ Created ${result.created.length} files:`);
      for (const file of result.created.slice(0, 12)) {
        console.log(`  ${path.relative(projectDir, file)}`);
      }
      console.log(`\n${result.message}`);

      if (!options.skipPr) {
        try {
          const url = await openPullRequest({
            cwd: projectDir,
            branch: "teamrecall/init",
            title: "🧠 teamrecall: initialize team memory",
            body: "Scaffolds `.memory/`, compiles agent rules, and backfills lessons from existing CLAUDE.md / .cursorrules and recent merged PRs.",
            files: unique([...result.created, ...result.written].filter((file) => file !== projectDir && !file.endsWith(".memory"))),
          });
          if (url) console.log(`\nOpened PR: ${url}`);
          else console.log("\nNo first PR opened (nothing to commit, or git/gh unavailable).");
        } catch (error) {
          console.log(`\nCould not open the first PR automatically: ${error instanceof Error ? error.message : String(error)}`);
          console.log("Commit `.memory/`, AGENTS.md, and the workflow, then open a PR.");
        }
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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

program.parse();

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
