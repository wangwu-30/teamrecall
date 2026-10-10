import * as path from "node:path";
import { listStaleGeneratedRules } from "./compiler.js";
import { TEAMRECALL_START } from "./constants.js";
import { commandExists } from "./github.js";
import { loadMemories, validateSupersededBy } from "./memory.js";
import { exists, readText } from "./utils/atomic.js";
import { getCurrentBranch, gitHasRemote, isGitRepo } from "./utils/git.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(projectDir: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  const add = (
    name: string,
    ok: boolean,
    detail: string,
    severity: "error" | "warning" = "error",
  ) => {
    checks.push({ name, ok, detail, severity });
  };

  const nodeVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  add("node_runtime", nodeVersion >= 20, `Node ${process.versions.node}`, "warning");

  add("project_directory", await exists(projectDir), projectDir);

  const gitRepo = await isGitRepo(projectDir);
  add("git_repository", gitRepo, gitRepo ? projectDir : "Must be run in a git repository", "warning");

  if (gitRepo) {
    const branch = await getCurrentBranch(projectDir);
    add("git_branch", Boolean(branch), branch ?? "Detached HEAD", "warning");

    const hasOrigin = await gitHasRemote("origin", projectDir);
    add("git_remote", hasOrigin, hasOrigin ? "origin" : "No origin remote", "warning");
  }

  const memoryDir = path.join(projectDir, ".memory");
  const hasMemoryDir = await exists(memoryDir);
  add("memory_directory", hasMemoryDir, hasMemoryDir ? memoryDir : "Run `teamrecall init` first");

  if (hasMemoryDir) {
    const configPath = path.join(memoryDir, "config.yml");
    const hasConfig = await exists(configPath);
    add("memory_config", hasConfig, configPath, "warning");

    const memoriesDir = path.join(memoryDir, "memories");
    const hasMemories = await exists(memoriesDir);
    add("memories_directory", hasMemories, memoriesDir);
  }

  const agentsMd = path.join(projectDir, "AGENTS.md");
  const agentsContent = await readText(agentsMd);
  add(
    "agents_md_block",
    agentsContent.includes(TEAMRECALL_START),
    agentsContent.includes(TEAMRECALL_START) ? agentsMd : "Run `teamrecall compile`",
    "warning",
  );

  const claudeMd = path.join(projectDir, "CLAUDE.md");
  if (await exists(claudeMd)) {
    const claudeContent = await readText(claudeMd);
    add(
      "claude_md_block",
      claudeContent.includes(TEAMRECALL_START),
      claudeContent.includes(TEAMRECALL_START) ? claudeMd : "CLAUDE.md exists but has no teamrecall managed block",
      "warning",
    );
  } else {
    add("claude_md_block", true, "CLAUDE.md not present (AGENTS.md is the Claude fallback)", "warning");
  }

  const copilot = path.join(projectDir, ".github", "copilot-instructions.md");
  const copilotContent = await readText(copilot);
  add(
    "copilot_block",
    copilotContent.includes(TEAMRECALL_START),
    copilotContent.includes(TEAMRECALL_START) ? copilot : "Run `teamrecall compile` to write Copilot instructions",
    "warning",
  );

  const memories = hasMemoryDir ? await loadMemories(projectDir) : [];
  const supersededErrors = validateSupersededBy(memories);
  add(
    "superseded_by",
    supersededErrors.length === 0,
    supersededErrors.length === 0 ? "superseded_by targets exist" : supersededErrors.join("; "),
    "warning",
  );
  const activeIds = new Set(
    memories.filter((memory) => memory.frontmatter.status === "active").map((memory) => memory.frontmatter.id),
  );
  const stale = await listStaleGeneratedRules(projectDir, activeIds);
  add(
    "stale_generated_rules",
    stale.length === 0,
    stale.length === 0 ? "no stale generated rules" : stale.map((file) => path.relative(projectDir, file)).join(", "),
    "warning",
  );

  const hasClaude = await commandExists("claude");
  const hasCodex = await commandExists("codex");
  add("claude_cli", hasClaude, hasClaude ? "claude on PATH" : "claude CLI not on PATH", "warning");
  add("codex_cli", hasCodex, hasCodex ? "codex on PATH" : "codex CLI not on PATH", "warning");

  add(
    "learn_workflow",
    await exists(path.join(projectDir, ".github", "workflows", "teamrecall.yml")),
    ".github/workflows/teamrecall.yml",
    "warning",
  );
  add(
    "sweep_workflow",
    await exists(path.join(projectDir, ".github", "workflows", "teamrecall-sweep.yml")),
    ".github/workflows/teamrecall-sweep.yml",
    "warning",
  );

  return {
    ok: checks.every((c) => c.ok || c.severity === "warning"),
    checks,
  };
}
