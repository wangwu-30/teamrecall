export type MemoryKind = "gotcha" | "decision" | "convention" | "map";
export type MemoryStatus = "active" | "retired" | "superseded" | "abandoned";
export type MemoryScope = "always" | "triggered";
export type PathsSource = "distiller" | "inferred" | "human";
export type LearnAction = "reuse" | "update" | "merge" | "propose_retire" | "new" | "no_op";

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
    review_url?: string;
    commits?: string[];
  };
  author: string;
  created: string;
  review_after: string;
  status: MemoryStatus;
  superseded_by?: string;
}

export interface Memory {
  frontmatter: MemoryFrontmatter;
  body: string;
  filepath: string;
}

export interface TeamRecallConfig {
  max_active_memories: number;
  review_ttl_days: number;
  distillation_model?: string;
  retrieve_always_cap?: number;
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
  commit_messages: string[];
  commits: string[];
  files: string[];
  evidence_files: string[];
}
