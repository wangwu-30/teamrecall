# INSTALL.md — for the installing agent

You are installing **teamrecall** into the user's repository. Do the work yourself. Do not ask the human to run install commands you can run. Re-running this file is safe and idempotent.

Target UX: the human pasted one line (this file's URL). When you finish, they have a first PR and a short checklist.

## 0. Detect the repo and tools

Run these in the project the human asked you to set up (never a random parent directory):

1. Confirm a git repo: `git rev-parse --is-inside-work-tree`. If this is not a git repo and you are clearly inside their project root, run `git init`. If you are unsure of the root, stop and say so.
2. Require Node.js ≥ 20: `node -v`. If missing, print the exact command for their OS (do not invent a package manager) and stop.
3. Require `npx` (comes with npm). Require `git`.
4. Detect optional tools: `gh` (needed to open the first PR and to set secrets later), `claude`, `codex`. Missing `gh` is not fatal; you will print the commit/PR commands.
5. Do not `npm install -g teamrecall`. The package is installed from the GitHub tag below.

## 1. Pin the latest tag (not `main`, not npm)

Resolve the latest `v*` tag. Do not use branch `main`. Do not use the unpublished npm name `teamrecall`.

```sh
TAG=$(git ls-remote --tags --refs https://github.com/wangwu-30/teamrecall.git \
  | awk -F/ '{print $NF}' | grep -E '^v[0-9]' | sort -V | tail -1)
TAG=${TAG:-v0.3.0}
trc() { npx -y "github:wangwu-30/teamrecall#${TAG}" "$@"; }
```

`v0.3.0` is the fallback if tag discovery fails. `trc` is a shell function (not a quoted command string). Call it as `trc <subcommand>`.

## 2. Init (non-interactive, re-run safe)

From the repo root:

```sh
trc init --yes --json
```

`--yes` is the default (never prompt). `--json` prints one JSON object on stdout.

What init does (every step is safe to re-run):

- Creates `.memory/memories/`, `.memory/retired/`, `.memory/config.yml`, `.memory/README.md` if missing
- Copies `.github/workflows/teamrecall.yml` and `teamrecall-sweep.yml` if missing (does not overwrite)
- Backfills memories from existing `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.{md,mdc}`, and up to 3 lessons from the last 30 merged PR comments (via `gh`). Skips backfill when memories already exist
- Compiles `AGENTS.md` (managed block), `.memory/INDEX.md`, Claude/Cursor/Copilot rules
- Attempts the first PR (`teamrecall/init`) unless you passed `--skip-pr`
- Does not delete an existing `.memory/` on re-run

Parse the JSON. Fields you need: `ok`, `reused`, `created`, `written`, `skipped`, `secret_set`, `human_actions`, `pr_url`, `pr_error`, `doctor`.

If `ok` is false, read `error`, fix, and re-run the same `trc init --yes --json` command.

## 3. Compile and doctor

Always verify, even if init already compiled:

```sh
trc compile
trc doctor
```

Doctor warnings (missing `claude` CLI, no origin remote, no LLM secret) are acceptable on day one. Doctor errors are not — fix and re-run `trc doctor`.

## 4. Open the first PR

If `pr_url` is a URL, you are done with this step.

If `pr_url` is null:

1. Stage only teamrecall files: `.memory/`, `AGENTS.md`, `CLAUDE.md` (if present), `.github/copilot-instructions.md`, `.github/workflows/teamrecall.yml`, `.github/workflows/teamrecall-sweep.yml`, `.claude/rules/teamrecall/`, `.cursor/rules/`
2. Commit: `🧠 teamrecall: initialize team memory`
3. Push and open a PR with `gh pr create` (or the host's equivalent)

Do not include unrelated dirty files.

## 5. Secrets you cannot set — print these exactly

You cannot create GitHub Actions secrets or flip repo settings from here. Print these two items to the human (do not ask them to paste a token into chat):

**One command** (after they authenticate Claude Code locally):

```sh
claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

**One repo setting:** GitHub → this repo → Settings → Actions → General → Workflow permissions → enable **Allow GitHub Actions to create and approve pull requests**.

Learn works on day one with **zero secrets**: if `CLAUDE_CODE_OAUTH_TOKEN` and `OPENAI_API_KEY` are both unset, `trc learn` uses the deterministic distiller and says so in the learn PR body.

After the human runs the secret command and flips the setting, verify:

```sh
trc doctor
```

## 6. What success looks like (report this checklist)

Report back, with yes/no for each:

- [ ] `.memory/` exists (`config.yml`, `memories/`, `INDEX.md`)
- [ ] `.github/workflows/teamrecall.yml` exists
- [ ] `AGENTS.md` contains `<!-- teamrecall:start -->`
- [ ] `trc doctor` exits 0
- [ ] First PR opened (URL) or a commit ready to open
- [ ] Human received the exact secret command (or JSON said `secret_set: true`)
- [ ] Human received the Actions “create and approve pull requests” setting

Do not claim install succeeded unless the first five are yes.
