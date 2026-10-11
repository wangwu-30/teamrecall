export interface AuthoredComment {
  body: string;
  author: string;
  user_type?: string;
  path?: string;
}

/** Plain logins `gh pr view` returns without a `[bot]` suffix. */
export const KNOWN_BOT_LOGINS = new Set([
  "github-actions",
  "codecov",
  "vercel",
  "dependabot",
  "renovate",
  "copilot",
  "cursor",
  "imgbot",
  "netlify",
  "supabase",
]);

export function isBotAuthor(author: string, userType?: string): boolean {
  if (userType && userType.toLowerCase() === "bot") return true;
  const login = author.trim().toLowerCase();
  if (!login) return false;
  if (login.includes("[bot]") || login.endsWith("-bot")) return true;
  return KNOWN_BOT_LOGINS.has(login);
}

export function humanCommentBodies(comments: AuthoredComment[]): string[] {
  const bodies: string[] = [];
  for (const comment of comments) {
    const body = comment.body.trim();
    if (!body || isBotAuthor(comment.author, comment.user_type)) continue;
    if (!bodies.includes(body)) bodies.push(body);
  }
  return bodies;
}

export function shouldLearnFromClosedPr(input: {
  merged: boolean;
  human_review_comments: string[];
}): boolean {
  return input.merged || input.human_review_comments.some((body) => body.trim().length > 0);
}
