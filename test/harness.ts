// The single test seam: build an app with fake GitHub, scripted model, real git
// and real SQLite, send it signed deliveries, drain, and inspect the outputs.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { createApp } from '../src/app.ts';
import type {
  AssistantMessage, ChatRequest, GitHubPort, ModelPort, NewReview, PullRequest,
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

/** A local repo with a base commit and a head commit on top of it. */
export function gitFixture(base: Record<string, string>, head: Record<string, string>) {
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
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
  return { url: `file://${dir}`, baseSha, headSha };
}

export class FakeGitHub implements GitHubPort {
  prs = new Map<string, PullRequest>();
  repos = new Map<string, string>();
  reviews: { repo: string; number: number; review: NewReview; id: number; foreign?: boolean }[] = [];
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
      .map((r) => ({ id: r.id, body: r.review.body }));
  }

  async createReview(token: string, repo: string, number: number, review: NewReview) {
    this.checkToken(token);
    const id = this.nextId++;
    this.reviews.push({ repo, number, review, id });
    return { id };
  }
}

/** A scripted turn, or a callback that can act mid-run (deliver an event, move the PR) before answering. */
export type Turn = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

/** Replays scripted assistant turns in order and records every request. */
export class ScriptedModel implements ModelPort {
  requests: ChatRequest[] = [];
  private turns: Turn[];
  constructor(turns: Turn[]) {
    this.turns = turns;
  }

  async chat(req: ChatRequest) {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error('scripted model ran out of turns');
    return typeof turn === 'function' ? turn() : turn;
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

export function prPayload(action: string, repo: string, pr: PullRequest, extra: Record<string, unknown> = {}) {
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
    },
  };
}

export const openedPayload = (repo: string, pr: PullRequest) => prPayload('opened', repo, pr);

/** Pass an earlier app's dataDir to simulate a restart on the same volume. */
export function testApp(opts: { model: ModelPort; github?: FakeGitHub; allowlist?: string[]; dataDir?: string }) {
  const github = opts.github ?? new FakeGitHub();
  const dataDir = opts.dataDir ?? tempDir();
  const app = createApp({
    config: {
      webhookSecret: WEBHOOK_SECRET,
      allowlist: opts.allowlist ?? ['acme/widgets'],
      model: 'test/model',
      dataDir,
    },
    github,
    model: opts.model,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
  });
  after(() => app.close());
  return { app, github, dataDir };
}
