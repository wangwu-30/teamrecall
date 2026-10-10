import * as path from "node:path";
import { exists } from "./utils/atomic.js";
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
  add("git_repository", gitRepo, gitRepo ? projectDir : "Must be run in a git repository");

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
  const hasAgentsMd = await exists(agentsMd);
  add("agents_md", hasAgentsMd, hasAgentsMd ? agentsMd : "Will be created on compile", "warning");

  return {
    ok: checks.every((c) => c.ok || c.severity === "warning"),
    checks,
  };
}
