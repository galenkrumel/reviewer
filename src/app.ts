// The service: webhook intake (verify, filter, enqueue) and the worker that reviews and publishes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { addedLines, diffStats, openSource } from './git.ts';
import { fallbackPicks, runOrchestrator, selectFocuses, type Pick } from './orchestrator.ts';
import { runReviewer } from './reviewer.ts';
import { openStore, type Job, type RecordedFinding, type RecordedFocus } from './store.ts';
import type { Clock, GitHubPort, ModelPort, ReviewComment } from './ports.ts';

export interface AppConfig {
  webhookSecret: string;
  /** "owner/repo" names the service acts on. */
  allowlist: string[];
  model: string;
  dataDir: string;
  /** At least 2, so the always-on correctness and security reviewers both fit. */
  maxReviewers: number;
}

export interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
}

export function createApp(deps: { config: AppConfig; github: GitHubPort; model: ModelPort; clock: Clock }) {
  const { config, github, model } = deps;
  // Below 2, the cap would drop the always-on security reviewer.
  if (!Number.isInteger(config.maxReviewers) || config.maxReviewers < 2) throw new Error('maxReviewers must be an integer >= 2');
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
    // ponytail: only `opened` for now; the other lifecycle actions arrive with trigger eligibility.
    if (event !== 'pull_request' || payload.action !== 'opened' || !pr || pr.draft) return { status: 202 };
    if (!repo || !allowlist.has(repo.toLowerCase())) return { status: 202 };
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
    const paths = await source.changedPaths();
    const counted = diffStats(diff);
    const stats = new Map(paths.map((p) => [p, counted.get(p) ?? { added: 0, removed: 0 }]));

    let picks: Pick[];
    let orchestratorError: string | undefined;
    try {
      picks = await runOrchestrator({ model, modelId: config.model, stats, title: job.title, body: job.body });
    } catch (err) {
      picks = fallbackPicks(paths);
      orchestratorError = err instanceof Error ? err.message : String(err);
    }
    const fallbackUsed = orchestratorError !== undefined;

    const changed = addedLines(diff);
    const findings: RecordedFinding[] = [];
    const focuses: RecordedFocus[] = [];
    // Sequential: one reviewer's failure never stops the others.
    for (const { focus, reason } of selectFocuses(picks, paths, config.maxReviewers)) {
      const review = () => runReviewer({ focus, model, modelId: config.model, source, diff, title: job.title, body: job.body });
      try {
        const reported = await review().catch(review); // one retry
        for (const f of reported) {
          findings.push({ ...f, focus, outcome: changed.get(f.path)?.has(f.line) ? 'published' : 'unanchorable' });
        }
        focuses.push({ focus, reason, status: 'succeeded' });
      } catch (err) {
        focuses.push({ focus, reason, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
    const comments: ReviewComment[] = findings
      .filter((f) => f.outcome === 'published')
      .map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f) }));

    const record = { findings, focuses, fallbackUsed, orchestratorError };
    if (comments.length === 0 && focuses.every((f) => f.status === 'succeeded')) {
      return store.finish(job.id, 'nothing_to_publish', record);
    }
    const { id } = await github.createReview(token, job.repo, job.pr, {
      commit_id: job.headSha,
      event: 'COMMENT',
      body: summary(job, focuses, fallbackUsed, comments.length),
      comments,
    });
    store.finish(job.id, 'published', { reviewId: id, ...record });
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

function summary(job: Job, focuses: RecordedFocus[], fallbackUsed: boolean, count: number): string {
  const failed = focuses.filter((f) => f.status === 'failed').map((f) => f.focus);
  return [
    `**AI review** of \`head@${job.headSha.slice(0, 7)}\` against \`base@${job.baseSha.slice(0, 7)}\``,
    `Focuses${fallbackUsed ? ' (fallback selection: the orchestrator failed)' : ''}:\n`
      // Reasons are PR-influenced: a code span renders no links, images, mentions or markup.
      + focuses.map((f) => `- ${f.focus}: \`${f.reason}\``).join('\n'),
    // Focus names only; error detail stays in the run record.
    ...(failed.length ? [`Failed focuses: ${failed.join(', ')}. Their findings are missing from this review.`] : []),
    `${count} inline comment${count === 1 ? '' : 's'}.`,
    `<!-- ai-review:${job.repo}#${job.pr}:${job.headSha}:${job.baseSha} -->`,
  ].join('\n\n');
}
