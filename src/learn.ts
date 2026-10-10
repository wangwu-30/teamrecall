import type { LearnOutcome, Memory } from "./types.js";

export interface LearnInput {
  pr_number: string;
  diff: string;
  pr_body: string;
  review_comments: string[];
  commit_messages: string[];
  existing_memories: Memory[];
}

export function generateDistillationPrompt(input: LearnInput): string {
  const existingIndex = input.existing_memories
    .map((m) => `- ${m.frontmatter.id}: ${extractFirstLine(m.body)} (paths: ${m.frontmatter.paths.join(", ")})`)
    .join("\n");

  return `You are reviewing a merged pull request to extract reusable engineering knowledge for the team.

PR #${input.pr_number}

## PR Description
${input.pr_body || "(empty)"}

## Review Comments
${input.review_comments.length > 0 ? input.review_comments.join("\n\n---\n\n") : "(none)"}

## Commit Messages
${input.commit_messages.join("\n")}

## Diff Summary
${input.diff.slice(0, 3000)}${input.diff.length > 3000 ? "\n...(truncated)" : ""}

## Existing Team Memories
${existingIndex || "(none)"}

---

Your task: Decide if this PR contains reusable engineering knowledge worth capturing.

A memory must have:
1. Observable trigger condition (when to apply it)
2. Decision it changes (not just facts)
3. Broader applicability beyond this specific PR

Choose ONE outcome (respond with ONLY the JSON, no other text):

\`\`\`json
{
  "action": "reuse|update|merge|propose_retire|new|no_op",
  "memory_id": "M-xxx (if reuse/update/merge/propose_retire)",
  "title": "Short title (if new/update)",
  "kind": "gotcha|decision|convention|map (if new)",
  "paths": ["glob patterns (if new/update)"],
  "body": "≤120 words: trigger and decision change (if new/update)",
  "reasoning": "Why this action"
}
\`\`\`

Actions:
- **reuse**: This PR validates an existing memory (no change needed)
- **update**: Strengthen/correct an existing memory with new evidence
- **merge**: Consolidate overlapping memories
- **propose_retire**: This PR shows a memory is outdated
- **new**: Create a new memory (max 3 per PR, only if clearly useful for future PRs)
- **no_op**: No reusable knowledge (most PRs should be no_op)

Bias toward no_op. Only create new memories if they would change future decisions.`;
}

function extractFirstLine(body: string): string {
  return body.trim().split("\n")[0] || "";
}

export function parseDistillationResponse(response: string): LearnOutcome {
  try {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;
    const parsed = JSON.parse(jsonStr);

    if (!parsed.action || !parsed.reasoning) {
      throw new Error("Missing required fields");
    }

    return parsed as LearnOutcome;
  } catch (error) {
    return {
      action: "no_op",
      reasoning: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface DedupResult {
  is_duplicate: boolean;
  existing_id?: string;
  reason: string;
}

export function checkDuplicate(
  title: string,
  paths: string[],
  existing: Memory[],
): DedupResult {
  const normalizedTitle = title.toLowerCase().trim();

  for (const mem of existing) {
    const existingTitle = extractFirstLine(mem.body).toLowerCase().trim();
    const titleSimilar = levenshteinDistance(normalizedTitle, existingTitle) < 5;

    const pathsOverlap = paths.some((p) => mem.frontmatter.paths.includes(p));

    if (titleSimilar && pathsOverlap) {
      return {
        is_duplicate: true,
        existing_id: mem.frontmatter.id,
        reason: `Similar to existing ${mem.frontmatter.id}`,
      };
    }
  }

  return {
    is_duplicate: false,
    reason: "No duplicate found",
  };
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
