export { backfillProject, collectRuleSources, extractRuleLessons } from "./backfill.js";
export { compactLine, compileMemories, generateCompactIndex, indexIsCapped, listStaleGeneratedRules, rankMemoriesForIndex, writeCompiledFiles } from "./compiler.js";
export {
  candidatesOverlap,
  extractTerms,
  generateCandidateId,
  isPromotableQuality,
  loadCandidates,
  matchCandidate,
  mergeCandidateLists,
  normalizeGist,
  pruneCandidates,
  recordCandidates,
  stripHtml,
  toImperativeBody,
} from "./candidates.js";
export {
  AGENTS_INDEX_MAX_LINES,
  CANDIDATE_CAP,
  CANDIDATE_PROMPT_FILES,
  CANDIDATE_PROMPT_GUARANTEED,
  CANDIDATE_PROMPT_K,
  CANDIDATE_TTL_DAYS,
  CLAUDE_INDEX_IMPORT,
  COMPILE_ALWAYS_CAP,
  COMPILE_TRIGGERED_CAP,
  PROMPT_COMMITS_CHARS,
  PROMPT_CONTEXT_CHARS,
  PROMPT_MEMORY_K,
  PROMPT_MEMORY_TITLE_CHARS,
  MAX_ACTIVE_MEMORIES,
  MAX_BODY_WORDS,
  STATE_BRANCH,
  TEAMRECALL_END,
  TEAMRECALL_START,
} from "./constants.js";
export { runDoctor } from "./doctor.js";
export {
  HUMAN_ACTIONS_SETTING,
  HUMAN_SECRET_COMMAND,
  humanOnboardingActions,
  initProject,
  loadSweepWorkflowTemplate,
  runInitCommand,
  toInitJson,
} from "./init.js";
export {
  DETERMINISTIC_DISTILLER_NOTE,
  LLM_FAILED_DISTILLER_NOTE,
  buildLearnPrBody,
  buildLearnPrTitle,
  checkDuplicate,
  fallbackOutcomeFromReviews,
  forceUpdateIfDuplicate,
  capCommitMessages,
  capPromptContext,
  formatPromptCandidate,
  generateDistillationPrompt,
  matchingReviewer,
  maybePromoteFromCandidates,
  selectPromptCandidates,
  selectPromptMemories,
  parseDistillationResponse,
  applyAppliesTo,
  applyCandidateDecision,
  gateAlwaysScope,
  detectConflicts,
  inferPaths,
  inferPathsExperimental,
  inferPathsV02,
  keepSpecificPaths,
  resolveMemoryPaths,
  pathsOverlap,
  planLearnOutcomes,
} from "./learn.js";
export {
  CLAUDE_DISALLOWED_TOOLS,
  claudeDistillArgs,
  hasLlmSecret,
  runLearn,
  sanitisedChildEnv,
  shouldOpenLearnPr,
} from "./learn-run.js";
export { humanCommentBodies, isBotAuthor, isEligibleReviewerComment, reviewerComments, shouldLearnFromClosedPr } from "./human-comments.js";
export { AUTHORED_COMMENT_JQ, GIT_AUTHOR_NAME, MANAGED_GIT_PATHS, authoredCommentApiArgs, createOrReusePullRequest, evidenceFilesFromComments, getDefaultBranch, gitIdentityArgs, gitPushArgs, isCandidateStatePath, pullRequestAlreadyExists, stageManagedChanges, startPointForBotBranch } from "./github.js";
export {
  clampBody,
  countWords,
  formatMemory,
  generateMemoryId,
  defaultScope,
  isValidFrontmatter,
  loadConfig,
  loadMemories,
  memoryScope,
  parseMemory,
  slugify,
  validateMemoryBody,
  validateSupersededBy,
} from "./memory.js";
export { bm25Scores, bm25ScoresFromIndex, buildBm25Index, formatRetrieveText, isTrustedPathSource, matchContains, runRetrieve, tokenize, triggerMatches } from "./retrieve.js";
export { expandBraces, formatSweepReport, globMatches, globToRegExp, isExpired, isPathDead, runSweep } from "./sweep.js";
export type {
  CompiledOutput,
  LearnOutcome,
  Memory,
  MemoryFrontmatter,
  MemoryScope,
  MemoryTrigger,
  PathsSource,
  PullRequestContext,
  ReviewCandidate,
  TeamRecallConfig,
} from "./types.js";

export { emptyUsage, recordCitation, recordRetrieval, retireIfIdle } from "./usage.js";
export type { RuleUsage } from "./types.js";
