import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLearnPrTitle,
  checkDuplicate,
  fallbackOutcomeFromReviews,
  forceUpdateIfDuplicate,
  generateDistillationPrompt,
  parseDistillationResponse,
  planLearnOutcomes,
} from "./learn.js";
import { runLearn } from "./learn-run.js";
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
});
