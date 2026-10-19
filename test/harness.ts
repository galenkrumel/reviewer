// The single test seam: build an app with fake GitHub, scripted model, real git
// and real SQLite, send it signed deliveries, drain, and inspect the outputs.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { createApp, type AppConfig } from '../src/app.ts';
import type {
  AssistantMessage, ChatRequest, GitHubPort, ModelInfo, ModelPort, NewReview, PullRequest, ReviewThread,
} from '../src/ports.ts';

const tmpRoots: string[] = [];
after(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'reviewer-test-'));
  tmpRoots.push(d);
  return d;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

type FixtureFiles = Record<string, string | null | { symlink: string }>;

/** A local repo with a base commit and a head commit on top of it. A null value deletes the file. */
export function gitFixture(base: FixtureFiles, head: FixtureFiles) {
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  const commit = (files: FixtureFiles, msg: string) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) { rmSync(join(dir, path)); continue; }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      if (typeof content === 'string') writeFileSync(join(dir, path), content);
      else symlinkSync(content.symlink, join(dir, path));
    }
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'uploadpack.allowFilter', 'true');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const baseSha = commit(base, 'base');
  const headSha = commit(head, 'head');
  /** Commit on top of the current head, returning the new head SHA. */
  const push = (files: FixtureFiles) => commit(files, 'push');
  return { url: `file://${dir}`, baseSha, headSha, push, git };
}

export class FakeGitHub implements GitHubPort {
  prs = new Map<string, PullRequest>();
  repos = new Map<string, string>();
  reviews: { repo: string; number: number; review: NewReview; id: number; foreign?: boolean; dismissed?: string }[] = [];
  /** Threads this app started, per `repo#number`. */
  threads = new Map<string, ReviewThread[]>();
  /** Thread reads throw while set. */
  threadsDown = false;
  /** Resolving throws while set, as GitHub does without the permission it wants. */
  resolveRefused = false;
  /** Dismissing throws while set, as GitHub does when branch protection restricts who may dismiss. */
  dismissRefused = false;
  /** Every dismissal attempted, refused or not. */
  dismissals: number[] = [];
  tokensMinted: number[] = [];
  private nextId = 1;

  addPullRequest(repo: string, url: string, pr: PullRequest) {
    this.repos.set(repo, url);
    this.prs.set(`${repo}#${pr.number}`, pr);
  }

  private checkToken(token: string) {
    if (!token.startsWith('ghs_fake_')) throw new Error('bad token');
  }

  async mintToken(installationId: number) {
    this.tokensMinted.push(installationId);
    return `ghs_fake_${installationId}`;
  }

  cloneUrl(repo: string) {
    const url = this.repos.get(repo);
    if (!url) throw new Error(`no such repo ${repo}`);
    return url;
  }

  async getPullRequest(token: string, repo: string, number: number) {
    this.checkToken(token);
    const pr = this.prs.get(`${repo}#${number}`);
    if (!pr) throw new Error('404');
    return { ...pr };
  }

  async listReviews(token: string, repo: string, number: number) {
    this.checkToken(token);
    return this.reviews
      .filter((r) => r.repo === repo && r.number === number && !r.foreign)
      .map((r) => ({
        id: r.id, body: r.review.body,
        state: r.dismissed !== undefined ? 'DISMISSED' : r.review.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED',
      }));
  }

  /** Records the message on the review; only this app's reviews can be dismissed through the port. */
  async dismissReview(token: string, repo: string, number: number, reviewId: number, message: string) {
    this.checkToken(token);
    this.dismissals.push(reviewId);
    if (this.dismissRefused) throw new Error('GitHub PUT dismissals: 403');
    const r = this.reviews.find((x) => x.repo === repo && x.number === number && x.id === reviewId && !x.foreign);
    if (!r) throw new Error('404');
    r.dismissed = message;
  }

  async createReview(token: string, repo: string, number: number, review: NewReview) {
    this.checkToken(token);
    const id = this.nextId++;
    this.reviews.push({ repo, number, review, id });
    return { id };
  }

  /** Open a thread this app started, with its first comment. */
  addThread(repo: string, number: number, path: string, line: number | null, body: string) {
    const key = `${repo}#${number}`;
    const list = this.threads.get(key) ?? [];
    const thread: ReviewThread = {
      id: `T${list.length}`, path, line, diffHunk: '@@ -1 +1 @@', resolved: false,
      comments: [{ byApp: true, byPrAuthor: false, login: 'reviewer[bot]', association: 'NONE', body }],
    };
    list.push(thread);
    this.threads.set(key, list);
    return thread;
  }

  private thread(id: string) {
    const t = [...this.threads.values()].flat().find((x) => x.id === id);
    if (!t) throw new Error(`no thread ${id}`);
    return t;
  }

  async reviewThreads(token: string, repo: string, number: number) {
    this.checkToken(token);
    if (this.threadsDown) throw new Error('GitHub GraphQL: 502');
    return structuredClone(this.threads.get(`${repo}#${number}`) ?? []);
  }

  /** Someone resolves a thread in GitHub's UI. */
  resolveAs(threadId: string, login: string, association: string) {
    Object.assign(this.thread(threadId), { resolved: true, resolvedBy: { login, association } });
  }

  /** Someone unresolves a thread in GitHub's UI. */
  unresolve(threadId: string) {
    const t = this.thread(threadId);
    t.resolved = false;
    delete t.resolvedBy;
  }

  async replyToThread(token: string, threadId: string, body: string) {
    this.checkToken(token);
    this.thread(threadId).comments.push({ byApp: true, byPrAuthor: false, login: 'reviewer[bot]', association: 'NONE', body });
  }

  async resolveThread(token: string, threadId: string) {
    this.checkToken(token);
    if (this.resolveRefused) throw new Error('GitHub GraphQL: Resource not accessible by integration');
    this.thread(threadId).resolved = true;
  }
}

/** A scripted turn, or a callback that can act mid-run (deliver an event, move the PR) before answering. */
export type Turn = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

/** The agent a request is for, from its system prompt ("You are the <agent> ..."). */
export function agentOf(req: ChatRequest): string {
  const system = req.messages[0];
  return (system?.role === 'system' && /^You are the (\w+)/.exec(system.content)?.[1]) || 'unknown';
}

/**
 * Replays scripted assistant turns per agent and records every request.
 * A scripted agent with no turns left gets an error, so unexpected agents surface as failures.
 * A plain list scripts the correctness reviewer alone: the orchestrator then picks correctness
 * and the always-on security reviewer finds nothing, as often as asked.
 */
export class ScriptedModel implements ModelPort {
  requests: ChatRequest[] = [];
  /** The model OpenRouter reports serving each call; defaults to the requested one. */
  served?: string;
  /** What listModels returns. */
  catalog: ModelInfo[] = [];
  private turns: Record<string, Turn[]>;
  private correctnessOnly: boolean;
  constructor(turns: Turn[] | Record<string, Turn[]>) {
    this.correctnessOnly = Array.isArray(turns);
    turns = Array.isArray(turns) ? { correctness: turns } : turns;
    this.turns = turns;
  }

  /** Every call costs 100 input and 20 output tokens and $0.001. */
  async chat(req: ChatRequest) {
    this.requests.push(structuredClone(req));
    const message = await this.next(req);
    return { message, model: this.served ?? req.model, usage: { inputTokens: 100, outputTokens: 20, cost: 0.001 } };
  }

  async listModels() {
    return this.catalog;
  }

  private async next(req: ChatRequest) {
    const agent = agentOf(req);
    if (this.correctnessOnly && agent === 'orchestrator') return select('correctness');
    if (this.correctnessOnly && agent === 'security') return noFindings();
    // Documentation is always on; a test that doesn't script it gets a clean report.
    if (agent === 'documentation' && !this.turns.documentation) return noFindings();
    const turn = this.turns[agent]?.shift();
    if (!turn) throw new Error(`scripted model has no turn for ${agent}`);
    return typeof turn === 'function' ? turn() : turn;
  }

  /** Requests made by the given agent. */
  requestsFor(agent: string) {
    return this.requests.filter((r) => agentOf(r) === agent);
  }

  /** Distinct agents that were called, in first-call order. */
  agents() {
    return [...new Set(this.requests.map(agentOf))];
  }
}

let callId = 0;
export function toolCall(name: string, args: unknown): AssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: `call_${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** An orchestrator turn selecting the given focuses, each with a stock reason. */
export const select = (...focuses: string[]) =>
  toolCall('select_focuses', { focuses: focuses.map((focus) => ({ focus, reason: `${focus} matters here` })) });

export const noFindings = () => toolCall('report_findings', { findings: [] });

export const WEBHOOK_SECRET = 'test-webhook-secret';

export function delivery(event: string, payload: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  return {
    headers: {
      'x-github-event': event,
      'x-github-delivery': `delivery-${++callId}`,
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
  };
}

export function prPayload(
  action: string, repo: string, pr: PullRequest, extra: Record<string, unknown> = {}, prExtra: Record<string, unknown> = {},
) {
  return {
    action,
    ...extra,
    installation: { id: 42 },
    repository: { full_name: repo },
    pull_request: {
      number: pr.number,
      state: pr.state,
      draft: pr.draft,
      title: 'Change things',
      body: 'Please review',
      head: { sha: pr.headSha },
      base: { sha: pr.baseSha },
      author_association: 'MEMBER',
      labels: [],
      ...prExtra,
    },
  };
}

export const openedPayload = (repo: string, pr: PullRequest) => prPayload('opened', repo, pr);

/** Pass an earlier app's dataDir to simulate a restart on the same volume. */
export function testApp(opts: {
  model: ModelPort; github?: FakeGitHub; allowlist?: string[]; dataDir?: string; config?: Partial<AppConfig>; time?: Date;
}) {
  const github = opts.github ?? new FakeGitHub();
  const dataDir = opts.dataDir ?? tempDir();
  /** Settable: assign clock.time to move the app's clock. */
  const clock = { time: opts.time ?? new Date('2026-01-01T00:00:00Z'), now: () => clock.time };
  /** Backoff waits, which resolve at once, and structured log entries. */
  const sleeps: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    config: {
      webhookSecret: WEBHOOK_SECRET,
      allowlist: opts.allowlist ?? ['acme/widgets'],
      model: 'test/model',
      dataDir,
      // Scripted turns are per agent, so most tests need jobs to run one at a time.
      workerConcurrency: 1,
      ...opts.config,
    },
    github,
    model: opts.model,
    clock,
    sleep: async (ms) => void sleeps.push(ms),
    log: (entry) => void logs.push(entry),
  });
  after(() => app.close());
  return { app, github, dataDir, clock, sleeps, logs };
}
