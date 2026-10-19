// The edges of the service. Everything here has a real adapter (src/github.ts,
// src/openrouter.ts) and a test fake (test/harness.ts).

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  headSha: string;
  baseSha: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  /** A multi-line comment's first line. */
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

export interface NewReview {
  commit_id: string;
  /** APPROVE only when approvals are enabled and the run is clean; never REQUEST_CHANGES. */
  event: 'COMMENT' | 'APPROVE';
  body: string;
  comments: ReviewComment[];
}

/** A review thread this app started. */
export interface ReviewThread {
  id: string;
  resolved: boolean;
  /** Who resolved it, when resolved. `association` as on comments below. */
  resolvedBy?: { login: string; association: string };
  path: string;
  /** The line at the head revision; null once the code it was posted on has changed. */
  line: number | null;
  /** The diff hunk the first comment was posted on, as it was then. */
  diffHunk: string;
  /** `association` is GitHub's author_association (OWNER, MEMBER, COLLABORATOR, NONE, ...). */
  comments: { byApp: boolean; byPrAuthor: boolean; login: string; association: string; body: string }[];
}

export interface GitHubPort {
  mintToken(installationId: number): Promise<string>;
  /** URL the bare clone fetches from. Credentials never go in it. */
  cloneUrl(repo: string): string;
  getPullRequest(token: string, repo: string, number: number): Promise<PullRequest>;
  /**
   * Reviews this app posted on the PR; anyone else's are left out, so nobody can forge the marker.
   * `state` is GitHub's (APPROVED, COMMENTED, DISMISSED, ...).
   */
  listReviews(token: string, repo: string, number: number): Promise<{ id: number; body: string; state: string }[]>;
  createReview(token: string, repo: string, number: number, review: NewReview): Promise<{ id: number }>;
  /** Dismiss one of this app's reviews. Branch protection can refuse it. */
  dismissReview(token: string, repo: string, number: number, reviewId: number, message: string): Promise<void>;
  /** The review threads this app started on the PR, resolved or not. */
  reviewThreads(token: string, repo: string, number: number): Promise<ReviewThread[]>;
  replyToThread(token: string, threadId: string, body: string): Promise<void>;
  resolveThread(token: string, threadId: string): Promise<void>;
}

// OpenAI-compatible chat-with-tools shapes (what OpenRouter speaks).
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface ChatRequest {
  model: string;
  /** OpenRouter's fallback list, primary first. */
  models?: string[];
  messages: ChatMessage[];
  tools: ToolDef[];
  /** OpenRouter session: groups a PR's calls in its dashboard and keeps them on one provider. */
  session_id?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** USD, as OpenRouter bills it. */
  cost: number;
}

export interface ChatResponse {
  message: AssistantMessage;
  /** The model that actually served the call, which may be the fallback. */
  model: string;
  usage: Usage;
}

export interface ModelInfo {
  id: string;
  supported_parameters?: string[];
}

export interface ModelPort {
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<ModelInfo[]>;
}

export interface Clock {
  now(): Date;
}
