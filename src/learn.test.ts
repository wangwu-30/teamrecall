import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
import {
  DETERMINISTIC_DISTILLER_NOTE,
  LLM_FAILED_DISTILLER_NOTE,
  buildLearnPrBody,
  buildLearnPrTitle,
  checkDuplicate,
  detectConflicts,
  fallbackOutcomeFromReviews,
  forceUpdateIfDuplicate,
  generateDistillationPrompt,
  parseDistillationResponse,
  planLearnOutcomes,
} from "./learn.js";
import {
  claudeDistillArgs,
  hasLlmSecret,
  runLearn,
  runWithStdin,
  sanitisedChildEnv,
  shouldOpenLearnPr,
} from "./learn-run.js";
import { MANAGED_GIT_PATHS } from "./github.js";
import { parseMemory } from "./memory.js";
import type { Memory, PullRequestContext } from "./types.js";

function memory(id: string, body: string, paths = ["src/**/*.ts"]): Memory {
  return {
    frontmatter: {
      id,
      kind: "gotcha",
      paths,
      evidence: { pr: "#1" },
      author: "alice",
      created: "2026-10-10",
      review_after: "2027-01-08",
      status: "active",
    },
    body,
    filepath: `/tmp/.memory/memories/${id}.md`,
  };
}

function context(partial: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    number: "42",
    title: "Move retries to the gateway",
    body: "Review asked to keep retries in the wrapper.",
    url: "https://github.com/acme/app/pull/42",
    author: "alice",
    diff: "diff --git a/src/gateway.ts b/src/gateway.ts",
    review_comments: ["Retries should only happen in the gateway wrapper, not the service layer."],
    commit_messages: ["fix ci: register retry in wrapper"],
    commits: ["abc123"],
    files: ["src/gateway.ts"],
    ...partial,
  };
}

describe("parseDistillationResponse", () => {
  it("parses a fenced JSON outcome", () => {
    const parsed = parseDistillationResponse(`\`\`\`json
{
  "action": "new",
  "title": "Gateway retries",
  "kind": "gotcha",
  "paths": ["src/gateway/**"],
  "body": "Register retries only in the gateway wrapper.",
  "reasoning": "Review made a reusable decision"
}
\`\`\``);
    expect(parsed.action).toBe("new");
    expect(parsed.paths).toEqual(["src/gateway/**"]);
  });

  it("returns no_op for invalid JSON or unknown action", () => {
    expect(parseDistillationResponse("not json").action).toBe("no_op");
    expect(parseDistillationResponse('{"action":"explode","reasoning":"x"}').action).toBe("no_op");
  });
});

describe("generateDistillationPrompt", () => {
  it("includes the existing index to avoid dupes", () => {
    const prompt = generateDistillationPrompt({
      pr_number: "42",
      diff: "diff",
      pr_body: "body",
      review_comments: ["comment"],
      commit_messages: ["msg"],
      existing_memories: [memory("M-001", "Use retries only in the gateway wrapper.")],
    });
    expect(prompt).toContain("M-001");
    expect(prompt).toContain("no_op");
  });
});

describe("checkDuplicate", () => {
  const existing = [memory("M-012", "Use retries only in the gateway wrapper.", ["src/gateway/**"])];

  it("forces an update when title is similar and paths overlap", () => {
    const dup = checkDuplicate("Use retries only in the gateway wrapper.", ["src/gateway/**"], existing);
    expect(dup.is_duplicate).toBe(true);
    expect(dup.existing_id).toBe("M-012");
  });

  it("does not flag a different title on overlapping paths", () => {
    const dup = checkDuplicate("Prefer structured logging in the worker", ["src/gateway/**"], existing);
    expect(dup.is_duplicate).toBe(false);
  });

  it("does not flag a similar title on disjoint paths", () => {
    const dup = checkDuplicate("Use retries only in the gateway wrapper.", ["docs/**"], existing);
    expect(dup.is_duplicate).toBe(false);
  });
});

describe("forceUpdateIfDuplicate / planLearnOutcomes", () => {
  it("converts a duplicate new into update", () => {
    const existing = [memory("M-012", "Use retries only in the gateway wrapper.", ["src/gateway/**"])];
    const forced = forceUpdateIfDuplicate({
      action: "new",
      title: "Use retries only in the gateway wrapper.",
      paths: ["src/gateway/**"],
      body: "Use retries only in the gateway wrapper.",
      reasoning: "Looks new",
    }, existing);
    expect(forced.action).toBe("update");
    expect(forced.memory_id).toBe("M-012");
  });

  it("plans a new memory file and caps writes at 3", () => {
    const planned = planLearnOutcomes({
      action: "new",
      reasoning: "three lessons",
      memories: [
        { action: "new", title: "One", body: "One lesson about retries in the gateway wrapper only.", paths: ["src/**"], reasoning: "a" },
        { action: "new", title: "Two", body: "Two lesson about auth cookies staying httpOnly.", paths: ["src/**"], reasoning: "b" },
        { action: "new", title: "Three", body: "Three lesson about logging request ids.", paths: ["src/**"], reasoning: "c" },
        { action: "new", title: "Four", body: "Four should be dropped.", paths: ["src/**"], reasoning: "d" },
      ],
    }, [], context(), "/tmp/project");
    expect(planned.learned).toBe(3);
    expect(planned.mutations).toHaveLength(3);
    expect(buildLearnPrTitle(planned.learned, planned.updated, "42")).toBe("🧠 teamrecall: learned 3 (from #42)");
  });

  it("titles a retire-only result as retired, not no-op", () => {
    expect(buildLearnPrTitle(0, 0, "42", 1)).toBe("🧠 teamrecall: retired 1 (from #42)");
    expect(buildLearnPrTitle(1, 1, "7", 2)).toBe("🧠 teamrecall: learned 1, updated 1, retired 2 (from #7)");
    expect(buildLearnPrTitle(0, 0, "9", 0)).toBe("🧠 teamrecall: no-op (from #9)");
  });

  it("plans a retire by moving the file", () => {
    const existing = [memory("M-003", "Old rule.")];
    const planned = planLearnOutcomes({
      action: "propose_retire",
      memory_id: "M-003",
      reasoning: "Superseded",
    }, existing, context(), "/tmp/project");
    expect(planned.retired).toBe(1);
    expect(planned.mutations.some((mutation) => mutation.delete && mutation.path === existing[0].filepath)).toBe(true);
  });
});

describe("hasLlmSecret", () => {
  it("is false unless CLAUDE_CODE_OAUTH_TOKEN or OPENAI_API_KEY is set", () => {
    expect(hasLlmSecret({})).toBe(false);
    expect(hasLlmSecret({ CLAUDE_CODE_OAUTH_TOKEN: "  " })).toBe(false);
    expect(hasLlmSecret({ OPENAI_API_KEY: "" })).toBe(false);
    expect(hasLlmSecret({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" })).toBe(true);
    expect(hasLlmSecret({ OPENAI_API_KEY: "sk-test" })).toBe(true);
  });
});

describe("fallbackOutcomeFromReviews", () => {
  it("creates a new memory from a directive review comment", () => {
    const outcome = fallbackOutcomeFromReviews(context());
    expect(outcome.action).toBe("new");
    expect(outcome.body).toMatch(/gateway wrapper/i);
  });

  it("returns no_op when comments are not reusable", () => {
    const outcome = fallbackOutcomeFromReviews(context({ review_comments: ["lgtm"] }));
    expect(outcome.action).toBe("no_op");
  });
});

describe("runLearn", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("writes a memory and compiled files from a distilled new outcome", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-learn-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });

    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: false,
      deps: {
        fetchPr: async () => context(),
        distill: async () => JSON.stringify({
          action: "new",
          title: "Gateway retries",
          kind: "gotcha",
          paths: ["src/gateway/**"],
          body: "Register retries only in the gateway wrapper.",
          reasoning: "Reusable review decision",
        }),
      },
    });

    expect(result.plan.learned).toBe(1);
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    expect(files.some((file) => file.startsWith("M-001"))).toBe(true);
    const parsed = parseMemory(await fs.readFile(path.join(dir, ".memory", "memories", files[0]), "utf8"));
    expect(parsed?.frontmatter.evidence.pr).toBe("#42");
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("M-001");
  });

  it("recompiles only when the merged PR is already a teamrecall PR", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-learn-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const result = await runLearn({
      projectDir: dir,
      pr: "9",
      openPr: false,
      deps: {
        fetchPr: async () => context({ title: "🧠 teamrecall: learned 1 (from #8)", number: "9" }),
        distill: async () => {
          throw new Error("should not distill a memory PR");
        },
      },
    });
    expect(result.skipped).toBe("memory-pr-recompile");
  });

  it("records retired memory deletions so they can be staged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-retire-"));
    dirs.push(dir);
    const memoriesDir = path.join(dir, ".memory", "memories");
    await fs.mkdir(memoriesDir, { recursive: true });
    const filepath = path.join(memoriesDir, "M-003-old.md");
    await fs.writeFile(filepath, `---
id: M-003
kind: gotcha
paths: ["src/**"]
author: alice
created: "2026-10-10"
review_after: "2027-01-08"
status: active
---

Old rule that should be retired.`, "utf8");
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.test", "commit", "-m", "seed"], { cwd: dir });

    let opened: { files?: string[]; title?: string } | undefined;
    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: true,
      deps: {
        fetchPr: async () => context(),
        distill: async () => JSON.stringify({
          action: "propose_retire",
          memory_id: "M-003",
          reasoning: "Superseded",
        }),
        openPr: async (input) => {
          opened = input;
          return "https://example.test/pr/1";
        },
      },
    });

    expect(result.deleted).toContain(filepath);
    await expect(fs.access(filepath)).rejects.toThrow();
    expect(opened?.files).toEqual(MANAGED_GIT_PATHS);
    expect(opened?.title).toBe("🧠 teamrecall: retired 1 (from #42)");
  });

  it("uses the deterministic distiller when no LLM secrets are set and says so in the PR body", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-nosecret-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", ".gitkeep"), "", "utf8");
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.test", "commit", "-m", "seed"], { cwd: dir });

    let opened: { body?: string } | undefined;
    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: true,
      deps: {
        fetchPr: async () => context(),
        env: { PATH: process.env.PATH ?? "/usr/bin" },
        hasLocalEngine: false,
        openPr: async (input) => {
          opened = input;
          return "https://example.test/pr/2";
        },
      },
    });

    expect(result.plan.distiller).toBe("deterministic");
    expect(result.plan.distiller_reason).toBe("no_llm_secret");
    expect(result.plan.learned).toBe(1);
    expect(opened?.body).toContain("deterministic distiller");
    expect(opened?.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(opened?.body).toContain("OPENAI_API_KEY");
    expect(opened?.body).toContain("zero secrets");
    expect(opened?.body).toContain(DETERMINISTIC_DISTILLER_NOTE.split("\n")[0]);
  });

  it("keeps using an injected LLM distiller when a secret is present", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-secret-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: false,
      deps: {
        fetchPr: async () => context(),
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
        distill: async () => JSON.stringify({
          action: "no_op",
          reasoning: "LLM decided no-op",
        }),
      },
    });
    expect(result.plan.distiller).toBe("llm");
    expect(result.plan.action).toBe("no_op");
    expect(buildLearnPrBody(result.plan, context())).not.toContain("deterministic distiller");
  });

  it("uses a local claude/codex engine even when no env token is set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-local-cli-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: false,
      deps: {
        fetchPr: async () => context(),
        env: { PATH: process.env.PATH ?? "/usr/bin" },
        hasLocalEngine: true,
        distill: async () => JSON.stringify({
          action: "no_op",
          reasoning: "local claude is logged in",
        }),
      },
    });
    expect(result.plan.distiller).toBe("llm");
    expect(result.plan.distiller_reason).toBeUndefined();
    expect(buildLearnPrBody(result.plan, context())).not.toContain("neither");
  });

  it("says the LLM call failed instead of claiming no secret was set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-llm-fail-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: false,
      deps: {
        fetchPr: async () => context(),
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
        distill: async () => {
          throw new Error("claude exited 1");
        },
      },
    });
    expect(result.plan.distiller).toBe("deterministic");
    expect(result.plan.distiller_reason).toBe("llm_failed");
    const body = buildLearnPrBody(result.plan, context());
    expect(body).toContain(LLM_FAILED_DISTILLER_NOTE);
    expect(body).not.toContain("neither `CLAUDE_CODE_OAUTH_TOKEN` nor `OPENAI_API_KEY` was set");
  });

  it("refuses local learn --pr when managed paths are dirty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-dirty-"));
    dirs.push(dir);
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await exec("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.test", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(dir, ".memory", "memories", "wip.md"), "uncommitted\n", "utf8");

    let distilled = false;
    await expect(runLearn({
      projectDir: dir,
      pr: "42",
      openPr: true,
      ci: false,
      deps: {
        fetchPr: async () => context(),
        distill: async () => {
          distilled = true;
          return JSON.stringify({ action: "no_op", reasoning: "should not run" });
        },
        openPr: async () => {
          throw new Error("should not open a PR");
        },
      },
    })).rejects.toThrow(/uncommitted changes/);
    expect(distilled).toBe(false);
  });
});

describe("conflict hints", () => {
  it("records a possible conflict when a new memory contradicts an overlapping one", () => {
    const existing = [memory("M-012", "Use retries only in the gateway wrapper.", ["src/gateway/**"])];
    const planned = planLearnOutcomes({
      action: "new",
      title: "Retry in each service",
      paths: ["src/gateway/**"],
      body: "Retry at the service layer instead of the gateway.",
      reasoning: "New direction",
      contradicts: true,
      conflict_with: "M-012",
    }, existing, context(), "/tmp/conflict");
    expect(planned.learned).toBe(1);
    expect(planned.conflicts).toEqual([{ memory_id: "M-013", existing_id: "M-012" }]);
    const body = buildLearnPrBody(planned, context());
    expect(body).toContain("Possible conflict with M-012");
    expect(body).not.toMatch(/silently create/);
  });

  it("does not hint when the distiller does not mark a contradiction", () => {
    const existing = [memory("M-012", "Use retries only in the gateway wrapper.", ["src/gateway/**"])];
    expect(detectConflicts({
      action: "new",
      memory_id: "M-013",
      paths: ["src/gateway/**"],
      reasoning: "unrelated extra note",
    }, existing)).toEqual([]);
  });
});

describe("learn CLI defaults", () => {
  it("does not open a PR unless --pr or --ci is set", () => {
    expect(shouldOpenLearnPr({})).toBe(false);
    expect(shouldOpenLearnPr({ pr: true })).toBe(true);
    expect(shouldOpenLearnPr({ ci: true })).toBe(true);
  });
});

describe("distill process", () => {
  it("strips GITHUB_TOKEN from the child environment", () => {
    const env = sanitisedChildEnv({
      GITHUB_TOKEN: "secret",
      GH_TOKEN: "also-secret",
      PATH: "/usr/bin",
      KEEP: "yes",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.KEEP).toBe("yes");
  });

  it("passes --disallowedTools and the prompt on stdin, not argv", async () => {
    expect(claudeDistillArgs()).toEqual([
      "-p",
      "--disallowedTools",
      expect.stringContaining("Bash"),
    ]);
    const script = [
      "let s='';",
      "process.stdin.on('data', d => s += d);",
      "process.stdin.on('end', () => {",
      "  if (process.argv.slice(2).join(' ').includes('PROMPT_BODY')) process.exit(2);",
      "  process.stdout.write(s);",
      "});",
    ].join("");
    const out = await runWithStdin(process.execPath, ["-e", script], "PROMPT_BODY");
    expect(out).toBe("PROMPT_BODY");
  });
});
