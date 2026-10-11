# teamrecall Examples

This directory contains example usage and templates.

## Quick Start Example

```bash
# Initialize in your project
cd /path/to/your/project
npx -y github:wangwu-30/teamrecall#v0.3.0 init --yes

# Manually create your first memory
cat > .memory/memories/M-001-retry-logic.md << 'EOF'
---
id: M-001
kind: gotcha
paths: ["src/gateway/**/*.ts"]
evidence:
  pr: "#42"
  review_url: "https://github.com/yourorg/yourrepo/pull/42"
author: alice
created: "2026-10-10"
review_after: "2027-01-08"
status: active
---

Move retry logic to the gateway wrapper. Service-layer retries cause cascading failures when the gateway already retries.
EOF

# Compile memories
npx -y github:wangwu-30/teamrecall#v0.3.0 compile

# Check what was generated
ls -R .memory/ .claude/ .cursor/
cat AGENTS.md
cat .memory/INDEX.md
```

## Example Memory Types

### Gotcha (⚠️)

```yaml
---
id: M-001
kind: gotcha
paths: ["src/auth/**/*.ts"]
evidence:
  pr: "#123"
author: alice
created: "2026-10-10"
review_after: "2027-01-08"
status: active
---

Never use `eval()` in authentication handlers. It creates code injection vulnerabilities even when inputs appear sanitized.
```

### Decision (🎯)

```yaml
---
id: M-002
kind: decision
paths: ["**/*.ts"]
evidence:
  pr: "#150"
  review_url: "https://..."
author: bob
created: "2026-10-12"
review_after: "2027-01-10"
status: active
---

All API responses must use standard error format: `{ error: { code, message, details } }`. See `SECURITY.md` for auth-related codes.
```

### Convention (📏)

```yaml
---
id: M-003
kind: convention
paths: ["src/**/*.test.ts"]
evidence:
  pr: "#175"
author: carol
created: "2026-10-15"
review_after: "2027-01-13"
status: active
---

Test files use `describe()` for components, `it()` for behaviors. One assertion per `it()` block when testing edge cases.
```

### Map (🗺️)

```yaml
---
id: M-004
kind: map
paths: ["**/*"]
evidence:
  pr: "#200"
author: dave
created: "2026-10-20"
review_after: "2027-01-18"
status: active
---

Authentication flows: OAuth in `src/auth/oauth.ts`, session management in `src/auth/session.ts`. See `SECURITY.md` for the full decision tree.
```

## GitHub Action Setup

After running `npx -y github:wangwu-30/teamrecall#v0.3.0 init --yes`, set up auto-learning:

```bash
# Option 1: Use your team's Claude Code subscription (recommended)
gh secret set CLAUDE_CODE_OAUTH_TOKEN
# Follow prompts from `claude setup-token`

# Option 2: Use Codex (if you don't use Claude Code)
# The learn workflow can call `codex exec` instead
```

## CI Integration

The included `.github/workflows/ci.yml` runs tests on every PR:

```yaml
- run: npm ci
- run: npm run typecheck
- run: npm test
- run: npm run build
```

The `.github/workflows/teamrecall.yml` learns from merged PRs (full implementation in week 2).

## Week 2 Preview

Coming soon:

```bash
# Full learn command
npx -y github:wangwu-30/teamrecall#v0.3.0 learn 42
# → Fetches PR #42
# → Runs claude -p with distillation prompt
# → Creates memory file
# → Opens bot PR

# Weekly staleness check
npx -y github:wangwu-30/teamrecall#v0.3.0 sweep
# → Flags memories past review_after
# → Suggests merge/retire for duplicates
```
