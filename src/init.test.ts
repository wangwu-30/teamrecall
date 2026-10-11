import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRuleSources, extractRuleLessons } from "./backfill.js";
import { runDoctor } from "./doctor.js";
import {
  HUMAN_ACTIONS_SETTING,
  HUMAN_SECRET_COMMAND,
  humanOnboardingActions,
  initProject,
  loadWorkflowTemplate,
  runInitCommand,
  toInitJson,
} from "./init.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-init-"));
  dirs.push(dir);
  return dir;
}

describe("initProject", () => {
  it("scaffolds memory dirs, config, workflow, and compiled AGENTS.md", async () => {
    const dir = await tmp();
    const result = await initProject(dir, { backfill: false, openPr: false });
    expect(result.created.some((file) => file.endsWith(path.join(".memory", "config.yml")))).toBe(true);
    await expect(fs.stat(path.join(dir, ".memory", "memories"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(dir, ".memory", "retired"))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(dir, ".github", "workflows", "teamrecall.yml"), "utf8")).resolves.toContain("teamrecall");
    await expect(fs.readFile(path.join(dir, ".github", "workflows", "teamrecall-sweep.yml"), "utf8")).resolves.toContain("sweep --pr");
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).resolves.toContain("teamrecall:start");
    await expect(fs.readFile(path.join(dir, ".github", "copilot-instructions.md"), "utf8")).resolves.toContain("teamrecall:start");
  });

  it("re-runs without throwing and without duplicating memories", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      "## Retries\n\nNever retry in the service layer; register retries only in the gateway wrapper so callers see one policy.\n",
      "utf8",
    );
    const first = await initProject(dir, { backfill: true, openPr: false });
    expect(first.reused).toBe(false);
    const memories = path.join(dir, ".memory", "memories");
    const before = await fs.readdir(memories);
    expect(before.length).toBeGreaterThan(0);

    const second = await initProject(dir, { backfill: true, openPr: false });
    expect(second.reused).toBe(true);
    expect(second.skipped).toContain(path.join(dir, ".memory"));
    expect(second.skipped).toContain("backfill");
    const after = await fs.readdir(memories);
    expect(after).toEqual(before);
  });

  it("does not roll back an existing .memory/ if a later step fails", async () => {
    const dir = await tmp();
    await initProject(dir, { backfill: false, openPr: false });
    await fs.rm(path.join(dir, "AGENTS.md"));
    await fs.mkdir(path.join(dir, "AGENTS.md"), { recursive: true });
    await expect(initProject(dir, { backfill: false, openPr: false })).rejects.toThrow();
    await expect(fs.access(path.join(dir, ".memory", "config.yml"))).resolves.toBeUndefined();
  });

  it("prints a machine-readable --json summary and default --yes human actions", async () => {
    const dir = await tmp();
    const summary = await runInitCommand({
      projectDir: dir,
      backfill: false,
      skipPr: true,
      json: true,
      yes: true,
    });
    expect(summary.ok).toBe(true);
    expect(summary.reused).toBe(false);
    expect(summary.created).toEqual(expect.arrayContaining([
      path.join(".memory", "config.yml"),
      path.join(".github", "workflows", "teamrecall.yml"),
    ]));
    expect(summary.human_actions).toEqual([HUMAN_SECRET_COMMAND, HUMAN_ACTIONS_SETTING]);
    expect(summary.pr_url).toBeNull();
    expect(summary.doctor?.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);

    const again = await runInitCommand({
      projectDir: dir,
      backfill: false,
      skipPr: true,
      json: true,
      yes: true,
    });
    expect(again.ok).toBe(true);
    expect(again.reused).toBe(true);
    expect(again.skipped.length).toBeGreaterThan(0);
  });

  it("lists only the Actions setting when the secret is already set", () => {
    expect(humanOnboardingActions(true)).toEqual([HUMAN_ACTIONS_SETTING]);
    const encoded = toInitJson({
      result: {
        created: [],
        written: [],
        skipped: [],
        reused: true,
        message: "ok",
        secret_set: true,
      },
      projectDir: "/tmp/x",
    });
    expect(encoded.human_actions).toEqual([HUMAN_ACTIONS_SETTING]);
    expect(encoded.secret_set).toBe(true);
  });

  it("copies the workflow template instead of an inline copy", async () => {
    const dir = await tmp();
    await initProject(dir, { backfill: false, openPr: false });
    const written = await fs.readFile(path.join(dir, ".github", "workflows", "teamrecall.yml"), "utf8");
    expect(written).toBe(await loadWorkflowTemplate());
    expect(written).not.toContain("npm install -g teamrecall");
  });

  it("reads *.mdc files when .cursor/rules is a directory", async () => {
    const dir = await tmp();
    await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".cursor", "rules", "retries.mdc"),
      "## Retries\n\nNever retry in the service layer; register retries only in the gateway wrapper so callers see one policy.\n",
      "utf8",
    );
    const sources = await collectRuleSources(dir);
    expect(sources.some((source) => source.source.endsWith("retries.mdc"))).toBe(true);

    const result = await initProject(dir, { backfill: true, openPr: false });
    expect(result.created.some((file) => file.includes(".memory/memories"))).toBe(true);
  });

  it("removes a half-built .memory/ so init can be retried after failure", async () => {
    const dir = await tmp();
    await fs.mkdir(path.join(dir, "AGENTS.md"), { recursive: true });
    await expect(initProject(dir, { backfill: false, openPr: false })).rejects.toThrow();
    await expect(fs.access(path.join(dir, ".memory"))).rejects.toThrow();
    await fs.rm(path.join(dir, "AGENTS.md"), { recursive: true, force: true });
    await expect(initProject(dir, { backfill: false, openPr: false })).resolves.toBeTruthy();
  });

  it("backfills conventions from CLAUDE.md", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      "## Retries\n\nNever retry in the service layer; register retries only in the gateway wrapper so callers see one policy.\n",
      "utf8",
    );
    const result = await initProject(dir, { backfill: true, openPr: false });
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    expect(files.length).toBeGreaterThan(0);
    expect(result.created.some((file) => file.includes(".memory/memories"))).toBe(true);
    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@.memory/INDEX.md");
  });
});

describe("extractRuleLessons", () => {
  it("turns headings into convention memories", () => {
    const lessons = extractRuleLessons(
      "## Auth\n\nNever store session tokens in localStorage; keep them in httpOnly cookies instead.\n",
      "CLAUDE.md",
    );
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0].action).toBe("new");
    expect(lessons[0].kind).toBe("convention");
    expect(lessons[0].paths).toEqual(["**/*"]);
    expect(lessons[0].body).toMatch(/httpOnly/i);
  });
});

describe("runDoctor", () => {
  it("fails before init and passes after", async () => {
    const dir = await tmp();
    const before = await runDoctor(dir);
    expect(before.ok).toBe(false);
    expect(before.checks.some((check) => check.name === "memory_directory" && !check.ok)).toBe(true);

    await initProject(dir, { backfill: false, openPr: false });
    const after = await runDoctor(dir);
    expect(after.checks.find((check) => check.name === "memory_directory")?.ok).toBe(true);
    expect(after.checks.find((check) => check.name === "memories_directory")?.ok).toBe(true);
    expect(after.checks.find((check) => check.name === "agents_md_block")?.ok).toBe(true);
    expect(after.checks.find((check) => check.name === "copilot_block")?.ok).toBe(true);
    expect(after.checks.some((check) => check.name === "claude_cli")).toBe(true);
    expect(after.checks.some((check) => check.name === "codex_cli")).toBe(true);
    expect(after.checks.find((check) => check.name === "stale_generated_rules")?.ok).toBe(true);
  });

  it("flags a missing CLAUDE.md managed block and stale generated rules", async () => {
    const dir = await tmp();
    await initProject(dir, { backfill: false, openPr: false });
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# no block\n", "utf8");
    await fs.mkdir(path.join(dir, ".claude", "rules", "teamrecall"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", "rules", "teamrecall", "M-099.md"), "stale\n", "utf8");
    const result = await runDoctor(dir);
    expect(result.checks.find((check) => check.name === "claude_md_block")?.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "stale_generated_rules")?.ok).toBe(false);
  });
});
