export interface MemoryFrontmatter {
  id: string;
  kind: "gotcha" | "decision" | "convention" | "map";
  paths: string[];
  evidence: {
    pr?: string;
    review_url?: string;
    commits?: string[];
  };
  author: string;
  created: string;
  review_after: string;
  status: "active" | "retired";
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
  action: "reuse" | "update" | "merge" | "propose_retire" | "new" | "no_op";
  memory_id?: string;
  title?: string;
  reasoning: string;
}

export interface CompiledOutput {
  agents_md: string;
  index_md: string;
  claude_rules: Map<string, string>;
  cursor_rules: Map<string, string>;
}
