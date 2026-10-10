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

  async function receive(d: Delivery): Promise<{ status: number; ignored?: string }> {
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
    const ignored = ignoreReason(event, payload);
    if (ignored) return { status: 202, ignored };
    if (!repo || !allowlist.has(repo.toLowerCase())) return { status: 202, ignored: `repo ${repo} not in allowlist` };
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
    const source = await openSource({
      dataDir: config.dataDir, repo: job.repo, url: github.cloneUrl(job.repo), token,
      headSha: job.headSha, baseSha: job.baseSha,
    });
    const diff = await source.diff();
    const reported = await runReviewer({ model, modelId: config.model, source, diff, title: job.title, body: job.body });

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

const TRIGGERS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited']);

/** Why a delivery starts no review, or undefined when it should. Drafts are never reviewed. */
function ignoreReason(event: unknown, payload: any): string | undefined {
  if (event !== 'pull_request') return `event ${String(event)} is not pull_request`;
  if (!TRIGGERS.has(payload.action)) return `action ${payload.action} is not a review trigger`;
  // changes.base holds the old base; the new one is pull_request.base.
  if (payload.action === 'edited' && !payload.changes?.base) return 'edited without a base change';
  if (!payload.pull_request) return 'no pull_request in payload';
  if (payload.pull_request.draft) return 'pull request is a draft';
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
    `<!-- ai-review:${job.repo}#${job.pr}:${job.headSha}:${job.baseSha} -->`,
  ].join('\n\n');
}
