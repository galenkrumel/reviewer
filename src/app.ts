// The service: webhook intake (verify, filter, enqueue) and the worker that reviews and publishes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { matchesGlob } from 'node:path';
import { addedLines, openSource, ToolError } from './git.ts';
import { fallbackPicks, runOrchestrator, selectFocuses, type Pick } from './orchestrator.ts';
import { parseRepoConfig, REPO_CONFIG_PATH } from './repoconfig.ts';
import { runReviewer } from './reviewer.ts';
import { selectFiles, type Scope } from './scope.ts';
import { openStore, type Job, type RecordedFinding, type RecordedFocus } from './store.ts';
import type { Clock, GitHubPort, ModelPort, ReviewComment } from './ports.ts';

export interface AppConfig {
  webhookSecret: string;
  /** "owner/repo" names the service acts on. */
  allowlist: string[];
  model: string;
  dataDir: string;
  /** Who else besides OWNER/MEMBER/COLLABORATOR gets reviewed. Default `label`. */
  reviewOutsidePrs?: OutsidePolicy;
  /** Default `ai-review`. */
  reviewLabel?: string;
  /** Runs per PR per rolling 24 hours. Default 10. */
  runCap?: number;
  /** Reviewers per run. Default 3; at least 2, so the always-on correctness and security reviewers both fit. */
  maxReviewers?: number;
  /** Above this many reviewable changed lines the summary recommends splitting the PR. Default 800. */
  maxReviewableLines?: number;
  /** Estimated diff tokens the reviewers may be given; files past it are skipped. Default 50000. */
  reviewTokenBudget?: number;
}

export type OutsidePolicy = 'label' | 'always' | 'never';

export interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
}

export function createApp(deps: { config: AppConfig; github: GitHubPort; model: ModelPort; clock: Clock }) {
  const { config, github, model } = deps;
  const maxReviewers = config.maxReviewers ?? 3;
  // Below 2, the cap would drop the always-on security reviewer.
  if (!Number.isInteger(maxReviewers) || maxReviewers < 2) throw new Error('maxReviewers must be an integer >= 2');
  const store = openStore(config.dataDir, deps.clock);
  const allowlist = new Set(config.allowlist.map((r) => r.toLowerCase()));
  const label = config.reviewLabel ?? 'ai-review';
  const policy = config.reviewOutsidePrs ?? 'label';
  const runCap = config.runCap ?? 10;

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
    if (event === 'pull_request' && (payload.action === 'converted_to_draft' || payload.action === 'closed')) {
      if (!repo || !allowlist.has(repo.toLowerCase())) return { status: 202, ignored: `repo ${repo} not in allowlist` };
      if (!Number.isInteger(pr?.number)) return { status: 400 };
      store.supersede(repo, pr.number);
      return { status: 202, ignored: `${payload.action}: superseded the PR's runs` };
    }
    const ignored = ignoreReason(event, payload, label);
    if (ignored) return { status: 202, ignored };
    if (!repo || !allowlist.has(repo.toLowerCase())) return { status: 202, ignored: `repo ${repo} not in allowlist` };
    if (!Number.isInteger(payload.installation?.id) || !pr?.head?.sha || !pr.base?.sha) return { status: 400 };
    const gated = authorReason(pr, policy, label);
    if (gated) return { status: 202, ignored: gated };

    // Count and insert with no await between them, so concurrent deliveries can't both slip under the cap.
    const capped = store.countRuns(repo, pr.number, new Date(deps.clock.now().getTime() - DAY_MS)) >= runCap;
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
    }, capped ? 'skipped' : 'queued');
    return capped ? { status: 202, ignored: `run cap of ${runCap} per 24h reached` } : { status: 202 };
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
    // Read at the base SHA only, so a PR cannot change its own review by editing the config.
    let configText: string | undefined;
    const configWarnings: string[] = [];
    try {
      configText = await source.fileAtBase(REPO_CONFIG_PATH);
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      configWarnings.push(`${err.message}; ignored`);
    }
    // ponytail: severity, confidence and comment-cap defaults are fixed until finding validation (#8) makes them deployment config.
    const parsed = parseRepoConfig(configText, {
      minSeverity: 'medium', minConfidence: 0.7, maxComments: 10,
      maxReviewers, maxReviewableLines: config.maxReviewableLines ?? 800,
    });
    const settings = parsed.settings;
    store.recordConfigWarnings(job.id, [...configWarnings, ...parsed.warnings]);
    const files = await source.changedFiles();
    const paths = files.map((f) => f.path);
    const excluded = await source.markedAtBase(paths);
    for (const p of paths) if (settings.exclude.some((glob) => matchesGlob(p, glob))) excluded.add(p);
    const scope = selectFiles(files, excluded, config.reviewTokenBudget ?? 50_000);
    const maxLines = settings.maxReviewableLines;

    // Comments anchor only against the reviewed files' diff, so excluded and skipped files are never commented on.
    let diff = '';
    const findings: RecordedFinding[] = [];
    const focuses: RecordedFocus[] = [];
    let orchestratorError: string | undefined;
    if (scope.reviewed.length) {
      diff = await source.reviewDiff(scope.reviewed.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])));
      let picks: Pick[];
      try {
        picks = await runOrchestrator({
          model, modelId: config.model, files: scope.reviewed, title: job.title, body: job.body, pathHints: settings.pathHints,
        });
      } catch (err) {
        // The fallback's path match sees every changed file, excluded ones (lockfiles) included.
        picks = fallbackPicks(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])));
        orchestratorError = err instanceof Error ? err.message : String(err);
      }

      const changed = addedLines(diff);
      // Sequential: one reviewer's failure never stops the others.
      // Disabled focuses leave before the cap, so they take no slot. The always-on ones can't be disabled.
      const enabled = picks.filter((p) => !settings.disabledFocuses.has(p.focus));
      for (const { focus, reason } of selectFocuses(enabled, scope.reviewed.map((f) => f.path), settings.maxReviewers)) {
        if (store.superseded(job.id)) return;
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
    }
    if (store.superseded(job.id)) return;
    const fallbackUsed = orchestratorError !== undefined;
    const comments: ReviewComment[] = findings
      .filter((f) => f.outcome === 'published')
      .map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f) }));

    const record = { findings, focuses, fallbackUsed, orchestratorError };
    const oversized = scope.reviewableLines > maxLines;
    const anyFailed = focuses.some((f) => f.status === 'failed');
    if (comments.length === 0 && !oversized && !scope.skipped.length && !scope.binary.length && !anyFailed) {
      return store.finish(job.id, 'nothing_to_publish', record);
    }

    const live = await github.getPullRequest(token, job.repo, job.pr);
    if (live.state !== 'open' || live.draft || live.headSha !== job.headSha || live.baseSha !== job.baseSha) {
      return store.finish(job.id, 'stale', record);
    }
    if (store.superseded(job.id)) return;
    const { id } = await github.createReview(token, job.repo, job.pr, {
      commit_id: job.headSha,
      event: 'COMMENT',
      body: summary(job, comments.length, { scope, splitAbove: oversized ? maxLines : undefined, focuses, fallbackUsed }),
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

const TRIGGERS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited', 'labeled']);
const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 3600_000;

/** Why a delivery starts no review, or undefined when it should. Drafts are never reviewed. */
function ignoreReason(event: unknown, payload: any, label: string): string | undefined {
  if (event !== 'pull_request') return `event ${String(event)} is not pull_request`;
  if (!TRIGGERS.has(payload.action)) return `action ${payload.action} is not a review trigger`;
  // changes.base holds the old base; the new one is pull_request.base.
  if (payload.action === 'edited' && !payload.changes?.base) return 'edited without a base change';
  if (payload.action === 'labeled' && payload.label?.name !== label) {
    return `label ${payload.label?.name} is not the review label`;
  }
  if (!payload.pull_request) return 'no pull_request in payload';
  if (payload.pull_request.draft) return 'pull request is a draft';
}

/** Why the PR's author isn't eligible, or undefined when they are. */
function authorReason(pr: any, policy: OutsidePolicy, label: string): string | undefined {
  const association = pr.author_association;
  if (TRUSTED_AUTHORS.has(association) || policy === 'always') return;
  if (policy === 'never') return `author ${association} is outside and review_outside_prs is never`;
  // labels is the PR's current set, which on a labeled event already includes the new label.
  if (!pr.labels?.some((l: any) => l?.name === label)) return `author ${association} is outside and the PR lacks label ${label}`;
}

function commentBody(f: RecordedFinding): string {
  let body = `**${f.title}**\n\n\`${f.severity}\` · ${f.focus}\n\n${f.evidence}`;
  if (f.suggested_fix) body += `\n\n**Suggested fix:**\n\n${f.suggested_fix}`;
  return body;
}

/**
 * Paths come from the PR: code spans keep them from mentioning anyone or breaking out, dropping angle brackets keeps
 * them from forging a marker (and so skipping a later review) in the raw body, and long lists are capped.
 */
function pathList(paths: string[], sep: string, max: number): string {
  const shown = paths.slice(0, max).map((p) => '`' + p.replace(/[`<>\r\n]/g, '') + '`');
  if (paths.length > max) shown.push(`…and ${paths.length - max} more`);
  return shown.join(sep);
}

function summary(job: Job, count: number, notes: {
  scope: Scope; splitAbove?: number; focuses: RecordedFocus[]; fallbackUsed: boolean;
}): string {
  const { scope, focuses } = notes;
  const failed = focuses.filter((f) => f.status === 'failed').map((f) => f.focus);
  return [
    notes.splitAbove !== undefined && `**This PR has ${scope.reviewableLines} reviewable changed lines, over the `
      + `${notes.splitAbove}-line limit. Consider splitting it.** Directories involved: ${
        pathList(scope.directories, ', ', 20).replace('`.`', '(repo root)')}.`,
    `**AI review** of \`head@${job.headSha.slice(0, 7)}\` against \`base@${job.baseSha.slice(0, 7)}\``,
    focuses.length > 0 && `Focuses${notes.fallbackUsed ? ' (fallback selection: the orchestrator failed)' : ''}:\n`
      // Reasons are PR-influenced: a code span renders no links, images, mentions or markup.
      + focuses.map((f) => `- ${f.focus}: \`${f.reason}\``).join('\n'),
    // Focus names only; error detail stays in the run record.
    failed.length > 0 && `Failed focuses: ${failed.join(', ')}. Their findings are missing from this review.`,
    scope.skipped.length > 0 && `Skipped (over the review budget):\n- ${pathList(scope.skipped, '\n- ', 50)}`,
    scope.binary.length > 0 && `Not reviewed (binary content):\n- ${pathList(scope.binary, '\n- ', 50)}`,
    `${count} inline comment${count === 1 ? '' : 's'}.`,
    marker(job),
  ].filter(Boolean).join('\n\n');
}

// A label re-review repeats a head/base pair on purpose, so its marker also names the run.
const marker = (job: Job) => `<!-- ai-review:${job.repo}#${job.pr}:${job.headSha}:${job.baseSha}${
  job.event === 'pull_request.labeled' ? `:run-${job.id}` : ''} -->`;
