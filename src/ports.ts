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
  event: 'COMMENT';
  body: string;
  comments: ReviewComment[];
}

export interface GitHubPort {
  mintToken(installationId: number): Promise<string>;
  /** URL the bare clone fetches from. Credentials never go in it. */
  cloneUrl(repo: string): string;
  getPullRequest(token: string, repo: string, number: number): Promise<PullRequest>;
  /** Reviews this app posted on the PR; anyone else's are left out, so nobody can forge the marker. */
  listReviews(token: string, repo: string, number: number): Promise<{ id: number; body: string }[]>;
  createReview(token: string, repo: string, number: number, review: NewReview): Promise<{ id: number }>;
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
  messages: ChatMessage[];
  tools: ToolDef[];
}

export interface ModelPort {
  chat(req: ChatRequest): Promise<AssistantMessage>;
}

export interface Clock {
  now(): Date;
}
