export type MemoryKind = "gotcha" | "decision" | "convention" | "map";
export type MemoryStatus = "active" | "retired" | "superseded" | "abandoned";
export type LearnAction = "reuse" | "update" | "merge" | "propose_retire" | "new" | "no_op";

export interface MemoryFrontmatter {
  id: string;
  kind: MemoryKind;
  paths: string[];
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
}

export interface LearnOutcome {
  action: LearnAction;
  memory_id?: string;
  title?: string;
  kind?: MemoryKind;
  paths?: string[];
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
  review_comments: string[];
  commit_messages: string[];
  commits: string[];
  files: string[];
}
