import { CANDIDATES_FILENAME, STATE_BRANCH } from "./constants.js";
import { candidatesPath, parseCandidatesJsonl, writeCandidates } from "./candidates.js";
import type { ReviewCandidate } from "./types.js";
import { exists } from "./utils/atomic.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    timeout: 30_000,
    encoding: "utf8",
  });
  return stdout ?? "";
}

export async function loadCandidatesFromState(projectDir: string): Promise<ReviewCandidate[]> {
  try {
    await run(["fetch", "origin", `${STATE_BRANCH}:${STATE_BRANCH}`], projectDir);
  } catch {
    // Branch may not exist yet.
  }
  try {
    const blob = await run(["show", `${STATE_BRANCH}:.memory/${CANDIDATES_FILENAME}`], projectDir);
    return parseCandidatesJsonl(blob);
  } catch {
    return [];
  }
}

export async function hydrateCandidates(projectDir: string, ci: boolean): Promise<ReviewCandidate[]> {
  if (ci) {
    const fromState = await loadCandidatesFromState(projectDir);
    if (fromState.length > 0 || !(await exists(candidatesPath(projectDir)))) {
      await writeCandidates(projectDir, fromState);
      return fromState;
    }
  }
  const { loadCandidates } = await import("./candidates.js");
  return loadCandidates(projectDir);
}
