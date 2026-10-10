// The service: webhook intake (verify, filter, enqueue) and the worker that reviews and publishes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { addedLines, openSource } from './git.ts';
import { runReviewer } from './reviewer.ts';
import { selectFiles, type Scope } from './scope.ts';
import { openStore, type Finding, type Job, type RecordedFinding } from './store.ts';
import type { Clock, GitHubPort, ModelPort, ReviewComment } from './ports.ts';

export interface AppConfig {
  webhookSecret: string;
  /** "owner/repo" names the service acts on. */
  allowlist: string[];
  model: string;
  dataDir: string;
  /** Above this many reviewable changed lines the summary recommends splitting the PR. Default 800. */
  maxReviewableLines?: number;
  /** Estimated diff tokens the reviewers may be given; files past it are skipped. Default 50000. */
  reviewTokenBudget?: number;
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
    const files = await source.changedFiles();
    const scope = selectFiles(files, await source.markedAtBase(files.map((f) => f.path)),
      config.reviewTokenBudget ?? 50_000);
    const maxLines = config.maxReviewableLines ?? 800;

    // Comments anchor only against the reviewed files' diff, so excluded and skipped files are never commented on.
    let diff = '';
    let reported: Finding[] = [];
    let failed: string | undefined;
    if (scope.reviewed.length) {
      diff = await source.diff(scope.reviewed.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])));
      try {
        reported = await runReviewer({ model, modelId: config.model, source, diff, title: job.title, body: job.body });
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
    }

    const changed = addedLines(diff);
    const findings: RecordedFinding[] = reported.map((f) => ({
      ...f,
      focus: FOCUS,
      outcome: changed.get(f.path)?.has(f.line) ? 'published' : 'unanchorable',
    }));
    const comments: ReviewComment[] = findings
      .filter((f) => f.outcome === 'published')
      .map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f) }));

    const oversized = scope.reviewableLines > maxLines;
    if (comments.length === 0 && !oversized && !scope.skipped.length && failed === undefined) {
      return store.finish(job.id, 'nothing_to_publish', { findings });
    }
    const { id } = await github.createReview(token, job.repo, job.pr, {
      commit_id: job.headSha,
      event: 'COMMENT',
      body: summary(job, comments.length, { scope, splitAbove: oversized ? maxLines : undefined, failed: failed !== undefined }),
      comments,
    });
    store.finish(job.id, 'published', { reviewId: id, findings, error: failed });
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

/** Paths come from the PR: code spans keep them from mentioning anyone or breaking out, and long lists are capped. */
function pathList(paths: string[], sep: string, max: number): string {
  const shown = paths.slice(0, max).map((p) => '`' + p.replace(/[`\r\n]/g, '') + '`');
  if (paths.length > max) shown.push(`…and ${paths.length - max} more`);
  return shown.join(sep);
}

function summary(job: Job, count: number, notes: { scope: Scope; splitAbove?: number; failed: boolean }): string {
  const { scope } = notes;
  return [
    notes.splitAbove !== undefined && `**This PR has ${scope.reviewableLines} reviewable changed lines, over the `
      + `${notes.splitAbove}-line limit. Consider splitting it.** Directories involved: ${pathList(scope.directories, ', ', 20)}.`,
    `**AI review** of \`head@${job.headSha.slice(0, 7)}\` against \`base@${job.baseSha.slice(0, 7)}\``,
    `Focus: ${FOCUS}`,
    notes.failed && `Failed focus: ${FOCUS}`,
    scope.skipped.length > 0 && `Skipped (over the review budget):\n- ${pathList(scope.skipped, '\n- ', 50)}`,
    `${count} inline comment${count === 1 ? '' : 's'}.`,
    `<!-- ai-review:${job.repo}#${job.pr}:${job.headSha}:${job.baseSha} -->`,
  ].filter(Boolean).join('\n\n');
}
