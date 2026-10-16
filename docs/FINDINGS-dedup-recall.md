# 同类去重与召回排查

状态：accepted，已实现。基线 main c199940；只在本地实现和提交，未运行回放评测。

## 成熟做法与候选

- [Mem0 论文 §2.1](https://arxiv.org/html/2504.19413v1)：先抽取，再检索已有记忆，决定 ADD / UPDATE / DELETE / NOOP；[开源实现](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py)。借鉴写入前决策，不移植其向量库和额外 LLM 调用。
- [LangMem 概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)：语义记忆可组织为持续更新的档案或集合，合并时需要判断是补充已有记忆还是新增。它是结构参考；本任务不调用其模型服务，不能报告其语义判断准确率。
- [Jaccard / MinHash 近重复](https://nlp.stanford.edu/IR-book/html/htmledition/near-duplicates-and-shingling-1.html)：词集合交并比及其概率近似。记忆量小，精确集合比较无需近似索引。
- [SimHash](https://research.google/pubs/detecting-near-duplicates-for-web-crawling/)：用指纹的汉明距离近似文本相似性。实验会比较固定 64 位指纹与精确重合度。
- 仓库已有 `retrieve.ts` 的 BM25 和中英文分词可复用，测试归一化 BM25 与 Jaccard；原始 BM25 分数依赖语料，不直接当作概率。向量模型在禁止外部 API、不装重依赖的约束下没有可用运行时，不作为可执行候选。

## 回放中的重复反例

数据根为 `~/codex-jobs/tr-oos/runs`，每项从 `{v1,v2}/out/{default,first}/replay.json` 的末次快照与 `memories` 历史交叉检查。

- `v1/first`：AI 披露 M-022（#10251、#10403）与 M-042（#10403、#10438）；前者要求亲自写披露，后者要求亲自回复 AI 使用询问。
- `v2/default`：M-006（#10251、#10403）与 M-007（#10403、#10438）。前者为 “When disclosing AI assistance or answering a reviewer's question about whether you are AI, write the response yourself without AI involvement.”；后者为 “your response is ai generated. please do not use ai when responding to are you ai questions”。
- `v2/first`：AI 披露 M-011 与 M-016，来源 PR 同上。
- `v2/first`：文档版本标注 M-002（#10119、#9993、#10138、#9976）要求新 API 标 `<Version>`；M-014（#10430）要求版本标注只在大版本文档切换时清理，不能随 experimental 标记删除。属于同一规则的补充，而非字面近重复。
- 并非四组都重复：`v1/default` 的 AI 规则最终集中在 M-038；`v2/default` 的版本规则最终集中在 M-001。v1 两组只写出了版本清理规则，没有单独的新增 API 版本规则。

## 去重实验与决策

实验只加载既有回放快照和队列，不调用 LLM，不运行 `replay_live.mjs`。脚本及中间数据位于任务目录 `./scratch/`，不提交：`experiment.mjs`、`minhash.mjs`、`refine.mjs`、`cosine.mjs`、`selected.mjs`、`decision.mjs`、`decision-sentences.mjs`、`final-experiment.mjs`。

### 数据与方法

四组末次快照共 110 条记忆。每组分别取上述 AI/版本目标规则，与该组其他记忆做成对比较：279 对，4 对同类、275 对不同类。跨组不互相比，避免把同一回放文本复制当成独立样本。增加 4 对手写样例：中文同义改写 1 对，以及中文引入版本/弃用状态、英文引入版本/弃用提示、英文认证要求/否定要求 3 对不同类。共 **283 对：5 正、278 负**。这些判断来自本次阅读正文，不使用评测标签文件。属于小型开发实验，不能估算真实召回率或生产误合并率。

- Jaccard：复用 `retrieve.tokenize`（含 CJK unigram/bigram），精确词集合交并比。
- MinHash：同样词集合，64 个固定种子 `0..63`，对 `seed:term` 做 SHA-256 取首 32 位最小值；相同签名比例估计 Jaccard。
- SimHash：每个唯一词的 SHA-256 前 64 位投票，零票取 0；分数为 `1 - Hamming/64`。
- BM25：复用仓库实现，在每对文本上建立索引，分别用两侧查询；分数为两方向“对侧分数 / 自身分数”的较小值，避免直接对原始 BM25 用固定阈值。
- 词频余弦初稿：词干与停用词处理后计算余弦。曾删除 API/文档等领域词并设 0.35，开发样例看似全过；独立挑刺发现这是不充分的拟合，已弃用。

| 可执行候选 | 阈值 | 误合并 / 278 | 漏合并 / 5 | 判断 |
|---|---:|---:|---:|---|
| 精确 Jaccard | 0.20 | 4 | 2 | 文档新增与清理只共享少量核心词 |
| 精确 Jaccard | 0.50 | 2 | 4 | 提高阈值仍挡不住近似反义句 |
| MinHash（64） | 0.20 | 4 | 2 | 近似集合重合，不能增加语义信息 |
| MinHash（64） | 0.50 | 2 | 4 | 不为小集合增加签名机制 |
| SimHash（64） | 0.60 | 27 | 1 | 误合并过多 |
| SimHash（64） | 0.80 | 1 | 5 | 阈值收紧后丢掉所有正例 |
| 双向归一化 BM25 | 0.20 | 4 | 4 | 检索相关不等于同类 |
| 双向归一化 BM25 | 0.80 | 0 | 5 | 无法单独承担写入决策 |

Mem0/LangMem 是写入决策结构的参考，不是本次可运行的本地分类器。未安装或调用它们，未测量其模型准确率；向量检索也未伪装成已完成实验。

### 挑刺与最终选择

根因不全在相似度：`v2/default/queue/0066.answer` 对 #10438 明确返回 `action: reuse, memory_id: M-006, same_as: C-5c2f35b9ec11`，但旧 `applyCandidateDecision` 见到候选 ID 就无条件改成 promote；`replay.json` 因而记录新建 M-007。另两组 AI 重复的 #10403 已 reuse 旧规则，但未把此 PR 的原始片段关联为 promoted_to，#10438 又晋升同来源片段。修复直接利用已有动作与证据，不额外建立关联表。

独立非作者评审增加 4 对同主题反例：HTTP 请求认证/记录耗时、认证必须验证/因网关验证而不验证、cursor/offset pagination、两侧都有 never 但交换 request identifier 与 passwords 的否定对象。低分余弦初稿给出 0.522、0.589、0.875、1.0，均可能误合并。因而删除“超过余弦阈值即可合并”的接受路径，也删除 API/文档/标题等领域停用词。

最终方案复用现有决策与存储格式，**不建立业务类别字典或向量库**：

1. 显式 `reuse/update/merge/propose_retire/no_op` 不再被附带的 `same_as/candidate_id` 覆盖。已有 `promoted_to` 映射优先于相似度。
2. 每条 `new/promote` 在 TTL 退休处理后、写入前，与当前工作集合中的 `candidate/active` 比较；因此能看到同批先前的新建/更新。比较路径与实际写入路径解析一致，experimental 模式也使用 `resolveMemoryPaths`。
3. 需要路径重叠，且满足以下之一：保留否定与词序的规范化文本相等；原候选来源 PR 已在目标证据中；两边共有完整有序二词短语且该完整短语在至少一侧重复出现。PR 交集或共享一个词均不单独触发合并。
4. 后两条仍需正文分数达到 `dedup_similarity_threshold`（默认 **0.3**，有效区间 `(0,1]`）。计算整段和句子中的最高词频余弦，去掉句首 `when …,` 触发背景，至少共享两个实词；英文复用已有分词并做有限词形处理，汉字采用 Node 内置 `Intl.Segmenter` 的多字词，避免语法单字造成虚假重合。保留简单的否定目标冲突与单个主题词替换保护。
5. 多个命中按分数降序、ID 升序选一个。`contradicts/conflict_with` 不走自动合并。相似度不是逻辑等价证明；这些保护也不是通用的自然语言矛盾检测器。

最终 287 对（增加 4 个挑战，共 **5 正、282 负**）直接调用生产 `ruleSimilarity`：默认 0.3 下 **误合并 0、漏合并 0**。其中候选来源关系用快照 `usage.origin_pr` 与目标 `evidence.prs` 核对；真实 AI 队列又确认 #10403 曾显式 reuse M-022/M-011，#10438 的 C-5c2f35b9ec11 正来自 #10403。版本补充通过 `version annotation` 的完整词组重复命中。阈值 0.35 漏 1，0.4 漏 2，0.5 漏 3；0.2/0.25 在此小集合也为 0/0，选 0.3 保留更多保守余量。这仍是开发集加挑战集结果，**不是重新跑出的回放评测分数**。

| 真实重复对 | 最终匹配分数 | 支持条件 |
|---|---:|---|
| v1/first M-022 / M-042 | 0.400 | 候选来源 #10403 已被旧规则引用 |
| v2/default M-006 / M-007 | 0.500 | 同来源；实际上先修复显式 reuse 优先级即可避免新建 |
| v2/first M-002 / M-014 | 0.342 | 完整 `version annotation` 词组重复 |
| v2/first M-011 / M-016 | 0.405 | 候选来源 #10403 已被旧规则引用 |

消融结果：去掉动作优先级会重现 M-006→M-007；去掉逐条匹配会让同批重复 new 分配两个 ID；去掉关联条件、只看分数会误合并挑战集；只保留旧正文会丢掉版本清理义务；重新传旧 paths 给 `planUpdate` 会将 human 来源错误改成 distiller，甚至把 always 降成 triggered；experimental 匹配不先解析路径则会在写入回退后仍产生重复。这些路径均有回归测试。

边界与未做事项：

- 自动 UPDATE 保留 ID、文件名、路径及来源、scope、triggers；正文包含旧规则和补充，合并 PR/reviewer/commit 证据，仅当前不同 PR 增加一次引用，并调用原 v2 激活门槛。旧 evidence 不回填成虚构的使用次数。
- 合并超过既有 120 词上限时，转为 `reuse` 保留完整旧正文，完整新提案放进 outcome.reasoning，明确要求显式整合；不会静默截断新义务，也不会另建 ID。本次四个真实样例不触发此边界。
- `retired/superseded/abandoned` 不参与模糊匹配。普通新规则可新建另一个 ID；旧 ID 和历史保留。显式指向 retired 的 reuse 或 `promoted_to` 不复活，也不悄悄转向另一条记忆。
- 这是保守的词法与来源启发式：没有相同词形、短语或来源的真正同义改写可能漏合并；同 PR 证据也可能涉及多条规则。没有跨语言翻译能力，不宣称中文与英文互译能自动归类。
- 没有重写现存历史重复文件；本次约束是在未来写入前拦截。未加依赖、未改 v2 提示词。

## 召回审计

审计脚本 `scratch/audit.mjs` 只读四组 `replay.json`、`queue/*.meta.json`、`*.prompt.md`、`*.answer`，并以 `data/events.json` 和 `replay_live.mjs` 还原过滤。四组 `out/{default,first}.log` 的汇总与 JSON 一致。两版 vendored `human-comments.js` 与当前仓库编译文件逐字一致，因此原因归类使用的正是回放过滤实现。

### 218 事件与 143 auto no_op

四组计数均相同：**218 = 71 次 LLM + 143 次脚本 auto no_op + 4 次 teamrecall 提前跳过**；parse_failed=0、llm_errors=0。不能把 218−143=75 全当作进了 LLM。

| 互斥事件原因（按实际过滤顺序归类） | v1/default | v1/first | v2/default | v2/first |
|---|---:|---:|---:|---:|
| 记录中没有评论 | 94 | 94 | 94 | 94 |
| 只有 PR 作者评论 | 38 | 38 | 38 | 38 |
| 只有低信号评论 | 7 | 7 | 7 | 7 |
| 作者评论 + 回复过滤 | 1 | 1 | 1 | 1 |
| 作者评论 + 低信号评论 | 3 | 3 | 3 | 3 |
| auto no_op 合计 | 143 | 143 | 143 | 143 |

143 个事件中有 84 条已记录评论被排除：作者 73、回复 1、低信号 10。低信号进一步为链接说明 2、关闭/解决冲突 4、不足五词 4；没有因 issuecomment 类型被排除的分支，也没有 bot/空白贡献到这 84 条计数。原数据中没有记录的评论无法从这些输出反推，94 指“记录为空”，不是证明 GitHub 从未有过评论。

另 4 个 #10029、#10231、#10205、#9953 是 closed-unmerged 且无 human comments，在 `runLearn` 的 `shouldLearnFromClosedPr` 前置判断退出，未调用脚本的 distill 回调，所以不计入 auto_noop。窗口内数据中的评论时间晚于 learn_time 的数量为 0；回放脚本依赖数据预先截断，本身没有在 map 前再次做时间过滤。

### 五类、九条 URL 逐条核对

以下队列编号在四组中相同。`new` 指 LLM 答案；按 v2 存储规则仍写成 status=candidate。原始片段 `C-*` 是另一类 recurrence candidate，即使 LLM no_op 也会记录，不能把“已有 C”误说成“写出了 M”。

| 类别 / PR / 队列 | 评论是否进提示 | v1/default | v1/first | v2/default | v2/first |
|---|---|---|---|---|---|
| issue/复现 #10133 / 0001 | issuecomment 全文 | no_op | no_op | no_op | no_op |
| issue/复现 #10350 / 无 | 不在 learn_time 窗口 | 未进入 | 未进入 | 未进入 | 未进入 |
| 注释精简 #10357 / 0067 | 全文 | no_op | no_op | no_op | no_op |
| 扩展测试 #10129 / 0007 | 全文 | no_op | new：当前安装的 Vite 版本 | no_op | new：当前安装的 Vite 版本 |
| 扩展测试 #10272 / 0036 | 全文 | new：CLI/worker 颜色覆盖 | new：CLI/worker 颜色覆盖 | no_op | no_op |
| 扩展 fixture #10415 / 0055 | 全文 | no_op | no_op | no_op | no_op |
| 扩展 fixture #10418 / 0056 | 全文 | no_op | reuse M-014：UI 测试位置 | reuse M-003：UI 测试位置 | reuse M-009：UI 测试位置 |
| 单一职责 #10113 / 0069 | 全文 | no_op | new：benchmark baseline 文档 | no_op | no_op |
| 不加防御代码 #10113 / 0069 | 仅头部，尾部被截断 | 同上一行 | 同上一行 | 同上一行 | 同上一行 |

具体依据（路径前缀均为 `runs/{版本}/out/{模式}/queue/`）：

1. **issue + 最小复现后再提修复 PR / #10133** — [定位评论](https://github.com/vitest-dev/vitest/pull/10133#issuecomment-4234436437)。

   learn_time `2026-04-14T02:30:04Z`；作者 `sheremet-va`，通过 reviewer 过滤；queue `0001.prompt.md/.answer`；片段 `C-d3ff3e777e4b` 已记录。

   评论原文：I don't see how this is possible. No user code runs while mocks are resolving. Vitest stops the module execution entirely. Please, provide a reproduction first

   - `v1/default`：`no_op`。The proposed race condition was disputed, and the author reported that the issue persisted. No diff or reproduction details establish a reusable technical rule. The request for a reproduction is a first-time process comment and does not warrant a memory.
   - `v1/first`：`no_op`。The reviewer challenged this specific race hypothesis and requested a reproduction. The issue persisted after the proposed fix, and no diff or validated cause is provided. This does not establish a reusable rule or supported technical conclusion.
   - `v2/default`：`no_op`。The reviewer requested a reproduction for a speculative race condition, and the author later reported that the issue persisted. This is a first-time process comment and an unvalidated local fix, not evidence of a standing team convention that should change decisions in future PRs.
   - `v2/first`：`no_op`。The reviewer requested a reproduction to challenge this specific race hypothesis, not to establish a standing team rule. The issue persisted after the proposed fix, and no implementation evidence or reusable convention was established. Generalizing this into a requirement for future concurrency fixes would exceed the evidence.

2. **issue + 最小复现后再提修复 PR / #10350** — [定位评论](https://github.com/vitest-dev/vitest/pull/10350#issuecomment-4454286172)。

   `data/events.json` 中 learn_time 是 **2026-08-11T13:12:00Z**，来源为 closed_at；评论时间是 5 月 14 日。`replay_live.mjs` 按 learn_time 选择 `[2026-04-11, 2026-06-01)`，不是按评论时间。所以这个 PR 不属于 218 个事件，没有 queue、LLM 答案或自动 no_op。定位标签给出的评论时间落窗，并不等于 PR 学习事件落窗。评论实际要求“先开 issue 理解用例”，没有要求最小复现。

3. **注释精简 / #10357** — [定位评论](https://github.com/vitest-dev/vitest/pull/10357#discussion_r3258385923)。

   learn_time `2026-05-28T00:54:06Z`；作者 `sheremet-va`，通过 reviewer 过滤；queue `0067.prompt.md/.answer`；片段 `C-2e7dcb9039a1` 已记录。

   评论原文：This comment should've just been removed

   - `v1/default`：`no_op`。The request to remove a comment is a first-time style observation without a matching recurrence candidate. The description does not specify which keyboard descriptors are portable or their provider-specific behavior, so it cannot support an actionable engineering rule. The CI rerun report adds no reusable rule.
   - `v1/first`：`no_op`。The request to remove a particular comment is PR-specific and does not establish a reusable rule. The description lacks concrete keyboard descriptor behavior to capture, and the CI rerun report does not establish a team policy.
   - `v2/default`：`no_op`。The human review requests removing a specific comment but gives no rationale establishing a reusable convention. The CI rerun report describes a one-time troubleshooting action. Neither supports a rule that would change a decision in a future, different PR, and no existing memory or recurrence candidate is validated.
   - `v2/first`：`no_op`。The reviewer’s request to remove a particular comment is PR-specific and does not establish a broader convention about comments. The CI rerun note likewise provides no standing team rule. Neither supports a decision change in a future, different PR.

4. **扩展已有测试/fixture / #10129** — [定位评论](https://github.com/vitest-dev/vitest/pull/10129#discussion_r3091346180)。

   learn_time `2026-04-21T10:56:23Z`；作者 `sheremet-va`，通过 reviewer 过滤；queue `0007.prompt.md/.answer`；片段 `C-b9f6ea92fa50` 已记录。

   评论原文：This file is not required, we only test for the vite version installed in the repo

   - `v1/default`：`no_op`。Review feedback requests regression tests in the existing suite, testing only the repository’s installed Vite version, and distinct test names. These are first-time testing and naming conventions with no matching recurrence candidate. The SSR import-prefix fix is specific to this bug and does not establish a broader rule worth capturing.
   - `v1/first`：`new`。The reviewer explicitly states that tests cover only the installed Vite version and rejects an additional file on that basis. This reusable testing policy qualifies as a first-time pending rule and does not repeat an existing memory or candidate.
   - `v2/default`：`no_op`。Human review requests tests, testing only the repository’s installed Vite version, and distinct test names. These are first-time testing/process comments with no matching recurrence candidate. The SSR import-prefix fix is implementation-specific, not evidence of a broader team convention.
   - `v2/first`：`new`。The reviewer explicitly states that the team only tests the installed Vite version and rejects an unnecessary file. This would change a future PR fixing a source-map regression observed on another Vite release: use the repository's installed version instead of adding alternate-version coverage. No supplied memory or recurrence candidate captures this convention.

5. **扩展已有测试/fixture / #10272** — [定位评论](https://github.com/vitest-dev/vitest/pull/10272#discussion_r3187775186)。

   learn_time `2026-05-10T04:45:46Z`；作者 `AriPerkkio`，通过 reviewer 过滤；queue `0036.prompt.md/.answer`；片段 `C-7a10580e52b6` 已记录。

   评论原文：This test should not be changed. Better place would be in  https://github.com/vitest-dev/vitest/blob/d10909848087adeb62a6c1e09140c35fce73d6ca/test/config/test/console-color.test.ts#L1-L79

   - `v1/default`：`new`。Review explicitly identified the missed runtime path and required assertions for worker console output as well as the CLI banner. This changes implementation and validation decisions for future color-policy fixes.
   - `v1/first`：`new`。Reviewers identified the omitted runtime path, directed the regression into the dedicated color suite, and explicitly required a worker console.log assertion alongside the CLI banner. This changes how future color-policy fixes are validated.
   - `v2/default`：`no_op`。Review identifies concrete gaps in this fix: worker-side color handling, assertions for both output sources, and placement in the existing color tests. These are useful local corrections, but the evidence does not establish a standing team convention that changes a decision in a different future PR. No existing memory or recurrence candidate clearly expresses the same rule.
   - `v2/first`：`no_op`。Review feedback addresses this fix’s CLI and worker coverage, test placement, and configuration naming. It does not establish a standing team convention that changes a future, different PR’s decisions without generalizing these local corrections.

6. **扩展已有测试/fixture / #10415** — [定位评论](https://github.com/vitest-dev/vitest/pull/10415#discussion_r3279845045)。

   learn_time `2026-05-22T06:44:51Z`；作者 `hi-ogawa`，通过 reviewer 过滤；queue `0055.prompt.md/.answer`；片段 `C-7db0bdb5a17b` 已记录。

   评论原文：Can you move these into `test/e2e/fixtures/assertion-helper/basic.test.ts`?  Also, we want to add non `vi` async error mentioned in https://github.com/vitest-dev/vitest/issues/10361#issuecomment-4465454155.

   - `v1/default`：`no_op`。The review requests test placement and coverage for a non-vi asynchronous error. Without the diff or linked issue contents, these remain specific test requests rather than evidence of a broader engineering rule. The CI rerun request and unspecified nit add no reusable knowledge, and no recurrence candidate clearly matches.
   - `v1/first`：`no_op`。The reviewer requests moving these tests into an existing fixture and adding a specific non-vi async error case. Without the diff or a stated general testing rule, these are PR-specific corrections. The check-rerun discussion also establishes no reusable team rule.
   - `v2/default`：`no_op`。The review requests a specific test relocation and coverage for a non-vi async error. These are local changes, without evidence of a standing team convention that would change decisions in a different PR. The CI rerun request and unspecified nit also establish no reusable rule. No existing memory or recurrence candidate is validated.
   - `v2/first`：`no_op`。The reviewer requests a specific fixture location and an additional async-error case for this fix. These are local coverage instructions, not evidence of a standing test-placement or regression-testing convention. The failed-check rerun request is also situational. No rule supported here would independently change a decision in a future, different PR.

7. **扩展已有测试/fixture / #10418** — [定位评论](https://github.com/vitest-dev/vitest/pull/10418#discussion_r3280047287)。

   learn_time `2026-05-22T06:55:17Z`；作者 `hi-ogawa`，通过 reviewer 过滤；queue `0056.prompt.md/.answer`；片段 `C-9b31070558c2` 已记录。

   评论原文：@copilot remove new fixtures. piggyback on https://github.com/vitest-dev/vitest/blob/e3de6014bf2a2af3c7ef7c8800a1936b239b232b/test/ui/test/ui.spec.ts#L392-L393 instead.

   - `v1/default`：`no_op`。The requests to add UI coverage and reuse an existing fixture are task-specific testing guidance without enough evidence for a broader rule. The local hang with Playwright tracing enabled is explicitly uncertain. Nothing establishes that this PR concerns live trace streaming or display, so it does not clearly validate M-014 or repeat the trace-related candidates.
   - `v1/first`：`reuse` / `M-014`。The reviewer explicitly requires coverage under test/ui, reinforcing M-014. Reusing the referenced fixture is specific to this regression. The local tracing hang is an uncertain observation and does not establish a broader rule.
   - `v2/default`：`reuse` / `M-003`。Human review explicitly requires regression coverage in test/ui, reinforcing M-003's UI end-to-end test placement rule. A future PR changing displayed test results would use this suite for integration coverage. Reuse the existing memory; the requests to reuse a particular fixture and remove locally problematic tracing do not establish additional standing conventions.
   - `v2/first`：`reuse` / `M-009`。The reviewer explicitly requires UI regression coverage in test/ui, validating M-009. This changes placement decisions in a future PR testing another user-visible UI interaction. The requests to reuse specific fixtures and remove always-on tracing are local changes without enough evidence for separate standing rules.

8. **一个 PR 只做一件事 / #10113** — [定位评论](https://github.com/vitest-dev/vitest/pull/10113#discussion_r3196224930)。

   learn_time `2026-05-29T11:05:08Z`；作者 `AriPerkkio`，通过 reviewer 过滤；queue `0069.prompt.md/.answer`；片段 `C-5f8c7c0f6288` 已记录。

   评论原文：These changes look like unrelated refactoring. Are they related to the feature somehow?

   - `v1/default`：`no_op`。The review raises useful baseline workflow, configuration, and project-relative path concerns, but the truncated comments lack enough context to establish a precise reusable rule. Documentation and API presentation suggestions are first-time feedback, with no clear match to an existing memory or recurrence candidate.
   - `v1/first`：`new`。Reviewers repeatedly found baseline persistence and subsequent-run behavior unclear and explicitly requested generation and commit workflows. This changes how future baseline APIs should be documented without assuming the proposed API was finalized.
   - `v2/default`：`no_op`。The review raises API design questions, documentation gaps, and local implementation corrections, but does not establish a standing team convention. No supplied recurrence candidate or existing memory is clearly validated by the visible comments. Generalizing these truncated discussions into rules for future PRs would exceed the evidence.
   - `v2/first`：`no_op`。The review primarily addresses this benchmark API’s baseline workflow, examples, configuration, and implementation details. Broader remarks about composable APIs and clearer documentation are generic advice, without enough evidence of a standing team convention. No existing memory or recurrence candidate is clearly validated.

9. **不写多余的兜底/防御代码 / #10113** — [定位评论](https://github.com/vitest-dev/vitest/pull/10113#discussion_r3309406422)。

   learn_time `2026-05-29T11:05:08Z`；作者 `hi-ogawa`，通过 reviewer 过滤；queue `0069.prompt.md/.answer`；片段 `C-84198b12f4ca` 已记录。

   评论原文：The optional chain and fallback are not required according to the type `ResolvedConfig.benchmark: Required<BenchmarkUserOptions>`

   四组实际可见尾部均为 `` `ResolvedConfig.benchmark: Required<Benc`` 随后 `...(truncated)`。明确“不需要 optional chain/fallback”的句首可见，完整类型证据不可见。截断来自 teamrecall `capPromptContext/capCommentHeads` 的评论预算，不是作者或 issuecomment 过滤；本任务要求提示词保持不动，未改该路径。

   - `v1/default`：`no_op`。The review raises useful baseline workflow, configuration, and project-relative path concerns, but the truncated comments lack enough context to establish a precise reusable rule. Documentation and API presentation suggestions are first-time feedback, with no clear match to an existing memory or recurrence candidate.
   - `v1/first`：`new`。Reviewers repeatedly found baseline persistence and subsequent-run behavior unclear and explicitly requested generation and commit workflows. This changes how future baseline APIs should be documented without assuming the proposed API was finalized.
   - `v2/default`：`no_op`。The review raises API design questions, documentation gaps, and local implementation corrections, but does not establish a standing team convention. No supplied recurrence candidate or existing memory is clearly validated by the visible comments. Generalizing these truncated discussions into rules for future PRs would exceed the evidence.
   - `v2/first`：`no_op`。The review primarily addresses this benchmark API’s baseline workflow, examples, configuration, and implementation details. Broader remarks about composable APIs and clearer documentation are generic advice, without enough evidence of a standing team convention. No existing memory or recurrence candidate is clearly validated.

结论：这五类没有证据表明 teamrecall 的自动过滤太严。#10133 证明 PR 讨论区 issuecomment 被收录；#10350 是学习时间窗与评论时间窗不一致；其余答案明确选择 no_op、较窄的规则或复用另一条记忆。#10129 的指定评论本身讲的是安装的 Vite 版本，不能强行当成一般 fixture 复用规则；#10357 只要求删某条注释，没有说明“为什么、未来何时适用”。另回放 context.diff 固定为空，模型多次指出缺 diff/上下文。这是生成判断和证据粒度的限制，而非未进入 LLM。因此不放宽 teamrecall 评论过滤，不修改 v2 可复用性判据和正反例。

### replay_live.mjs 补丁建议（未修改 tr-oos）

`askLlm = reviewer_comments.length > 0 || args["all-events"]` 是回放脚本策略，teamrecall 的真实 `runLearn` 没有这条“零 eligible 就不调用 LLM”的门槛。本次定位不要求放宽它；现有 `--all-events` 已提供对照开关，不应再造开关，更不能据此宣称五类召回会恢复。

建议在回放脚本做以下可观察性修补：保留所有 step、区分前置 skipped 和脚本 auto_noop，按上述互斥原因计数。并在构造 context 前显式截断评论时间，防止将来换数据源时意外带入未来评论。示意补丁：

```diff
- const authored = e.comments.map((c) => (...));
+ const visible = e.comments.filter(c => c.created_at <= e.learn_time);
+ const authored = visible.map((c) => (...));
  // reasonOf 按 empty -> bot -> author -> reply -> low_signal 的现有顺序归类，
  // 只做日志，不另写一套 eligibility 判断。
+ step.excluded_comment_reasons = authored.map(c => reasonOf(c, e.author));
+ step.late_comments = e.comments.length - visible.length;
  const res = await LR.runLearn(...);
+ step.skipped = res.skipped ?? null;
- if (!step.auto_noop || res.plan.mutations.length || step.would_ask) log.steps.push(step);
+ log.steps.push(step);
```

`reasonOf` 可在脚本调用现有 HC.isBotAuthor / isLowSignalComment 并复用同一作者/回复条件；只有无 eligible 且 distill 回调实际执行的事件归入 auto_noop 分布。#10350 若要研究评论发生窗口，需要另建按评论时刻触发、具有当时 PR 快照的数据；不能仅把闭合事件的 learn_time 改到 5 月，否则会把 8 月评论/最终 PR 内容泄漏进窗口。本次不创建这种数据、不扩大窗口、不运行对照回放。

## 改动与验证

- `src/dedup.ts`：本地词法匹配、来源/短语支持、否定/主题替换保护和阈值校验。
- `src/learn.ts`：保留显式动作；在每次写入前对已更新工作集合去重；合并正文/证据并沿用 usage 晋升；保留旧 applicability 及来源；尊重 retired 与 promoted_to。
- `src/types.ts`、`src/learn-run.ts`：将 `.memory/config.yml` 的 `dedup_similarity_threshold` 接入正式入口。
- `src/dedup.test.ts`：真实版本补充、AI 来源关联、中英文、同批重复、独立 PR 晋升、同 PR 重试、retired、显式矛盾、实验路径解析、人写规则范围保持、正文上限、独立挑战集、真实 runLearn 配置持久化等回归。
- `docs/promotion-v2.md`：补充代码层去重与计数关系。本报告自身承担本次决策记录，不另建通用经验或知识系统。

`generateDistillationPrompt` 从函数声明到 `parseDistillationResponse` 之前与 HEAD 逐字比较相等，SHA-256 为 `e44261d27d1737f6d456401b4758fa70e17e42438a7524f51d013e1ea3713d3f`。没有通过改提示词达成去重。

最终验证：`npm test` **13 个文件、234 项测试全部通过**（原 203 + 新增 31）；`npm run typecheck`、`npm run build`、`git diff --check` 均通过。package.json 没有 lint 脚本。使用已安装的 Vitest 1.6.1，未安装或更换依赖。独立评审指出的 human 路径来源与 experimental 路径解析问题已修复，并经同一评审者复核通过。

没有运行回放评测，没有安装依赖，没有修改 tr-oos，没有 push/gh/PR。报告在 `docs/FINDINGS-dedup-recall.md` 提交，任务目录 `../FINDINGS.md` 保留同文副本；scratch 实验不提交。
