# teamrecall

Paste this one line into Claude Code, Codex, or Cursor:

```
Follow https://github.com/wangwu-30/teamrecall/blob/main/INSTALL.md to set up teamrecall in this repo
```

**Never leave the same review comment twice.**

The lessons your team already wrote in code review show up automatically in every teammate's coding agent.

Git-native, reviewed as PRs, zero infrastructure. Works with Claude Code, Codex, and Cursor.

---

把这一行粘贴给你的编码助手（Claude Code / Codex / Cursor）：

```
Follow https://github.com/wangwu-30/teamrecall/blob/main/INSTALL.md to set up teamrecall in this repo
```

**同一条 review 意见，不要写第二次。**

你的团队在代码审查中写下的经验，自动出现在每个队友的编码助手中。

基于 Git，通过 PR 审查，零基础设施。支持 Claude Code、Codex 和 Cursor。

---

## Why teamrecall? | 为什么选择 teamrecall？

**English:**

Every team has lessons learned in code review:
- "Retries should only happen in the gateway wrapper"
- "Never use `eval()` in user input handlers"
- "Authentication decisions are in `SECURITY.md`"

But these lessons live scattered: PR comments, Slack threads, tribal knowledge. New teammates (and AI agents) keep making the same mistakes.

**teamrecall** makes your team's knowledge **git-native** and **AI-readable**:
1. Learns automatically from merged PRs
2. Stores as reviewed Markdown files
3. Shows up in Claude Code, Codex, Cursor

Zero infrastructure. No daemon, no database, no vector store, no extra API key.

**中文：**

每个团队都在代码审查中积累了经验教训：
- "重试只应该在网关包装器中进行"
- "不要在用户输入处理器中使用 `eval()`"
- "认证决策在 `SECURITY.md` 中"

但这些经验分散在各处：PR 评论、Slack 对话、口口相传。新队友（和 AI 助手）不断犯同样的错误。

**teamrecall** 让团队知识**基于 Git** 且 **AI 可读**：
1. 从合并的 PR 中自动学习
2. 存储为经过审查的 Markdown 文件
3. 自动出现在 Claude Code、Codex、Cursor 中

零基础设施。无守护进程、无数据库、无向量存储、无需额外 API 密钥。

---

## The Story | 工作流程

**English:**

1. **Alice gets feedback** in code review:
   > "Move retry logic to the gateway wrapper, not the service layer"

2. **teamrecall learns** (GitHub Action on PR merge):
   - Analyzes diff, review comments, CI fixes
   - Uses `claude -p` to distill reusable knowledge
   - Opens PR: `🧠 teamrecall: learned 1 from #42`

3. **Bob's agent knows** (automatically):
   - Cursor: "Per team memory M-012 (from #42, @alice): I'll add the retry logic in the gateway wrapper"
   - Claude Code: Same memory, same guidance
   - Codex: Same memory, same guidance

No manual wiki updates. No asking around. Just works.

**中文：**

1. **Alice 在代码审查中收到反馈：**
   > "将重试逻辑移到网关包装器中，而不是服务层"

2. **teamrecall 自动学习**（PR 合并时的 GitHub Action）：
   - 分析差异、审查评论、CI 修复
   - 使用 `claude -p` 提炼可复用知识
   - 创建 PR：`🧠 teamrecall: learned 1 from #42`

3. **Bob 的助手自动知道**：
   - Cursor："根据团队记忆 M-012（来自 #42，@alice）：我会在网关包装器中添加重试逻辑"
   - Claude Code：相同的记忆，相同的指导
   - Codex：相同的记忆，相同的指导

无需手动更新 wiki。无需四处询问。开箱即用。

---

## Install | 安装

**One line to your coding agent** (preferred):

```
Follow https://github.com/wangwu-30/teamrecall/blob/main/INSTALL.md to set up teamrecall in this repo
```

The agent follows [`INSTALL.md`](INSTALL.md): detects the repo, runs `npx -y github:wangwu-30/teamrecall#<latest-tag> init --yes --json`, backfills, compiles, runs `doctor`, and opens the first PR. Re-run is safe. Learn works with zero secrets (deterministic distiller) until you set `CLAUDE_CODE_OAUTH_TOKEN`.

**Or run it yourself:**

```bash
npx -y github:wangwu-30/teamrecall#v0.2.0 init --yes
```

**它会做什么：**
1. 创建 `.memory/`（可重复执行，不会毁掉已有记忆）
2. 从现有的 `CLAUDE.md` / `AGENTS.md` / `.cursor/rules` 和最近合并的 PR 评论回填
3. 打开第一个 memory PR；没有 secret 也能用

**第一天就有价值。** 把一行话粘贴给助手即可。

---

## How It Works | 工作原理

**English:**

### Storage: `.memory/memories/M-xxx-slug.md`

Each memory is a Markdown file with YAML frontmatter:

```yaml
---
id: M-012
kind: gotcha
paths: ["src/gateway/**/*.ts"]
evidence:
  pr: "#42"
  review_url: "https://github.com/..."
  commits: ["abc123"]
author: alice
created: "2026-10-10"
review_after: "2027-01-08"  # Auto-renew on use, retire if stale
status: active
---

Move retry logic to the gateway wrapper. Service-layer retries cause cascading failures when the gateway already retries.
```

**Max 120 words.** Must state the trigger and what decision it changes.

### Compiler: Agent-Specific Rules

From memories, teamrecall generates:

| Agent | Output |
|-------|--------|
| **Claude Code** | `.claude/rules/teamrecall/M-xxx.md` with `paths:` frontmatter |
| **Cursor** | `.cursor/rules/teamrecall-M-xxx.mdc` with `globs:` frontmatter |
| **Codex** | `AGENTS.md` managed block + `.memory/INDEX.md` |
| **All** | `.memory/INDEX.md` (human-readable index) |

### Learning: GitHub Action on PR Merge

On `pull_request` → `closed` (merged):
1. Collects diff, PR body, review comments, CI fixes
2. Runs `claude -p` (uses team's Claude subscription, no API key needed) with distillation prompt
3. Outcomes: `reuse` / `update` / `merge` / `propose_retire` / `new` / `no_op`
4. Opens bot PR: `🧠 teamrecall: learned 1, updated 1 (from #42)` (max 3 memories per PR)
5. Dedupe check: overlapping paths + similar title → force update

**中文：**

### 存储：`.memory/memories/M-xxx-slug.md`

每个记忆是一个带有 YAML frontmatter 的 Markdown 文件：

```yaml
---
id: M-012
kind: gotcha
paths: ["src/gateway/**/*.ts"]
evidence:
  pr: "#42"
  review_url: "https://github.com/..."
  commits: ["abc123"]
author: alice
created: "2026-10-10"
review_after: "2027-01-08"  # 使用时自动续期，过期则退休
status: active
---

将重试逻辑移到网关包装器中。服务层重试会导致级联失败，因为网关已经重试了。
```

**最多 120 字。** 必须说明触发条件和它改变的决策。

### 编译器：针对不同助手的规则

从记忆中，teamrecall 生成：

| 助手 | 输出 |
|------|------|
| **Claude Code** | `.claude/rules/teamrecall/M-xxx.md`，带 `paths:` frontmatter |
| **Cursor** | `.cursor/rules/teamrecall-M-xxx.mdc`，带 `globs:` frontmatter |
| **Codex** | `AGENTS.md` 托管块 + `.memory/INDEX.md` |
| **所有** | `.memory/INDEX.md`（人类可读索引）|

### 学习：PR 合并时的 GitHub Action

当 `pull_request` → `closed`（已合并）时：
1. 收集差异、PR 描述、审查评论、CI 修复
2. 运行 `claude -p`（使用团队的 Claude 订阅，无需 API 密钥）与提炼提示
3. 结果：`reuse` / `update` / `merge` / `propose_retire` / `new` / `no_op`
4. 创建机器人 PR：`🧠 teamrecall: learned 1, updated 1 (from #42)`（每个 PR 最多 3 条记忆）
5. 去重检查：重叠路径 + 相似标题 → 强制更新

---

## Commands | 命令

```bash
# Initialize teamrecall (non-interactive, re-run safe)
npx -y github:wangwu-30/teamrecall#v0.2.0 init --yes --json

# Compile memories into agent rules
npx -y github:wangwu-30/teamrecall#v0.2.0 compile

# Check installation
npx -y github:wangwu-30/teamrecall#v0.2.0 doctor

# Learn from a PR (no LLM secret → deterministic distiller)
npx -y github:wangwu-30/teamrecall#v0.2.0 learn 42

# Experimental: rank memories for a change (opt-in; not used by default compile)
npx -y github:wangwu-30/teamrecall#v0.2.0 retrieve -- src/foo.ts
```

`teamrecall retrieve` is experimental. Default compile still writes path-scoped rules and the root index the same way as v0.2; retrieve is an extra command, not wired into init/learn/compile.

`teamrecall retrieve` 是实验功能。默认编译仍按 v0.2 写出路径规则和根索引；retrieve 是额外命令，不会接入 init/learn/compile。

---

## vs. Other Approaches | 对比其他方法

**English:**

| Approach | Pros | Cons |
|----------|------|------|
| **Personal memory** (claude-mem, etc.) | Easy per-user setup | Not shared, no review, API cost |
| **Wiki / Notion** | Flexible | Agents can't read, becomes stale |
| **Custom prompts** (.cursorrules, CLAUDE.md) | Works today | Manual, no provenance, no TTL |
| **teamrecall** | **Git-native, reviewed, auto-learned, zero infra** | Early stage (v0.1) |

**中文：**

| 方法 | 优点 | 缺点 |
|------|------|------|
| **个人记忆**（claude-mem 等）| 每个用户设置简单 | 不共享、无审查、API 成本 |
| **Wiki / Notion** | 灵活 | 助手无法读取，会过时 |
| **自定义提示**（.cursorrules、CLAUDE.md）| 现在就能用 | 手动、无来源、无 TTL |
| **teamrecall** | **基于 Git、经过审查、自动学习、零基础设施** | 早期阶段（v0.1）|

---

## FAQ | 常见问题

**Q: Does this share private code with Claude's API?**

**English:** No. teamrecall learns only from **reviewed PRs** in your repo (using your team's Claude subscription via OAuth, same as Claude Code). It never accesses private chats or drafts. All memories are stored in your repo, reviewed by your team.

**中文：** 不会。teamrecall 仅从你仓库中**经过审查的 PR** 学习（通过 OAuth 使用你团队的 Claude 订阅，与 Claude Code 相同）。它从不访问私人聊天或草稿。所有记忆都存储在你的仓库中，由你的团队审查。

---

**Q: What if I don't use Claude Code?**

**English:** teamrecall works with Cursor, Codex, and any agent that reads `.cursorrules` or `AGENTS.md`. The learning workflow can use `codex exec` instead of `claude -p` (see `npx -y github:wangwu-30/teamrecall#v0.2.0 learn`).

**中文：** teamrecall 支持 Cursor、Codex 以及任何读取 `.cursorrules` 或 `AGENTS.md` 的助手。学习工作流可以使用 `codex exec` 代替 `claude -p`（参见 `npx -y github:wangwu-30/teamrecall#v0.2.0 learn`）。

---

**Q: How do I delete a memory?**

**English:** Move it to `.memory/retired/` and run `teamrecall compile`. Retired memories are kept for audit but not compiled.

**中文：** 将其移到 `.memory/retired/` 并运行 `teamrecall compile`。退休的记忆会保留以供审计，但不会编译。

---

**Q: Can I edit memories manually?**

**English:** Yes! Memories are just Markdown files. Edit, commit, push. The compiler runs on every PR merge.

**中文：** 可以！记忆只是 Markdown 文件。编辑、提交、推送。编译器在每次 PR 合并时运行。

---

**Q: What about staleness?**

**English:** Each memory has a `review_after` date (default: +90 days). On use (referenced in a PR), it's auto-renewed. A future weekly job will flag stale memories for review.

**中文：** 每个记忆都有一个 `review_after` 日期（默认：+90 天）。使用时（在 PR 中引用），它会自动续期。未来的每周任务将标记过时的记忆以供审查。

---

## Demo | 演示

**[GIF placeholder]**

*(Week 2: record GIF showing Alice's PR → bot PR → Bob's Cursor agent referencing M-012)*

---

## Roadmap | 路线图

**v0.1 (week 1)** — ✓ Core: init, compile, types, tests, GitHub Action scaffold

**v0.2 (week 2)**:
- Full `learn` command (fetch PR via `gh`, run `claude -p`, parse outcome)
- Dedupe/conflict/staleness weekly job
- Demo repo with sample memories
- GIF walkthrough

**v0.3+**:
- Slack/Discord notifications for new memories
- VS Code extension
- Analytics (most-used memories)

---

## Contributing | 贡献

**English:** PRs welcome! See `CONTRIBUTING.md` (coming soon).

**中文：** 欢迎 PR！参见 `CONTRIBUTING.md`（即将推出）。

---

## License | 许可证

MIT © 2026 wangwu-30

---

## Star History | Star 历史

If this helps your team, give it a ⭐! Goal: 10k stars by showing **value on day one** and **zero-friction install**.

如果这对你的团队有帮助，给它一个 ⭐！目标：通过**第一天就有价值**和**零摩擦安装**达到 10k stars。

[![Star History Chart](https://api.star-history.com/svg?repos=wangwu-30/teamrecall&type=Date)](https://star-history.com/#wangwu-30/teamrecall&Date)
