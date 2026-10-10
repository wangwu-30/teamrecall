import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSweepWorkflowTemplate, loadWorkflowTemplate } from "./init.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("teamrecall GitHub workflow", () => {
  it("is a single template copied into the repo workflow", async () => {
    const template = await loadWorkflowTemplate();
    const checkedIn = await fs.readFile(path.join(root, ".github", "workflows", "teamrecall.yml"), "utf8");
    const onDisk = await fs.readFile(path.join(root, "templates", "github-workflow.yml"), "utf8");
    expect(template).toBe(onDisk);
    expect(checkedIn).toBe(onDisk);
  });

  it("installs from this GitHub repo, not unpublished npm, and installs claude", async () => {
    const template = await loadWorkflowTemplate();
    expect(template).not.toContain("npm install -g teamrecall");
    expect(template).toContain("npm install -g @anthropic-ai/claude-code");
    expect(template).toContain("github:wangwu-30/teamrecall#");
    expect(template).toContain("concurrency:");
    expect(template).toContain("group: teamrecall-learn-${{ github.repository }}");
    expect(template).toContain("cancel-in-progress: false");
    expect(template).toContain("TEAMRECALL_REF: v0.2.0");
  });

  it("copies a weekly sweep workflow with the same install conventions", async () => {
    const template = await loadSweepWorkflowTemplate();
    const checkedIn = await fs.readFile(path.join(root, ".github", "workflows", "teamrecall-sweep.yml"), "utf8");
    expect(template).toBe(checkedIn);
    expect(template).toContain("cron:");
    expect(template).toContain("sweep --pr");
    expect(template).not.toContain("npm install -g teamrecall");
    expect(template).toContain("github:wangwu-30/teamrecall#");
    expect(template).toContain("group: teamrecall-sweep-${{ github.repository }}");
    expect(template).toContain("cancel-in-progress: false");
  });

  it("declares a prepare script so git installs build dist", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.prepare).toBe("tsc");
  });
});
