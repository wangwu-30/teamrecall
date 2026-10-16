export type MemoryKind = "gotcha" | "decision" | "convention" | "map";
export type MemoryStatus = "candidate" | "active" | "retired" | "superseded" | "abandoned";
export type MemoryScope = "always" | "triggered";
export type PathsSource = "distiller" | "inferred" | "human";
export type LearnAction = "reuse" | "update" | "merge" | "propose_retire" | "new" | "promote" | "no_op";

export interface MemoryTrigger {
  glob: string;
  contains?: string;
  pr?: string;
}

export interface MemoryFrontmatter {
  id: string;
  kind: MemoryKind;
  paths: string[];
  paths_source?: PathsSource;
  scope?: MemoryScope;
  triggers?: MemoryTrigger[];
  evidence: {
    pr?: string;
    prs?: string[];
    reviewers?: string[];
    review_url?: string;
    commits?: string[];
  };
  author: string;
  created: string;
  review_after: string;
  status: MemoryStatus;
  superseded_by?: string;
  usage?: RuleUsage;
}

export interface RuleUsage {
  retrieval_count: number;
  citation_count: number;
  cited_prs: string[];
  origin_pr: string;
  last_retrieved_at?: string;
  last_used_at?: string;
}

export interface Memory {
  frontmatter: MemoryFrontmatter;
  body: string;
  filepath: string;
}

export interface TeamRecallConfig {
  max_active_memories: number;
  review_ttl_days: number;
  promotion_min_prs?: number;
  dedup_similarity_threshold?: number;
  distillation_model?: string;
  retrieve_always_cap?: number;
  experimental?: {
    retrieval?: boolean;
  };
}

export interface LearnOutcome {
  action: LearnAction;
  memory_id?: string;
  title?: string;
  kind?: MemoryKind;
  paths?: string[];
  applies_to?: string[];
  scope?: MemoryScope;
  triggers?: MemoryTrigger[];
  body?: string;
  reasoning: string;
  memories?: LearnOutcome[];
  contradicts?: boolean;
  conflict_with?: string;
  candidate_id?: string;
  same_as?: string;
}

export interface ReviewCandidate {
  id: string;
  gist: string;
  terms: string[];
  files: string[];
  pr: string;
  url?: string;
  date: string;
  reviewer: string;
  promoted_to?: string;
}

export interface CompiledOutput {
  agents_md: string;
  index_md: string;
  compact_index: string;
  claude_rules: Map<string, string>;
  cursor_rules: Map<string, string>;
}

export interface PullRequestContext {
  number: string;
  title: string;
  body: string;
  url: string;
  author: string;
  diff: string;
  merged: boolean;
  review_comments: string[];
  human_review_comments: string[];
  reviewer_comments: Array<{ body: string; author: string; path?: string }>;
  commit_messages: string[];
  commits: string[];
  files: string[];
  evidence_files: string[];
}
