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
  inferPaths,
  inferPathsExperimental,
  inferPathsV02,
  keepSpecificPaths,
  maybePromoteFromCandidates,
  resolveMemoryPaths,
  parseDistillationResponse,
  planLearnOutcomes,
} from "./learn.js";
import { loadCandidates, normalizeGist } from "./candidates.js";
import {
  claudeDistillArgs,
  hasLlmSecret,
  runLearn,
  runWithStdin,
  sanitisedChildEnv,
  shouldOpenLearnPr,
} from "./learn-run.js";
import { humanCommentBodies, isBotAuthor, shouldLearnFromClosedPr } from "./human-comments.js";
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
  const review_comments = partial.review_comments ?? [
    "Retries should only happen in the gateway wrapper, not the service layer.",
  ];
  return {
    number: "42",
    title: "Move retries to the gateway",
    body: "Review asked to keep retries in the wrapper.",
    url: "https://github.com/acme/app/pull/42",
    author: "alice",
    diff: "diff --git a/src/gateway.ts b/src/gateway.ts",
    merged: true,
    review_comments,
    human_review_comments: review_comments,
    commit_messages: ["fix ci: register retry in wrapper"],
    commits: ["abc123"],
    files: ["src/gateway.ts"],
    evidence_files: [],
    ...partial,
    review_comments: partial.review_comments ?? review_comments,
    human_review_comments: partial.human_review_comments ?? partial.review_comments ?? review_comments,
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

  it("maps applies_to onto paths", () => {
    const parsed = parseDistillationResponse(`{"action":"new","reasoning":"x","applies_to":["**/*.test.ts"],"scope":"triggered"}`);
    expect(parsed.paths).toEqual(["**/*.test.ts"]);
    expect(parsed.scope).toBe("triggered");
  });

  it("copies applies_to onto paths for every memories[] entry", () => {
    const parsed = parseDistillationResponse(JSON.stringify({
      action: "new",
      reasoning: "two lessons",
      memories: [
        { action: "new", reasoning: "a", applies_to: ["src/auth/**"], title: "Auth", body: "Keep auth cookies httpOnly." },
        { action: "new", reasoning: "b", applies_to: ["docs/**"], title: "Docs", body: "Mention the change in docs." },
      ],
    }));
    expect(parsed.memories?.[0]?.paths).toEqual(["src/auth/**"]);
    expect(parsed.memories?.[1]?.paths).toEqual(["docs/**"]);
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
    expect(prompt).toContain("promote");
    expect(prompt).toContain("Recurrence candidates");
    expect(prompt).toContain("applies_to");
    expect(prompt).toContain('"scope": "always|triggered"');
    expect(prompt).toContain("triggers");
    expect(prompt).toContain("src/auth/**");
    expect(prompt).toContain("docs/**");
    expect(prompt).not.toMatch(/changeset|mdtest|vitest|biome|ruff|tldraw/i);
  });
});

describe("inferPaths", () => {
  it("defaults to v0.2 top-level dir/**/* (or **/* for root/dot-only files)", () => {
    expect(inferPaths([".changeset/loose-hats-cough.md"])).toEqual(["**/*"]);
    expect(inferPaths([
      "crates/ruff_linter/src/rules/a.rs",
      "crates/ruff_linter/resources/mdtest/b.md",
    ])).toEqual(["crates/**/*"]);
    expect(inferPaths([
      "crates/biome_service/src/a.rs",
      "crates/biome_languages/src/b.rs",
    ])).toEqual(["crates/**/*"]);
    expect(inferPaths(["src/gateway.ts", "docs/readme.md"])).toEqual(["src/**/*", "docs/**/*"]);
    expect(inferPaths(["README.md"])).toEqual(["README.md/**/*"]);
    expect(inferPaths([])).toEqual(["**/*"]);
    expect(inferPathsV02(["src/gateway.ts"])).toEqual(["src/**/*"]);
  });
});

describe("inferPaths experimental", () => {
  it("uses deepest common dir/** plus extension, keeps dot-directories", () => {
    const globs = inferPathsExperimental([".changeset/loose-hats-cough.md"]);
    expect(globs).toContain(".changeset/**");
    expect(globs).toContain(".changeset/**/*.md");
    expect(globs).not.toContain(".changeset/*");
    expect(inferPaths([".changeset/loose-hats-cough.md"], true)).toEqual(globs);
  });

  it("uses the deepest common dir but never shallower than the package dir", () => {
    expect(inferPathsExperimental([
      "crates/ruff_linter/src/rules/a.rs",
      "crates/ruff_linter/resources/mdtest/b.md",
    ])).toEqual(["crates/ruff_linter/**"]);
  });

  it("does not collapse a monorepo to crates/** or packages/**", () => {
    expect(inferPathsExperimental([
      "crates/biome_service/src/a.rs",
      "crates/biome_languages/src/b.rs",
    ])).toEqual(expect.arrayContaining([
      "crates/biome_service/**",
      "crates/biome_languages/**",
    ]));
    expect(inferPathsExperimental([
      "crates/biome_service/src/a.rs",
      "crates/biome_languages/src/b.rs",
    ])).not.toContain("crates/**");
    expect(inferPathsExperimental([
      "packages/vitest/src/node/cli.ts",
      "packages/browser/src/client.ts",
    ])).toEqual(expect.arrayContaining([
      "packages/vitest/**",
      "packages/browser/**",
    ]));
    expect(inferPathsExperimental([
      "packages/vitest/src/node/cli.ts",
      "packages/browser/src/client.ts",
    ])).not.toContain("packages/**");
  });

  it("merges many sibling dirs to their common ancestor then caps at MAX_INFER_PATH_GLOBS", () => {
    const siblings = inferPathsExperimental(Array.from({ length: 7 }, (_, i) => `src/mod${i}/f.ts`));
    expect(siblings).toEqual(["src/**", "src/**/*.ts"]);
    const sixUnrelated = inferPathsExperimental([
      "a/x/1.ts", "a/x/2.ts", "b/x/1.ts", "c/x/1.ts", "d/x/1.ts", "e/x/1.ts", "f/x/1.ts",
    ]);
    expect(sixUnrelated.length).toBeLessThanOrEqual(5);
    expect(sixUnrelated).toContain("a/x/**");
    expect(sixUnrelated).not.toContain("**");
    expect(sixUnrelated).not.toContain("**/*");
  });

  it("caps inferred globs after merge and leaves root files exact", () => {
    const many = inferPathsExperimental(Array.from({ length: 12 }, (_, i) => `d${i}/x/f${i}.ts`).concat(["README.md"]));
    expect(many.length).toBeLessThanOrEqual(5);
    expect(many).toContain("README.md");
    expect(inferPathsExperimental(["README.md"])).toEqual(["README.md"]);
    expect(inferPathsExperimental([])).toEqual([]);
  });

  it("keeps package-level applies_to and explicit repo-wide **", () => {
    expect(keepSpecificPaths(
      [".changeset/*.md"],
      [".changeset/loose-hats-cough.md", "crates/foo.rs"],
      [".changeset/loose-hats-cough.md"],
    )).toEqual([".changeset/*.md"]);
    expect(keepSpecificPaths(
      ["src/**"],
      ["src/a.ts", "src/b/c.ts"],
      ["src/a.ts"],
    )).toEqual(["src/**"]);
    expect(keepSpecificPaths(
      ["**"],
      ["a/x.ts", "b/y.ts", "c/z.ts"],
      ["a/x.ts"],
    )).toEqual(["**"]);
    expect(keepSpecificPaths(
      ["**/*"],
      ["a/x.ts", "b/y.ts"],
      ["a/x.ts"],
    )).toEqual(["**"]);
    expect(keepSpecificPaths(
      ["**/*.test.ts"],
      ["src/a.test.ts", "src/a.ts"],
      ["src/a.test.ts"],
    )).toEqual(["**/*.test.ts"]);
    expect(keepSpecificPaths(
      ["**/*.ts", "**/*.tsx"],
      ["src/a.ts", "src/b.tsx"],
      ["src/a.ts"],
    )).toEqual(["**/*.ts", "**/*.tsx"]);
    expect(resolveMemoryPaths(["**/*.test.ts"], ["src/a.test.ts"], ["src/a.test.ts"])).toEqual({
      paths: ["**/*.test.ts"],
      source: "distiller",
    });
    expect(resolveMemoryPaths(undefined, [], ["src/a.ts"]).source).toBe("inferred");
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

  it("keeps explicit ** as repo-wide instead of narrowing to evidence", () => {
    const planned = planLearnOutcomes({
      action: "new",
      title: "Process rule",
      body: "Mention the change in every PR.",
      paths: ["**"],
      reasoning: "repo-wide process",
    }, [], context({ files: ["a/x.ts"], evidence_files: ["a/x.ts"] }), "/tmp/project");
    const parsed = parseMemory(planned.mutations[0]?.content ?? "");
    expect(parsed?.frontmatter.paths).toEqual(["**"]);
    expect(parsed?.frontmatter.paths_source).toBe("distiller");
    expect(parsed?.frontmatter.scope).toBe("triggered");
    expect(planned.scope_notes.join(" ")).toMatch(/always → triggered/);
    expect(buildLearnPrBody(planned, context())).toMatch(/always → triggered/);
  });

  it("allows always only after two distinct PRs or when human-authored", () => {
    const first = planLearnOutcomes({
      action: "new",
      title: "Process rule",
      body: "Mention the change in every PR.",
      paths: ["**"],
      scope: "always",
      reasoning: "first sighting",
    }, [], context({ number: "10", files: ["a/x.ts"] }), "/tmp/project");
    const firstParsed = parseMemory(first.mutations[0]?.content ?? "");
    expect(firstParsed?.frontmatter.scope).toBe("triggered");

    const existing = [{
      ...memory("M-001", "Mention the change in every PR.", ["**"]),
      frontmatter: {
        ...memory("M-001", "Mention the change in every PR.", ["**"]).frontmatter,
        scope: "triggered" as const,
        paths_source: "distiller" as const,
        evidence: { pr: "#10", prs: ["#10"] },
      },
    }];
    const second = planLearnOutcomes({
      action: "update",
      memory_id: "M-001",
      scope: "always",
      body: "Mention the change in every PR.",
      reasoning: "recurred",
    }, existing, context({ number: "22" }), "/tmp/project");
    const secondParsed = parseMemory(second.mutations[0]?.content ?? "");
    expect(secondParsed?.frontmatter.scope).toBe("always");
    expect(secondParsed?.frontmatter.evidence.prs).toEqual(["#10", "#22"]);

    const human = planLearnOutcomes({
      action: "update",
      memory_id: "M-001",
      scope: "always",
      body: "Mention the change in every PR.",
      reasoning: "hand-written",
    }, [{
      ...memory("M-001", "Mention the change in every PR.", ["**"]),
      frontmatter: {
        ...memory("M-001", "Mention the change in every PR.", ["**"]).frontmatter,
        paths_source: "human" as const,
        evidence: { pr: "#10", prs: ["#10"] },
      },
    }], context({ number: "10" }), "/tmp/project");
    expect(parseMemory(human.mutations[0]?.content ?? "")?.frontmatter.scope).toBe("always");
  });

  it("keeps extension globs as triggered distiller paths", () => {
    const planned = planLearnOutcomes({
      action: "new",
      title: "Test files",
      body: "Keep tests next to the code they cover.",
      paths: ["**/*.test.ts"],
      reasoning: "test glob",
    }, [], context({ files: ["src/a.test.ts"], evidence_files: ["src/a.test.ts"] }), "/tmp/project");
    const parsed = parseMemory(planned.mutations[0]?.content ?? "");
    expect(parsed?.frontmatter.paths).toEqual(["**/*.test.ts"]);
    expect(parsed?.frontmatter.scope).toBe("triggered");
    expect(parsed?.frontmatter.paths_source).toBe("distiller");
  });

  it("records inferred provenance when the distiller omitted applies_to", () => {
    const planned = planLearnOutcomes({
      action: "new",
      title: "Gateway retries",
      body: "Register retries only in the gateway wrapper.",
      reasoning: "no applies_to",
    }, [], context({ files: ["src/gateway.ts"], evidence_files: ["src/gateway.ts"] }), "/tmp/project");
    const parsed = parseMemory(planned.mutations[0]?.content ?? "");
    expect(parsed?.frontmatter.paths_source).toBe("inferred");
    expect(parsed?.frontmatter.paths).toEqual(["src/**/*"]);
    expect(parsed?.frontmatter.scope).toBe("triggered");
  });

  it("uses narrower experimental inference only when asked", () => {
    const files = ["crates/ruff_linter/src/rules/a.rs", "crates/ruff_linter/resources/mdtest/b.md"];
    const outcome = {
      action: "new" as const,
      title: "Ruff lint",
      body: "Keep ruff lint rules next to the crate they belong to.",
      reasoning: "no applies_to",
    };
    const def = planLearnOutcomes(outcome, [], context({ files, evidence_files: files }), "/tmp/project");
    expect(parseMemory(def.mutations[0]?.content ?? "")?.frontmatter.paths).toEqual(["crates/**/*"]);

    const experimental = planLearnOutcomes(
      outcome,
      [],
      context({ files, evidence_files: files }),
      "/tmp/project",
      90,
      files,
      true,
    );
    expect(parseMemory(experimental.mutations[0]?.content ?? "")?.frontmatter.paths).toEqual(["crates/ruff_linter/**"]);
  });

  it("honors distiller applies_to on the default path", () => {
    const planned = planLearnOutcomes({
      action: "new",
      title: "Auth cookies",
      body: "Keep auth cookies httpOnly and never store them in localStorage.",
      applies_to: ["src/auth/**"],
      paths: ["src/auth/**"],
      reasoning: "distiller owned the glob",
    }, [], context({ files: ["docs/readme.md"] }), "/tmp/project");
    expect(parseMemory(planned.mutations[0]?.content ?? "")?.frontmatter.paths).toEqual(["src/auth/**"]);
  });

  it("writes paths_source on update when a legacy memory omitted it", () => {
    const existing = [memory("M-003", "Old rule about retries in the gateway wrapper.", ["src/gateway/**"])];
    const planned = planLearnOutcomes({
      action: "update",
      memory_id: "M-003",
      body: "Register retries only in the gateway wrapper.",
      reasoning: "strengthen",
    }, existing, context(), "/tmp/project");
    const parsed = parseMemory(planned.mutations[0]?.content ?? "");
    expect(parsed?.frontmatter.paths_source).toBe("human");
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

describe("closed unmerged PRs", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("treats [bot] and user.type=Bot as non-human", () => {
    expect(isBotAuthor("alice")).toBe(false);
    expect(isBotAuthor("cursor[bot]")).toBe(true);
    expect(isBotAuthor("dependabot[bot]")).toBe(true);
    expect(isBotAuthor("copilot", "Bot")).toBe(true);
    expect(isBotAuthor("Copilot", "BOT")).toBe(true);
    expect(isBotAuthor("renovate-bot")).toBe(true);
    expect(isBotAuthor("")).toBe(false);
    expect(isBotAuthor("codecov")).toBe(true);
    expect(isBotAuthor("github-actions")).toBe(true);
    expect(isBotAuthor("vercel")).toBe(true);
    expect(isBotAuthor("alice")).toBe(false);
  });

  it("counts review summary bodies as human feedback", () => {
    expect(humanCommentBodies([
      { body: "Please disclose AI use and open an issue with a repro first.", author: "alice" },
      { body: "Coverage dropped.", author: "codecov" },
    ])).toEqual(["Please disclose AI use and open an issue with a repro first."]);
    expect(shouldLearnFromClosedPr({
      merged: false,
      human_review_comments: humanCommentBodies([
        { body: "Request changes: open an issue with a repro first.", author: "alice" },
      ]),
    })).toBe(true);
  });

  it("learns from unmerged PRs only when a human left a review comment", () => {
    expect(shouldLearnFromClosedPr({ merged: true, human_review_comments: [] })).toBe(true);
    expect(shouldLearnFromClosedPr({ merged: false, human_review_comments: [] })).toBe(false);
    expect(shouldLearnFromClosedPr({
      merged: false,
      human_review_comments: ["Please disclose AI use and open an issue with a repro first."],
    })).toBe(true);
  });

  it("skips learn on a closed unmerged PR with no human comments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-unmerged-skip-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    let distilled = false;
    const result = await runLearn({
      projectDir: dir,
      pr: "99",
      openPr: false,
      deps: {
        fetchPr: async () => context({
          number: "99",
          title: "AI generated tests",
          merged: false,
          review_comments: ["Automated review: looks fine"],
          human_review_comments: [],
        }),
        distill: async () => {
          distilled = true;
          return JSON.stringify({ action: "new", reasoning: "should not run" });
        },
      },
    });
    expect(result.skipped).toBe("unmerged-without-human-comments");
    expect(result.plan.learned).toBe(0);
    expect(distilled).toBe(false);
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    expect(files).toEqual([]);
  });

  it("learns from human comments on a PR closed without merging", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-unmerged-learn-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const comment = "Please disclose AI use and open an issue with a repro first before sending another PR.";
    const result = await runLearn({
      projectDir: dir,
      pr: "77",
      openPr: false,
      deps: {
        fetchPr: async () => context({
          number: "77",
          title: "Add vitest coverage",
          merged: false,
          review_comments: [comment],
          human_review_comments: [comment],
        }),
        distill: async () => JSON.stringify({
          action: "new",
          title: "Disclose AI use",
          kind: "convention",
          paths: ["**/*"],
          body: comment,
          reasoning: "Recurring human review on closed AI PRs",
        }),
      },
    });
    expect(result.skipped).toBeUndefined();
    expect(result.plan.learned).toBe(1);
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    expect(files.some((file) => file.startsWith("M-001"))).toBe(true);
    const parsed = parseMemory(await fs.readFile(path.join(dir, ".memory", "memories", files[0]), "utf8"));
    expect(parsed?.frontmatter.evidence.pr).toBe("#77");
    expect(parsed?.frontmatter.evidence.review_url).toBe("https://github.com/acme/app/pull/42");
    expect(buildLearnPrBody(result.plan, context({
      number: "77",
      merged: false,
      review_comments: [comment],
      human_review_comments: [comment],
    }))).toMatch(/closed without merging/i);
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

  it("uses v0.2 inferPaths by default and experimental inference from config or flag", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-infer-default-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const files = ["crates/ruff_linter/src/rules/a.rs", "crates/ruff_linter/resources/mdtest/b.md"];
    const distill = async () => JSON.stringify({
      action: "new",
      title: "Ruff lint",
      kind: "convention",
      body: "Keep ruff lint rules next to the crate they belong to.",
      reasoning: "no applies_to",
    });
    const fetchPr = async () => context({ files, evidence_files: files });

    const def = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: false,
      deps: { fetchPr, distill },
    });
    expect(def.plan.learned).toBe(1);
    const defaultFile = (await fs.readdir(path.join(dir, ".memory", "memories")))[0];
    expect(parseMemory(await fs.readFile(path.join(dir, ".memory", "memories", defaultFile), "utf8"))?.frontmatter.paths)
      .toEqual(["crates/**/*"]);

    const flagged = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-infer-flag-"));
    dirs.push(flagged);
    await fs.mkdir(path.join(flagged, ".memory", "memories"), { recursive: true });
    const fromFlag = await runLearn({
      projectDir: flagged,
      pr: "42",
      openPr: false,
      experimentalPaths: true,
      deps: { fetchPr, distill },
    });
    expect(fromFlag.plan.learned).toBe(1);
    const flagFile = (await fs.readdir(path.join(flagged, ".memory", "memories")))[0];
    expect(parseMemory(await fs.readFile(path.join(flagged, ".memory", "memories", flagFile), "utf8"))?.frontmatter.paths)
      .toEqual(["crates/ruff_linter/**"]);

    const configured = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-infer-config-"));
    dirs.push(configured);
    await fs.mkdir(path.join(configured, ".memory", "memories"), { recursive: true });
    await fs.writeFile(path.join(configured, ".memory", "config.yml"), "experimental:\n  retrieval: true\n", "utf8");
    const fromConfig = await runLearn({
      projectDir: configured,
      pr: "42",
      openPr: false,
      deps: { fetchPr, distill },
    });
    expect(fromConfig.plan.learned).toBe(1);
    const configFile = (await fs.readdir(path.join(configured, ".memory", "memories")))[0];
    expect(parseMemory(await fs.readFile(path.join(configured, ".memory", "memories", configFile), "utf8"))?.frontmatter.paths)
      .toEqual(["crates/ruff_linter/**"]);
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

    let opened: { files?: string[]; title?: string; force?: boolean; startPoint?: string } | undefined;
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
    expect(opened?.force).toBe(true);
    expect(opened?.startPoint).toBe("main");
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

  it("in CI with no LLM secret says no secret set even if claude CLI is installed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-ci-nosecret-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });
    const result = await runLearn({
      projectDir: dir,
      pr: "42",
      openPr: false,
      ci: true,
      deps: {
        fetchPr: async () => context(),
        env: { PATH: process.env.PATH ?? "/usr/bin", GITHUB_ACTIONS: "true" },
        hasLocalEngine: true,
      },
    });
    expect(result.plan.distiller).toBe("deterministic");
    expect(result.plan.distiller_reason).toBe("no_llm_secret");
    expect(buildLearnPrBody(result.plan, context())).toContain(DETERMINISTIC_DISTILLER_NOTE);
    expect(buildLearnPrBody(result.plan, context())).not.toContain("LLM call failed");
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

describe("recurrence promotion", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const styleComment = "Keep review comments short. Do not paste a whole function into a PR comment.";
  const styleCommentAgain = "Please keep review comments short — don't paste an entire function into the PR comment.";

  it("parses promote / same_as onto a candidate id", () => {
    const parsed = parseDistillationResponse(JSON.stringify({
      action: "new",
      same_as: "C-001",
      title: "Short comments",
      body: styleComment,
      reasoning: "same rule as the candidate",
    }));
    expect(parsed.action).toBe("promote");
    expect(parsed.candidate_id).toBe("C-001");
  });

  it("no_ops a keep-comments-short style rule on PR 1 and promotes it on PR 2", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-recurrence-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, ".memory", "memories"), { recursive: true });

    const first = await runLearn({
      projectDir: dir,
      pr: "10",
      openPr: false,
      deps: {
        fetchPr: async () => context({
          number: "10",
          title: "Tweak docs",
          review_comments: [styleComment],
          human_review_comments: [styleComment],
          files: ["README.md"],
          evidence_files: [],
        }),
        distill: async () => JSON.stringify({
          action: "no_op",
          reasoning: "First sighting of a style comment; store as a candidate",
        }),
      },
    });
    expect(first.plan.action).toBe("no_op");
    expect(first.plan.learned).toBe(0);
    expect(await fs.readdir(path.join(dir, ".memory", "memories"))).toEqual([]);
    const stored = await loadCandidates(dir);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe("C-001");
    expect(stored[0]?.gist).toBe(normalizeGist(styleComment));
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).not.toContain("C-001");
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).not.toContain("Keep review comments short");

    const second = await runLearn({
      projectDir: dir,
      pr: "22",
      openPr: false,
      deps: {
        fetchPr: async () => context({
          number: "22",
          title: "Another docs tweak",
          url: "https://github.com/acme/app/pull/22",
          review_comments: [styleCommentAgain],
          human_review_comments: [styleCommentAgain],
          files: ["docs/guide.md"],
          evidence_files: [],
        }),
        distill: async () => JSON.stringify({
          action: "no_op",
          reasoning: "Looks like a style nit again",
        }),
      },
    });
    expect(second.plan.learned).toBe(1);
    expect(second.plan.outcomes[0]?.action).toBe("promote");
    expect(second.plan.outcomes[0]?.candidate_id).toBe("C-001");
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    expect(files.some((file) => file.startsWith("M-001"))).toBe(true);
    const parsed = parseMemory(await fs.readFile(path.join(dir, ".memory", "memories", files[0]), "utf8"));
    expect(parsed?.frontmatter.evidence.prs).toEqual(["#10", "#22"]);
    expect(parsed?.frontmatter.evidence.pr).toBe("#22");
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("M-001");
    expect((await loadCandidates(dir)).some((item) => item.id === "C-001")).toBe(false);
  });

  it("promotes when the distiller names the same candidate", () => {
    const existing = [{
      id: "C-001",
      gist: normalizeGist(styleComment),
      terms: ["keep", "review", "comments", "short", "paste", "function"],
      files: [],
      pr: "#10",
      date: "2026-10-01",
    }];
    const outcome = maybePromoteFromCandidates({
      action: "promote",
      candidate_id: "C-001",
      title: "Short comments",
      body: styleCommentAgain,
      reasoning: "same as candidate C-001",
    }, existing, context({ number: "22", human_review_comments: [styleCommentAgain] }));
    expect(outcome.action).toBe("promote");
    const planned = planLearnOutcomes(
      outcome,
      [],
      context({ number: "22", human_review_comments: [styleCommentAgain] }),
      "/tmp/project",
      90,
      [],
      false,
      existing,
    );
    const parsed = parseMemory(planned.mutations[0]?.content ?? "");
    expect(parsed?.frontmatter.evidence.prs).toEqual(["#10", "#22"]);
    expect(parsed?.frontmatter.scope).toBe("triggered");
  });

  it("allows always after promotion because evidence has two PRs", () => {
    const existing = [{
      id: "C-001",
      gist: normalizeGist(styleComment),
      terms: ["keep", "review", "comments", "short", "paste", "function"],
      files: [],
      pr: "#10",
      date: "2026-10-01",
    }];
    const planned = planLearnOutcomes({
      action: "promote",
      candidate_id: "C-001",
      title: "Short comments",
      body: styleComment,
      scope: "always",
      paths: ["**"],
      reasoning: "recurring process rule",
    }, [], context({ number: "22" }), "/tmp/project", 90, [], false, existing);
    expect(parseMemory(planned.mutations[0]?.content ?? "")?.frontmatter.scope).toBe("always");
  });

  it("still creates a triggered memory on the first PR when the distiller marks it reusable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-reusable-first-"));
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
          reasoning: "Clearly reusable on first sight",
        }),
      },
    });
    expect(result.plan.learned).toBe(1);
    expect(result.plan.outcomes[0]?.action).toBe("new");
    const files = await fs.readdir(path.join(dir, ".memory", "memories"));
    const parsed = parseMemory(await fs.readFile(path.join(dir, ".memory", "memories", files[0]), "utf8"));
    expect(parsed?.frontmatter.scope).toBe("triggered");
    expect(parsed?.frontmatter.evidence.prs).toEqual(["#42"]);
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
