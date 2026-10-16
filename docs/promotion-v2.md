# Promotion by subsequent use (accepted)

The supplied June–August replay showed that direct `new` writes frequently captured a
single repair as a permanent rule. Examples included a stack-column conversion,
a provider factory replacement, and mock-prototype reset steps. Recurrence alone
can also repeat local work without establishing a team convention. The prompt now
requires a future different PR, independence from incidental identifiers, and an
explicit team decision supported by review; it includes three positive and three
rewritten negative examples without evaluation labels.

## Contract

- Raw review snippets remain in the existing candidates JSONL. Distilled rules use
  normal `M-*` Markdown files with `status: candidate` and `usage` frontmatter.
- `new` starts at zero citations. A `promote` from a raw snippet starts with that
  snippet's origin PR; the current, different PR supplies its first citation.
- `reuse`, `update`, `merge`, or repeat `promote` are explicit distiller citations
  of a rule applied by current human review. They are **not verified downstream
  code adoption**. Mere retrieval, path similarity, or repeated words do not count.
- `usage.cited_prs` deduplicates normalized PR numbers, excluding `origin_pr`.
  `citation_count` is its length. `promotion_min_prs` in `.memory/config.yml`
  defaults to 2 (two distinct PRs after origin). Values must be positive integers.
- `retrieval_count` counts each exposure in the learning prompt or a disk-backed
  `retrieve` result. `last_retrieved_at` tracks exposure; `last_used_at` tracks a
  new distinct citation. Replaying a PR can add exposure, never another citation.
  In-memory retrieval with explicit `memories` remains pure for evaluation.
- Candidate rules participate in learning prompts but never compiler output or
  normal agent retrieval. Only active rules reach Claude/Cursor/Codex instructions.
- Every ordinary learning run retires active/candidate rules idle for
  `review_ttl_days` (default 90), using last citation or creation if never cited.
  Retrieval cannot renew this TTL. No background service is added; absent a learn
  invocation, no automatic state change occurs. `propose_retire` retires immediately.
  Retirement preserves the rule in place, reserving its ID and counters, and it
  cannot be undone by a later outcome in the same response or ordinary reuse.
- Existing active files without usage remain readable and start counters at zero
  on first observation; historical evidence is not invented as usage. Human
  backfill remains trusted and active. Existing review-sweep behavior is unchanged.
- The active cap remains 50. Proposals may still be recorded when it is full;
  an otherwise eligible activation stays candidate. No autonomous capacity eviction.
- Counters are ordinary Git changes. As with learning today, callers must serialize
  writers to a checkout and review/commit resulting files; atomic replacement alone
  does not provide concurrent read-modify-write locking.

## Choices and sources

Network access was restricted to the replay's LLM calls. The following are reference
locations, not claims of having fetched or verified their current contents:

- Precedent Loop: https://www.v2ex.com/t/1246437 — implemented the task's supplied
  description: retain exposure/use, promote on subsequent use, retire stale/rejected rules.
- Cursor rules: https://docs.cursor.com/context/rules and Claude memory:
  https://docs.anthropic.com/en/docs/claude-code/memory — inspiration for scoped,
  maintained rule files. The candidate/active/retired lifecycle here is our policy,
  not attributed to either product as a built-in promotion algorithm.
- Redis eviction / LRU: https://redis.io/docs/latest/develop/reference/eviction/
  — use recency for retention; implemented as a Git-native idle TTL, not a cache server.
- Wilson confidence interval (Wilson, 1927, JASA):
  https://doi.org/10.1080/01621459.1927.10502953 — considered confidence-bound ranking
  but rejected for now: retrieval is not a Bernoulli trial and an unmentioned rule
  is not an observed failure. A hit/citation ratio would penalize broad exposure
  and imply unsupported statistical confidence. Distinct-PR thresholds plus TTL
  are simpler and auditable; revisit when explicit adoption/rejection trials exist.

Keeping direct activation would leave the observed failure intact. Counting hits
instead of citations would allow retrieval to reinforce its own noise. Removing
per-PR deduplication lets retries manufacture evidence. Removing pending status
would expose unvalidated rules to agents. These are the minimal retained mechanisms.
Independent agent review was not performed; behavior was checked through real
runLearn → persisted Markdown → compiler/retrieval tests, including same-response
retirement/reuse conflicts and legacy frontmatter.

## Validation environment

`npm ci --offline --ignore-scripts` could not satisfy the lockfile cache. Without
network installation, validation used existing local Vitest 3.2.4, TypeScript
5.9.3, YAML 2.8.3 and Commander 14.0.3 via untracked node_modules links. The unchanged
baseline passed 184 tests with this toolchain before modifications. This does not
claim validation with the lockfile's exact dependency versions. Package manifests
and lockfile are unchanged.

## Same-category writes

Before writing each `new` or `promote`, learning compares its resolved paths and
rule text with the current candidate/active set, after idle retirement. A match
updates the same ID, merges evidence, and counts only the current distinct PR as
a citation. Explicit memory actions and a candidate's `promoted_to` mapping take
precedence over fuzzy matching. Same-response writes participate in later checks;
retired memories never revive through matching.

`.memory/config.yml` accepts `dedup_similarity_threshold` (default `0.3`, greater
than zero and at most one). Similarity alone cannot authorize a merge: ordered
normalized equality, linked candidate evidence, or an emphasized shared phrase
is also required. This local lexical heuristic can miss semantic paraphrases;
it does not call a second model. See [experiments and recall audit](FINDINGS-dedup-recall.md).

Automatic updates retain the original applicability and combine both rule texts.
If the combination exceeds 120 words, learning reuses the existing rule and puts
the complete supplement in the outcome's reasoning for explicit consolidation.
It does not silently truncate the supplement or allocate another ID. Existing
historical duplicates are not migrated by this change.
