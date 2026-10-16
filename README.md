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

The agent follows [`INSTALL.md`](INSTALL.md): detects the repo, runs `npx -y github:wangwu-30/teamrecall#<latest-tag> init --yes --json` (latest release tag, currently `v0.3.0`), backfills, compiles, runs `doctor`, and opens the first PR. Re-run is safe. Zero-secret mode only collects recurrence candidates and compiles existing hand-written memories. Recurrence promotion needs an LLM engine (`claude` / `codex` CLI or `CLAUDE_CODE_OAUTH_TOKEN`).

**Or run it yourself:**

```bash
npx -y github:wangwu-30/teamrecall#v0.3.0 init --yes
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
npx -y github:wangwu-30/teamrecall#v0.3.0 init --yes --json

# Compile memories into agent rules
npx -y github:wangwu-30/teamrecall#v0.3.0 compile

# Check installation
npx -y github:wangwu-30/teamrecall#v0.3.0 doctor

# Learn from a PR (no LLM → record candidates only; promotion needs claude/codex or an API key)
npx -y github:wangwu-30/teamrecall#v0.3.0 learn 42

# Experimental: rank memories for a change (opt-in; not used by default compile)
npx -y github:wangwu-30/teamrecall#v0.3.0 retrieve -- src/foo.ts
```

`teamrecall retrieve` is experimental. Default compile still writes path-scoped rules and the root index the same way as v0.3.0 (catalog/id order). Retrieve clamps triggered memories to 10 per query (`-k` / `--top` is capped at 10).

Candidate gists live on the `teamrecall/state` branch only (public on public repos). Actions cache cannot accumulate across `pull_request` runs, so it is not used.

`teamrecall retrieve` 是实验功能。默认编译仍按 v0.3.0 用目录/id 顺序写路径规则和根索引。retrieve 每次查询最多 10 条 triggered（`-k` / `--top` 上限为 10）。

候选 gist 只存在 `teamrecall/state` 分支上（公开仓库上该分支也是公开的）。Actions cache 无法在 `pull_request` 运行之间累积，因此不使用。

---

## vs. Other Approaches | 对比其他方法

**English:**

| Approach | Pros | Cons |
|----------|------|------|
| **Personal memory** (claude-mem, etc.) | Easy per-user setup | Not shared, no review, API cost |
| **Wiki / Notion** | Flexible | Agents can't read, becomes stale |
| **Custom prompts** (.cursorrules, CLAUDE.md) | Works today | Manual, no provenance, no TTL |
| **teamrecall** | **Git-native, reviewed, auto-learned, zero infra** | Early stage (v0.3.0) |

**中文：**

| 方法 | 优点 | 缺点 |
|------|------|------|
| **个人记忆**（claude-mem 等）| 每个用户设置简单 | 不共享、无审查、API 成本 |
| **Wiki / Notion** | 灵活 | 助手无法读取，会过时 |
| **自定义提示**（.cursorrules、CLAUDE.md）| 现在就能用 | 手动、无来源、无 TTL |
| **teamrecall** | **基于 Git、经过审查、自动学习、零基础设施** | 早期阶段（v0.3.0）|

---

## FAQ | 常见问题

**Q: Does this share private code with Claude's API?**

**English:** No. teamrecall learns only from **reviewed PRs** in your repo (using your team's Claude subscription via OAuth, same as Claude Code). It never accesses private chats or drafts. All memories are stored in your repo, reviewed by your team.

**中文：** 不会。teamrecall 仅从你仓库中**经过审查的 PR** 学习（通过 OAuth 使用你团队的 Claude 订阅，与 Claude Code 相同）。它从不访问私人聊天或草稿。所有记忆都存储在你的仓库中，由你的团队审查。

---

**Q: What if I don't use Claude Code?**

**English:** teamrecall works with Cursor, Codex, and any agent that reads `.cursorrules` or `AGENTS.md`. The learning workflow can use `codex exec` instead of `claude -p` (see `npx -y github:wangwu-30/teamrecall#v0.3.0 learn`).

**中文：** teamrecall 支持 Cursor、Codex 以及任何读取 `.cursorrules` 或 `AGENTS.md` 的助手。学习工作流可以使用 `codex exec` 代替 `claude -p`（参见 `npx -y github:wangwu-30/teamrecall#v0.3.0 learn`）。

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

**English:** Each memory has a `review_after` date (default: +90 days). On use (referenced in a PR), it's auto-renewed. The weekly `sweep` job flags expired memories for review and proposes retiring memories whose paths no longer match tracked files.

**中文：** 每个记忆都有一个 `review_after` 日期（默认：+90 天）。使用时（在 PR 中引用），它会自动续期。每周 `sweep` 任务会标记过期记忆以供审查，并提议退休路径已不匹配任何受跟踪文件的记忆。

---

## Demo | 演示

<!--
[GIF placeholder / GIF 占位]
Record GIF showing Alice's PR → bot PR → Bob's Cursor agent referencing M-012.
录制 GIF：Alice 的 PR → 机器人 PR → Bob 的 Cursor 助手引用 M-012。
-->

---

## Roadmap | 路线图

**Current release: v0.3.0.** Shipped items are confirmed by local git history and repository files.

**English — shipped:**
- [x] Core: init, compile, types, tests, GitHub Action scaffold
- [x] Full `learn` command and dedupe handling
- [x] Claude/Copilot indexes, memory lifecycle, and weekly `sweep` for expired and path-dead memories
- [x] Agent onboarding via [`INSTALL.md`](INSTALL.md): one-line setup, idempotent init, and zero-secret candidate collection
- [x] Learning from closed-unmerged PRs with human review comments
- [x] Experimental hybrid retrieval (`retrieve`): paths/triggers plus BM25; opt-in, outside default compile
- [x] Recurrence-based memory promotion (requires an LLM engine)

**English — open:**
- [ ] Conflict handling and duplicate merge suggestions in the weekly job
- [ ] Demo repo with sample memories (usage examples exist in [`examples/`](examples/))
- [ ] GIF walkthrough
- [ ] Slack/Discord notifications for new memories
- [ ] VS Code extension
- [ ] Analytics (most-used memories)

**当前版本：v0.3.0。** 已交付项依据本地 Git 历史和仓库文件确认。

**中文 — 已交付：**
- [x] 核心：init、compile、类型、测试、GitHub Action 框架
- [x] 完整 `learn` 命令及去重处理
- [x] Claude/Copilot 索引、记忆生命周期，以及检查过期记忆和失效路径的每周 `sweep`
- [x] 通过 [`INSTALL.md`](INSTALL.md) 引导编码助手安装：一行设置、可重复执行的 init、零密钥候选收集
- [x] 从有人工审查评论、关闭但未合并的 PR 中学习
- [x] 实验性混合检索（`retrieve`）：路径/触发条件与 BM25；需主动调用，不用于默认编译
- [x] 基于重复出现的记忆晋升（需要 LLM 引擎）

**中文 — 待完成：**
- [ ] 每周任务中的冲突处理与重复记忆合并建议
- [ ] 带有示例记忆的演示仓库（[`examples/`](examples/) 已有用法示例）
- [ ] GIF 演示
- [ ] 新记忆的 Slack/Discord 通知
- [ ] VS Code 扩展
- [ ] 分析统计（最常使用的记忆）

---

## Contributing | 贡献

**English:** PRs welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md).

**中文：** 欢迎 PR！参见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## License | 许可证

MIT © 2026 wangwu-30

---

## Star History | Star 历史

If this helps your team, give it a ⭐! Goal: 10k stars by showing **value on day one** and **zero-friction install**.

如果这对你的团队有帮助，给它一个 ⭐！目标：通过**第一天就有价值**和**零摩擦安装**达到 10k stars。

[![Star History Chart](https://api.star-history.com/svg?repos=wangwu-30/teamrecall&type=Date)](https://star-history.com/#wangwu-30/teamrecall&Date)

### Promotion lifecycle v2

New distilled rules are candidates, excluded from agent instructions until cited
by two distinct subsequent PRs (`promotion_min_prs: 2` in `.memory/config.yml`).
Git frontmatter records retrieval counts, distinct cited PRs and last-use dates.
Learning retires rules idle for `review_ttl_days` (default 90); retrieval alone
never promotes or renews them. `propose_retire` also preserves a retired record.
See [the lifecycle contract and design references](docs/promotion-v2.md) for
counter semantics, compatibility, operational limits and validation details.
