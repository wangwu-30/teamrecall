export interface AuthoredComment {
  body: string;
  author: string;
  user_type?: string;
  path?: string;
  in_reply_to?: number | string | null;
}

export interface ReviewerComment {
  body: string;
  author: string;
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

export function isLinkOnlyComment(text: string): boolean {
  const stripped = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return stripped.length < 8;
}

export function isThanksComment(text: string): boolean {
  return /^(thanks|thank you|thx|ty|lgtm|sgtm|cheers)[\s!.]*$/i.test(text.trim());
}

export function isClosingOrReopenComment(text: string): boolean {
  return /\b(closing this|i('?ll| will) close|reopen(ing)? this|closed this)\b/i.test(text);
}

export function isAiDisclosureComment(text: string): boolean {
  return (
    /\b(i'?m a real person|i am a real person)\b/i.test(text)
    || /\b(i|we)\s+(used|generated|wrote)\b.{0,60}\b(ai|llm|chatgpt|copilot|cursor)\b/i.test(text)
    || /\b(ai|llm)[ -]?(generated|assisted|authored)\b/i.test(text)
  );
}

export function isLowSignalComment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (isLinkOnlyComment(trimmed)) return true;
  if (isThanksComment(trimmed)) return true;
  if (isClosingOrReopenComment(trimmed)) return true;
  if (isAiDisclosureComment(trimmed)) return true;
  return false;
}

export function isEligibleReviewerComment(comment: AuthoredComment, prAuthor: string): boolean {
  if (!comment.body.trim()) return false;
  if (isBotAuthor(comment.author, comment.user_type)) return false;
  if (comment.author.trim().toLowerCase() === prAuthor.trim().toLowerCase()) return false;
  if (comment.in_reply_to !== undefined && comment.in_reply_to !== null && comment.in_reply_to !== "") {
    return false;
  }
  if (isLowSignalComment(comment.body)) return false;
  return true;
}

export function reviewerComments(comments: AuthoredComment[], prAuthor: string): ReviewerComment[] {
  const seen = new Set<string>();
  const eligible: ReviewerComment[] = [];
  for (const comment of comments) {
    if (!isEligibleReviewerComment(comment, prAuthor)) continue;
    const key = `${comment.author}\n${comment.body.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({
      body: comment.body.trim(),
      author: comment.author,
      ...(comment.path ? { path: comment.path } : {}),
    });
  }
  return eligible;
}
