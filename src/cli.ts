#!/usr/bin/env node

import { program } from "commander";
import * as path from "node:path";
import { compileMemories, writeCompiledFiles } from "./compiler.js";
import { runDoctor } from "./doctor.js";
import { initProject } from "./init.js";
import { loadMemories } from "./memory.js";

program
  .name("teamrecall")
  .description("Git-native team memory for Claude Code, Codex, and Cursor")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize teamrecall in the current repository")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    try {
      const projectDir = path.resolve(options.dir);
      console.log(`Initializing teamrecall in ${projectDir}...`);
      const result = await initProject(projectDir);
      console.log(`\n✓ Created ${result.created.length} files:`);
      for (const file of result.created) {
        console.log(`  ${path.relative(projectDir, file)}`);
      }
      console.log(`\n${result.message}`);
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
      const activeCount = memories.filter((m) => m.frontmatter.status === "active").length;
      console.log(`Found ${memories.length} memories (${activeCount} active)`);

      console.log("Compiling...");
      const compiled = await compileMemories(projectDir, memories);
      const written = await writeCompiledFiles(projectDir, compiled);

      console.log(`\n✓ Compiled ${activeCount} memories into ${written.length} files:`);
      for (const file of written.slice(0, 5)) {
        console.log(`  ${path.relative(projectDir, file)}`);
      }
      if (written.length > 5) {
        console.log(`  ...and ${written.length - 5} more`);
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
  .description("Learn from a PR (local mode, requires claude or codex CLI)")
  .argument("<pr>", "PR number (e.g., 42)")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (pr, options) => {
    try {
      const projectDir = path.resolve(options.dir);
      console.log(`Learning from PR #${pr}...`);
      console.log("\n⚠️  This command is a stub for v0.1");
      console.log("To implement:");
      console.log("1. Fetch PR data with `gh pr view`");
      console.log("2. Generate distillation prompt");
      console.log("3. Run `claude -p` or `codex exec`");
      console.log("4. Parse outcome and create memory file");
      console.log("5. Open PR with `gh pr create`");
      console.log("\nSee src/learn.ts for the distillation logic.");
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program.parse();
