// The service: webhook intake (verify, filter, enqueue) and the worker that reviews and publishes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { addedLines, openSource } from './git.ts';
import { runReviewer } from './reviewer.ts';
import { openStore, type Job, type RecordedFinding } from './store.ts';
import type { Clock, GitHubPort, ModelPort, ReviewComment } from './ports.ts';

export interface AppConfig {
  webhookSecret: string;
  /** "owner/repo" names the service acts on. */
  allowlist: string[];
  model: string;
  dataDir: string;
}

export interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
}

const FOCUS = 'correctness';

export function createApp(deps: { config: AppConfig; github: GitHubPort; model: ModelPort; clock: Clock }) {
  const { config, github, model } = deps;
  const store = openStore(config.dataDir, deps.clock);
  const allowlist = new Set(config.allowlist.map((r) => r.toLowerCase()));

  function verified(d: Delivery): boolean {
    const sig = d.headers['x-hub-signature-256'];
    if (typeof sig !== 'string') return false;
    const expected = Buffer.from('sha256=' + createHmac('sha256', config.webhookSecret).update(d.body).digest('hex'));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async function receive(d: Delivery): Promise<{ status: number }> {
    if (!verified(d)) return { status: 401 };
    let payload: any;
    try {
      payload = JSON.parse(d.body.toString());
    } catch {
      return { status: 400 };
    }
    const event = d.headers['x-github-event'];
    const pr = payload.pull_request;
    const repo: string | undefined = payload.repository?.full_name;
    if (event !== 'pull_request' || !pr || !repo || !allowlist.has(repo.toLowerCase())) return { status: 202 };
    if (payload.action === 'converted_to_draft' || payload.action === 'closed') {
      if (!Number.isInteger(pr.number)) return { status: 400 };
      store.supersede(repo, pr.number);
      return { status: 202 };
    }
    // ponytail: only `opened` reviews for now; the other lifecycle actions arrive with trigger eligibility.
    if (payload.action !== 'opened' || pr.draft) return { status: 202 };
    if (!Number.isInteger(payload.installation?.id) || !pr.head?.sha || !pr.base?.sha) return { status: 400 };

    store.enqueue({
      deliveryId: String(d.headers['x-github-delivery'] ?? ''),
      event: `pull_request.${payload.action}`,
      repo,
      pr: pr.number,
      installationId: payload.installation.id,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      title: pr.title ?? '',
      body: pr.body ?? '',
    });
    return { status: 202 };
  }

  async function reviewJob(job: Job) {
    const token = await github.mintToken(job.installationId);
    // Idempotency first: if this run's review already exists (e.g. posted before a restart), that is the outcome.
    const existing = (await github.listReviews(token, job.repo, job.pr)).find((r) => r.body.includes(marker(job)));
    if (existing) return store.finish(job.id, 'published', { reviewId: existing.id });
    const source = await openSource({
      dataDir: config.dataDir, repo: job.repo, url: github.cloneUrl(job.repo), token,
      headSha: job.headSha, baseSha: job.baseSha,
    });
    // Superseded runs keep that status and stop: checked between steps and right before publishing.
    if (store.superseded(job.id)) return;
    const diff = await source.diff();
    const reported = await runReviewer({ model, modelId: config.model, source, diff, title: job.title, body: job.body });
    if (store.superseded(job.id)) return;

    const changed = addedLines(diff);
    const findings: RecordedFinding[] = reported.map((f) => ({
      ...f,
      focus: FOCUS,
      outcome: changed.get(f.path)?.has(f.line) ? 'published' : 'unanchorable',
    }));
    const comments: ReviewComment[] = findings
      .filter((f) => f.outcome === 'published')
      .map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f) }));

    if (comments.length === 0) return store.finish(job.id, 'nothing_to_publish', { findings });

    const live = await github.getPullRequest(token, job.repo, job.pr);
    if (live.state !== 'open' || live.draft || live.headSha !== job.headSha || live.baseSha !== job.baseSha) {
      return store.finish(job.id, 'stale', { findings });
    }
    if (store.superseded(job.id)) return;
    const { id } = await github.createReview(token, job.repo, job.pr, {
      commit_id: job.headSha,
      event: 'COMMENT',
      body: summary(job, comments.length),
      comments,
    });
    store.finish(job.id, 'published', { reviewId: id, findings });
  }

  let draining: Promise<void> | undefined;
  /** Process queued jobs until none are left, including ones enqueued meanwhile. */
  function drain(): Promise<void> {
    return (draining ??= (async () => {
      for (let job = store.claimNext(); job; job = store.claimNext()) {
        try {
          await reviewJob(job);
        } catch (err) {
          // ponytail: no retries yet; errors come from git, GitHub or the model and carry no credentials.
          store.finish(job.id, 'failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    })().finally(() => (draining = undefined)));
  }

  return { receive, drain, runs: store.runs, close: store.close };
}

function commentBody(f: RecordedFinding): string {
  let body = `**${f.title}**\n\n\`${f.severity}\` · ${f.focus}\n\n${f.evidence}`;
  if (f.suggested_fix) body += `\n\n**Suggested fix:**\n\n${f.suggested_fix}`;
  return body;
}

function summary(job: Job, count: number): string {
  return [
    `**AI review** of \`head@${job.headSha.slice(0, 7)}\` against \`base@${job.baseSha.slice(0, 7)}\``,
    `Focus: ${FOCUS}`,
    `${count} inline comment${count === 1 ? '' : 's'}.`,
    marker(job),
  ].join('\n\n');
}

const marker = (job: Job) => `<!-- ai-review:${job.repo}#${job.pr}:${job.headSha}:${job.baseSha} -->`;
