// The service: webhook intake (verify, filter, enqueue) and the worker that reviews and publishes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { matchesGlob } from 'node:path';
import { createDashboard } from './dashboard.ts';
import { addedLines, openSource, ToolError, type Source } from './git.ts';
import { absorbed, sanitize, stillReported, threadTitle, toComment, validate, waivedBy, type Severity } from './findings.ts';
import { fallbackPicks, runOrchestrator, selectFocuses, type Pick } from './orchestrator.ts';
import { parseRepoConfig, REPO_CONFIG_PATH } from './repoconfig.ts';
import { BudgetExceeded, FOCUSES, InvalidReport, runReviewer, type Chat } from './reviewer.ts';
import { selectFiles, type Scope } from './scope.ts';
import {
  isRedecision, openStore, type Finding, type Job, type RecordedFinding, type RecordedFocus, type RecordedInvocation, type Waiver,
} from './store.ts';
import { runVerifier, type Verdict } from './verifier.ts';
import type { Clock, GitHubPort, ModelPort, NewReview, PullRequest, ReviewComment, ReviewThread } from './ports.ts';

export const AGENTS = ['orchestrator', 'verifier', ...FOCUSES] as const;
export type Agent = (typeof AGENTS)[number];

/** Overrides for one agent; anything unset takes the deployment-wide default. */
export interface AgentConfig {
  model?: string;
  fallbackModel?: string;
  /** Model calls per reviewer invocation. Default 20. The orchestrator makes one. */
  maxTurns?: number;
  /** Input plus output tokens per invocation, summed over its calls; every call resends the whole conversation. Default 2000000. */
  maxTokens?: number;
}

export interface AppConfig {
  webhookSecret: string;
  /** "owner/repo" names the service acts on. */
  allowlist: string[];
  /** Default OpenRouter model ID for every agent. */
  model: string;
  /** Default OpenRouter fallback model for every agent. */
  fallbackModel?: string;
  agents?: Partial<Record<Agent, AgentConfig>>;
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
  /** Findings below either threshold are not posted. Defaults `medium` and 0.7. */
  minSeverity?: Severity;
  minConfidence?: number;
  /** Inline comments per review, highest severity × confidence first. Default 10. */
  maxComments?: number;
  /** Jobs reviewed at once. Default 2. */
  workerConcurrency?: number;
  /** Finished run records older than this are pruned. Default 90. */
  retentionDays?: number;
  /** Approve a clean run once every thread this app started is resolved. Off by default. */
  approveWhenClean?: boolean;
  /** Basic-auth password for the read-only Dashboard at /admin. Unset, the Dashboard is not served. */
  adminPassword?: string;
}

export type OutsidePolicy = 'label' | 'always' | 'never';

export interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
}

/** One structured log entry. */
export type Log = (entry: Record<string, unknown>) => void;

/** Where a run failed. `run` is anything outside the named steps (a token mint, a PR lookup, a git read). */
type Step = 'fetch' | 'orchestrator' | 'reviewer' | 'validation' | 'verifier' | 'threads' | 'dismiss' | 'publish' | 'run';

/** A failure already logged, its message prefixed with the step. */
class StepError extends Error {}

export function createApp(deps: {
  config: AppConfig; github: GitHubPort; model: ModelPort; clock: Clock;
  /** Backoff waits. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  log: Log;
}) {
  const { config, github, model, log } = deps;
  const maxReviewers = config.maxReviewers ?? 3;
  // Below 2, the cap would drop the always-on security reviewer.
  if (!Number.isInteger(maxReviewers) || maxReviewers < 2) throw new Error('maxReviewers must be an integer >= 2');
  const concurrency = config.workerConcurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('workerConcurrency must be an integer >= 1');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const store = openStore(config.dataDir, deps.clock);
  const retentionMs = (config.retentionDays ?? 90) * DAY_MS;
  /** Drop finished run records past the retention period. Runs at startup; the host calls it daily. */
  const prune = () => store.prune(new Date(deps.clock.now().getTime() - retentionMs));
  prune();
  const allowlist = new Set(config.allowlist.map((r) => r.toLowerCase()));
  const label = config.reviewLabel ?? 'ai-review';
  const policy = config.reviewOutsidePrs ?? 'label';
  const runCap = config.runCap ?? 10;

  const agentConfig = (name: Agent) => {
    const c = config.agents?.[name];
    return {
      model: c?.model ?? config.model,
      fallbackModel: c?.fallbackModel ?? config.fallbackModel,
      maxTurns: c?.maxTurns ?? 20,
      maxTokens: c?.maxTokens ?? 2_000_000,
    };
  };

  /** Startup check: every configured model must exist on OpenRouter and support tools. */
  async function checkModels() {
    const tools = new Map((await model.listModels()).map((m) => [m.id, !!m.supported_parameters?.includes('tools')]));
    const problems = AGENTS.flatMap((name) => {
      const { model: primary, fallbackModel } = agentConfig(name);
      return [primary, fallbackModel].filter((id) => id && !tools.get(id)).map((id) =>
        `agent ${name}: model ${id} ${tools.has(id!) ? 'does not support tools' : 'is not listed'} on OpenRouter`);
    });
    if (problems.length) throw new Error(problems.join('\n'));
  }

  /** A chat for one agent invocation: its model and fallback, usage tallied into `invocations`, tokens budgeted. */
  function meteredChat(job: Job, name: Agent, invocations: RecordedInvocation[]): Chat {
    const { model: primary, fallbackModel, maxTokens } = agentConfig(name);
    const used: RecordedInvocation = { agent: name, models: [], inputTokens: 0, outputTokens: 0, cost: 0 };
    invocations.push(used);
    return async (messages, tools) => {
      const res = await model.chat({ model: primary, models: fallbackModel ? [primary, fallbackModel] : undefined, messages, tools, session_id: `${job.repo.replace('/', '--')}--pr-${job.pr}` });
      if (!used.models.includes(res.model)) used.models.push(res.model);
      used.inputTokens += res.usage.inputTokens;
      used.outputTokens += res.usage.outputTokens;
      used.cost += res.usage.cost;
      // ponytail: checked after each call, so spend can overshoot by one call; pass max_tokens if that matters.
      if (used.inputTokens + used.outputTokens > maxTokens) throw new BudgetExceeded(`over its token budget of ${maxTokens}`);
      return res.message;
    };
  }

  /** One line per step of a run, so the logs alone show what it reviewed, who ran and what they found. */
  function progress(job: Job, msg: string, extra: Record<string, unknown> = {}) {
    log({ level: 'info', msg, run: job.id, repo: job.repo, pr: job.pr, ...extra });
  }

  /**
   * Reply to and resolve the threads the verifier judged fixed, and answer open ones where the author spoke last
   * (answering every open thread would repeat itself on each push). Only while this run is still current.
   * Resolving can be refused (GitHub may want more than pull request write), so a thread counts as closed once its
   * fix is verified and the reply carrying VERIFIED is posted; threads verified on earlier runs get another try.
   * Returns the ids of the closed threads; a thread whose reply fails stays open.
   */
  async function settleThreads(job: Job, token: string, verdicts: Verdict[], verified: ReviewThread[]) {
    const closed = new Set<string>();
    let resolved = 0;
    const act = verdicts.filter((v) => v.resolved || v.thread.comments.at(-1)?.byApp === false);
    if ((!act.length && !verified.length) || store.superseded(job.id)) return { closed, resolved };
    try {
      if (!isCurrent(await github.getPullRequest(token, job.repo, job.pr), job)) return { closed, resolved };
    } catch (err) {
      logFailure(job, 'threads', err, false);
      return { closed, resolved };
    }
    const refused: unknown[] = [];
    const resolve = async (id: string) => {
      closed.add(id);
      await github.resolveThread(token, id).then(() => resolved++, (err) => refused.push(err));
    };
    for (const t of verified) await resolve(t.id);
    for (const v of act) {
      // The model sometimes writes the prefix itself.
      const reply = sanitize(v.reply.replace(/^\s*resolved:\s*/i, ''), job.repo);
      try {
        // Reply first: a crash in between leaves an open thread with its explanation, which the next run re-checks.
        await github.replyToThread(token, v.thread.id, v.resolved ? `Resolved: ${reply}\n\n${VERIFIED}` : reply);
      } catch (err) {
        logFailure(job, 'threads', err, false);
        continue;
      }
      if (v.resolved) await resolve(v.thread.id);
    }
    // Once per run, not per thread: a refusal repeats on every thread and every run until the permission changes.
    if (refused.length) logFailure(job, 'threads', refused[0], false, { unresolved: refused.length });
    return { closed, resolved };
  }

  /**
   * This app's threads (undefined when they couldn't be read) with only trusted comments, recording any new waiver,
   * and the PR's waivers, read from the store, not GitHub's current state: unresolving a waived thread doesn't revoke it.
   */
  async function readThreads(job: Job, token: string) {
    let threads: ReviewThread[] | undefined;
    try {
      threads = await github.reviewThreads(token, job.repo, job.pr);
    } catch (err) {
      logFailure(job, 'threads', err, false);
    }
    // Only people who could resolve a thread themselves get a say: the PR's author and those with write access.
    // Anyone else's replies (anyone at all, on a public repo) never reach the verifier.
    threads = threads?.map((t) => ({ ...t, comments: t.comments.filter((c) => c.byApp || c.byPrAuthor || TRUSTED_AUTHORS.has(c.association)) }));
    // The app can't resolve its own threads, so a maintainer's resolve is a human decision: a waiver, kept for good.
    for (const t of threads ?? []) {
      if (!t.resolved || !TRUSTED_AUTHORS.has(t.resolvedBy?.association ?? '')) continue;
      const w: Waiver = { thread: t.id, by: t.resolvedBy!.login, how: 'resolve', path: t.path, line: t.line, title: threadTitle(t) };
      if (store.recordWaiver(job.repo, job.pr, w)) progress(job, 'finding waived', { thread: w.thread, by: w.by, how: w.how });
    }
    const waivers = store.waivers(job.repo, job.pr);
    const waivedIds = new Set(waivers.map((w) => w.thread));
    return {
      threads, waivers,
      // Waived threads are closed: the verifier never sees them, and they never block.
      open: threads?.filter((t) => !t.resolved && !waivedIds.has(t.id)),
      // Resolved by someone who can't waive (an outside PR's author): still a blocker, unless verified fixed.
      outsideResolved: threads?.filter((t) => t.resolved && !waivedIds.has(t.id)) ?? [],
    };
  }

  // Fetching is idempotent, so a failed attempt is simply repeated.
  const fetchSource = (job: Job, token: string) => oneAtATime(job.repo, () => retrying(job, 'fetch', () => openSource({
    dataDir: config.dataDir, repo: job.repo, url: github.cloneUrl(job.repo), token, headSha: job.headSha, baseSha: job.baseSha,
  })));

  /** The verifier's verdicts on the threads, or undefined when it failed. */
  async function verifyThreads(job: Job, source: Source, threads: ReviewThread[], invocations: RecordedInvocation[]) {
    const verify = () => runVerifier({
      chat: meteredChat(job, 'verifier', invocations), maxTurns: agentConfig('verifier').maxTurns, source, threads,
    });
    try {
      // One retry for a malformed report, as reviewers get; a blown budget would only be spent again.
      return await verify().catch((err) => {
        if (!(err instanceof InvalidReport)) throw err;
        logFailure(job, 'verifier', err, false);
        return verify();
      });
    } catch (err) {
      logFailure(job, 'verifier', err, false);
    }
  }

  /** Post the review and finish the run published, or failed keeping its record. A superseded run posts nothing. */
  async function publish(job: Job, token: string, review: NewReview, record: Parameters<typeof store.finish>[2]) {
    let reviewId: number | undefined;
    try {
      // A failed POST may still have created the review, so every attempt checks the marker first.
      reviewId = await retrying(job, 'publish', async () => {
        if (store.superseded(job.id)) return;
        const posted = (await github.listReviews(token, job.repo, job.pr)).find((r) => r.body.includes(marker(job)));
        if (posted) return posted.id;
        // Another worker may have superseded this run while the list was loading.
        if (store.superseded(job.id)) return;
        return (await github.createReview(token, job.repo, job.pr, review)).id;
      });
    } catch (err) {
      // Keep the findings and costs: only the post is missing.
      return store.finish(job.id, 'failed', { ...record, error: errorMessage(err) });
    }
    if (reviewId !== undefined) store.finish(job.id, 'published', { reviewId, approved: review.event === 'APPROVE', ...record });
  }

  /**
   * Dismiss this app's approvals still in force, so its approval always reflects its latest verdict. Only while the
   * run is current: called right before publishing. Returns the summary line when one may still be in force.
   */
  async function dismissApprovals(job: Job, token: string, blockers: string[]): Promise<string | undefined> {
    if (store.superseded(job.id)) return;
    let approvals: { id: number }[];
    try {
      approvals = (await github.listReviews(token, job.repo, job.pr)).filter((r) => r.state === 'APPROVED');
    } catch (err) {
      // Unknown whether an approval is in force: say so rather than stay silent.
      logFailure(job, 'dismiss', err, false);
      return "This App's earlier reviews couldn't be read, so an earlier approval by it may still be in force.";
    }
    const refused: unknown[] = [];
    for (const r of approvals) {
      await github.dismissReview(token, job.repo, job.pr, r.id, `Not approved: ${blockers.join('; ')}.`)
        .catch((err) => refused.push(err));
    }
    // Once per run, like a refused resolve: branch protection refuses every dismissal until it changes.
    if (refused.length) logFailure(job, 'dismiss', refused[0], false, { undismissed: refused.length });
    if (approvals.length) progress(job, 'approvals dismissed', { dismissed: approvals.length - refused.length });
    if (refused.length) return 'An earlier approval by this App could not be dismissed.';
  }

  /** `warn` when something retries or falls back, `error` when it gives up. Messages only: they carry no credentials. */
  function logFailure(job: Job, step: Step, err: unknown, final: boolean, extra: Record<string, unknown> = {}) {
    log({
      level: final ? 'error' : 'warn', msg: `${step} failed`, step, run: job.id, repo: job.repo, pr: job.pr, ...extra,
      error: errorMessage(err),
    });
  }

  /** Retry with backoff, logging every failure; the last one is rethrown as a StepError. */
  // ponytail: retries every error, 4xx included (~42s wasted on a 422); classify transient errors if that hurts.
  async function retrying<T>(job: Job, step: 'fetch' | 'publish', fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const final = attempt === RETRY_ATTEMPTS;
        logFailure(job, step, err, final, { attempt });
        if (final) throw new StepError(`${step}: ${errorMessage(err)}`);
        await sleep(BACKOFF_MS * 4 ** (attempt - 1));
      }
    }
  }

  // openSource creates the clone and writes its git config, so it runs one at a time per repository.
  const fetches = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const next = (fetches.get(repo) ?? Promise.resolve()).catch(() => {}).then(fn);
    fetches.set(repo, next);
    return next;
  }

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
      event: `${event}.${payload.action}`,
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

  /**
   * Record the run stale. Deliveries can arrive out of order, so a late one for an old revision may have superseded
   * the job for the PR's current one: revive that job. Only a job that was enqueued is revived, so gating still holds.
   */
  function finishStale(job: Job, live: PullRequest, record?: Parameters<typeof store.finish>[2]) {
    store.finish(job.id, 'stale', record); // before reviving, which would otherwise mark this run superseded
    if (live.state === 'open' && !live.draft) store.revive(job.repo, job.pr, live.headSha, live.baseSha);
  }

  async function reviewJob(job: Job) {
    progress(job, 'run started', { event: job.event, head: job.headSha.slice(0, 7) });
    const token = await github.mintToken(job.installationId);
    // Idempotency first: if this run's review already exists (e.g. posted before a restart), that is the outcome.
    const existing = (await github.listReviews(token, job.repo, job.pr)).find((r) => r.body.includes(marker(job)));
    if (existing) return store.finish(job.id, 'published', { reviewId: existing.id, approved: existing.state === 'APPROVED' });
    // Before fetching: a late delivery's head may have been force-pushed away, and reviewing it would be wasted.
    const start = await github.getPullRequest(token, job.repo, job.pr);
    if (!isCurrent(start, job)) return finishStale(job, start);
    const source = await fetchSource(job, token);
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
    const parsed = parseRepoConfig(configText, {
      minSeverity: config.minSeverity ?? 'medium', minConfidence: config.minConfidence ?? 0.7,
      maxComments: config.maxComments ?? 10, maxReviewers, maxReviewableLines: config.maxReviewableLines ?? 800,
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
    const reported: { focus: string; finding: Finding }[] = [];
    const focuses: RecordedFocus[] = [];
    const invocations: RecordedInvocation[] = [];
    let orchestratorError: string | undefined;
    const reviewedPaths = scope.reviewed.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
    if (scope.reviewed.length) diff = await source.reviewDiff(reviewedPaths);
    // After a push, reviewers focus on what changed since the last full review, even if the base moved forward
    // (main merged in). A late finding on a line that review saw is still commented on. A label re-review asks for the
    // whole PR again.
    const last = job.event === 'pull_request.labeled' ? undefined : store.lastReviewed(job.repo, job.pr, job.headSha);
    let newDiff = last === undefined ? undefined : await source.diffSince(last.headSha, last.baseSha, scope.reviewed);
    // The token budget only covered the PR diff. A bigger diff since then (a large revert) gets a full review instead.
    if (newDiff !== undefined && newDiff.length > diff.length) newDiff = undefined;
    const since = newDiff === undefined ? undefined : last!.headSha;
    const fresh = newDiff === undefined ? undefined : addedLines(newDiff);
    progress(job, 'scope', {
      changed: files.length, reviewed: scope.reviewed.length, excluded: excluded.size, skipped: scope.skipped.length,
      binary: scope.binary.length, lines: scope.reviewableLines, ...(since !== undefined && { since: since.slice(0, 7) }),
    });
    // Nothing added since then (a deletion has no line to comment on): no reviewer is worth paying for.
    if (scope.reviewed.length && (!fresh || [...fresh.values()].some((lines) => lines.size))) {
      let picks: Pick[];
      try {
        picks = await runOrchestrator({
          chat: meteredChat(job, 'orchestrator', invocations), files: scope.reviewed, title: job.title, body: job.body,
          pathHints: settings.pathHints,
        });
      } catch (err) {
        // The fallback's path match sees every changed file, excluded ones (lockfiles) included.
        picks = fallbackPicks(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])));
        orchestratorError = errorMessage(err);
        logFailure(job, 'orchestrator', err, false);
      }

      // Sequential: one reviewer's failure never stops the others.
      // Disabled focuses leave before the cap, so they take no slot. The always-on ones can't be disabled.
      const enabled = picks.filter((p) => !settings.disabledFocuses.has(p.focus));
      const selected = selectFocuses(enabled, scope.reviewed.map((f) => f.path), settings.maxReviewers);
      progress(job, 'reviewers picked', { focuses: selected.map((s) => s.focus), fallback: orchestratorError !== undefined });
      for (const { focus, reason } of selected) {
        if (store.superseded(job.id)) return;
        const review = () => runReviewer({
          focus, chat: meteredChat(job, focus, invocations), maxTurns: agentConfig(focus).maxTurns,
          source, diff, newDiff, title: job.title, body: job.body,
        });
        const failed = (err: unknown, final: boolean) =>
          logFailure(job, err instanceof InvalidReport ? 'validation' : 'reviewer', err, final, { focus });
        try {
          // One retry, for bad output (an off-schema report included); a blown budget would only be spent again.
          const found = await review().catch((err) => {
            if (err instanceof BudgetExceeded) throw err;
            failed(err, false);
            return review();
          });
          reported.push(...found.map((finding) => ({ focus, finding })));
          focuses.push({ focus, reason, status: 'succeeded' });
          const used = invocations.filter((i) => i.agent === focus);
          progress(job, 'reviewer finished', {
            focus, findings: found.length, tokens: used.reduce((n, i) => n + i.inputTokens + i.outputTokens, 0),
            cost: used.reduce((n, i) => n + i.cost, 0),
          });
        } catch (err) {
          failed(err, true);
          focuses.push({ focus, reason, status: 'failed', error: errorMessage(err) });
        }
      }
    }
    // The verifier re-checks this app's open threads whether or not reviewers ran: a deletion can be the fix.
    let { threads, waivers, open, outsideResolved } = await readThreads(job, token);
    // Verified on an earlier run (the app's VERIFIED reply is still the last word): not checked again.
    // ponytail: a later push can't reopen a verified thread; a reviewer reporting the issue again keeps it open.
    const unverified = open?.filter((t) => !isVerified(t));
    const verdicts = unverified?.length ? await verifyThreads(job, source, unverified, invocations) : [];
    if (store.superseded(job.id)) return;
    // A maintainer may have waived a thread meanwhile. The re-decision that queued finds nothing published here yet,
    // so this run reads the threads again to honour it.
    // ponytail: a waiver between here and publishing is missed by both; defer re-decisions behind running runs if it bites.
    if (threads) {
      const again = await readThreads(job, token);
      if (again.threads) ({ threads, waivers, open, outsideResolved } = again);
    }
    const verified = open?.filter(isVerified) ?? [];
    const fallbackUsed = orchestratorError !== undefined;
    const changed = addedLines(diff);
    const findings = validate(reported, changed, store.postedFindings(job.repo, job.pr, job.headSha), {
      minSeverity: settings.minSeverity, minConfidence: settings.minConfidence, maxComments: settings.maxComments,
    }, threads, waivers);
    const comments: ReviewComment[] = findings
      .filter((f) => f.outcome === 'published')
      .map((f) => toComment(f, changed, job.repo));

    const oversized = scope.reviewableLines > maxLines;
    const failed = focuses.filter((f) => f.status === 'failed').map((f) => f.focus);
    const unreviewed = scope.skipped.length + scope.binary.length;

    // A thread whose finding a reviewer reported again stays open, even if the verifier thinks otherwise.
    const { closed, resolved } = await settleThreads(job, token,
      (verdicts ?? []).filter((v) => open?.some((t) => t.id === v.thread.id) && (!v.resolved || !stillReported(v.thread, findings))),
      verified.filter((t) => !stillReported(t, findings)));
    const stillOpen = open?.filter((t) => !closed.has(t.id));
    const outsideOpen = outsideResolved.filter((t) => !isVerified(t) || stillReported(t, findings));
    progress(job, 'threads checked', { open: open?.length, closed: closed.size, resolved });

    // Everything that stops an approval, each specific enough for the PR's author to act on.
    // Any finding outcome but below_threshold is a problem someone still sees (published, unanchorable, ...).
    // On an incremental run, an earlier run may have dropped findings for the comment cap: they never became threads.
    // ponytail: that check reads run records, which are pruned after retentionDays; a PR busy for longer can lose them.
    const overCap = findings.filter((f) => f.outcome === 'over_cap').length;
    // What no waiver can lift, kept for re-decisions at this head.
    const unwaivable = [
      // A push that runs no reviewers is never clean: a deleted check is what it would hide. Only after an earlier
      // review does the label help; a PR with nothing reviewable in it runs no reviewers on a full review either.
      focuses.length === 0 && (since !== undefined
        ? `no reviewers ran on this push; add the \`${label}\` label for a full review`
        : 'no reviewers ran: nothing reviewable changed'),
      failed.length > 0 && `the ${listed(failed)} review failed`,
      unreviewed > 0 && `${count(unreviewed, 'file')} went unreviewed (listed below)`,
      since !== undefined && store.droppedOverCap(job.repo, job.pr)
        && 'an earlier review left issues uncommented over its comment cap',
    ].filter((b): b is string => typeof b === 'string');
    const blockers = [
      ...unwaivable,
      ...(comments.length > 0 ? [`${count(comments.length, 'new issue')} commented inline`] : []),
      ...standing(findings, { open, stillOpen, outsideOpen, unchecked: verdicts ? undefined : unverified!.length }),
    ];
    const record = {
      findings, focuses, invocations, fallbackUsed, orchestratorError, skipped: scope.skipped,
      // Here the inline comments block; once they are threads a waiver can close, the ones over the cap still do.
      blockers: [...unwaivable, ...(overCap > 0 ? [`${count(overCap, 'issue')} left uncommented over the comment cap`] : [])],
    };
    const approve = config.approveWhenClean === true && blockers.length === 0;
    progress(job, 'review decided', { comments: comments.length, approve, blockers: blockers.length, findings: outcomes(findings) });
    // With approvals on, every run says where the PR stands, even when there is nothing else to post.
    if (!config.approveWhenClean && comments.length === 0 && !oversized && !unreviewed && !failed.length) {
      return store.finish(job.id, 'nothing_to_publish', record);
    }

    const live = await github.getPullRequest(token, job.repo, job.pr);
    if (!isCurrent(live, job)) return finishStale(job, live, record);
    const undismissed = config.approveWhenClean && !approve ? await dismissApprovals(job, token, blockers) : undefined;
    await publish(job, token, {
      commit_id: job.headSha,
      event: approve ? 'APPROVE' : 'COMMENT',
      body: summary(job, comments.length, {
        scope, splitAbove: oversized ? maxLines : undefined, focuses, fallbackUsed, since, approve,
        blockers: config.approveWhenClean ? blockers : [], undismissed,
        waivers: approve ? accepted(waivers, threads, findings) : [],
      }),
      comments,
    }, record);
  }

  /**
   * Decide approval again at the PR's head without running reviewers: from the latest full run published there, with
   * waivers applied, and the threads as they are now. Posts only when the verdict changes.
   */
  async function redecideJob(job: Job) {
    progress(job, 'run started', { event: job.event, head: job.headSha.slice(0, 7) });
    const token = await github.mintToken(job.installationId);
    const reviews = await github.listReviews(token, job.repo, job.pr);
    const existing = reviews.find((r) => r.body.includes(marker(job)));
    if (existing) return store.finish(job.id, 'published', { reviewId: existing.id, approved: existing.state === 'APPROVED' });
    const start = await github.getPullRequest(token, job.repo, job.pr);
    if (!isCurrent(start, job)) return finishStale(job, start);
    // A re-decision never pays for a full review: with no decision published at this head, there is none to make again.
    // With approvals off, no verdict can change.
    const base = config.approveWhenClean ? store.redecisionBase(job.repo, job.pr, job.headSha, job.baseSha) : undefined;
    if (!base) {
      progress(job, 'nothing to re-decide', { approvals: config.approveWhenClean === true });
      return store.finish(job.id, 'skipped');
    }
    const invocations: RecordedInvocation[] = [];
    const { threads, waivers, open, outsideResolved } = await readThreads(job, token);
    // Unsure where the PR stands: say nothing, rather than flip a verdict or dismiss an approval over a failed read.
    if (!open) return store.finish(job.id, 'failed', { error: "threads: the PR's review threads couldn't be read" });
    // The code is as it was reviewed, so only threads where someone spoke after the app need the verifier.
    const spoken = open.filter((t) => t.comments.at(-1)?.byApp === false);
    let verdicts: Verdict[] | undefined = [];
    if (spoken.length) {
      const source = await fetchSource(job, token);
      if (store.superseded(job.id)) return;
      verdicts = await verifyThreads(job, source, spoken, invocations);
      if (!verdicts) return store.finish(job.id, 'failed', { invocations, error: "verifier: the threads couldn't be re-checked" });
    }
    if (store.superseded(job.id)) return;
    // The run's published findings are threads now, decided by their state. Any other may be a newly waived re-report.
    const isWaived = waivedBy(threads, waivers);
    const findings = base.findings.filter((f) => f.outcome !== 'published' && f.outcome !== 'merged')
      .map((f) => (f.outcome !== 'below_threshold' && isWaived(f) ? { ...f, outcome: 'waived' as const } : f));
    const verified = open.filter(isVerified);
    const { closed, resolved } = await settleThreads(job, token,
      verdicts.filter((v) => !v.resolved || !stillReported(v.thread, findings)),
      verified.filter((t) => !stillReported(t, findings)));
    const stillOpen = open.filter((t) => !closed.has(t.id));
    const outsideOpen = outsideResolved.filter((t) => !isVerified(t) || stillReported(t, findings));
    progress(job, 'threads checked', { open: open.length, closed: closed.size, resolved });

    const blockers = [...base.blockers, ...standing(findings, { open, stillOpen, outsideOpen })];
    const approve = config.approveWhenClean === true && blockers.length === 0;
    const approved = reviews.find((r) => r.id === base.reviewId)?.state === 'APPROVED';
    progress(job, 'review decided', { approve, was: approved, blockers: blockers.length, findings: outcomes(findings) });
    const record = { invocations };
    if (approve === approved) return store.finish(job.id, 'nothing_to_publish', record);
    const live = await github.getPullRequest(token, job.repo, job.pr);
    if (!isCurrent(live, job)) return finishStale(job, live, record);
    const undismissed = approve ? undefined : await dismissApprovals(job, token, blockers);
    await publish(job, token, {
      commit_id: job.headSha,
      event: approve ? 'APPROVE' : 'COMMENT',
      body: [
        `**AI review** of \`head@${job.headSha.slice(0, 7)}\` against \`base@${job.baseSha.slice(0, 7)}\`, decided again `
          + `on its review threads: ${approve ? 'every comment is resolved, verified fixed or waived. Approved.' : 'no longer approved.'}`,
        !approve && `**Not approved:** ${blockers.join('; ')}.`,
        undismissed,
        approve && waivedList(accepted(waivers, threads, findings), job.repo),
        marker(job),
      ].filter(Boolean).join('\n\n'),
      comments: [],
    }, record);
  }

  async function worker() {
    for (let job = store.claimNext(); job; job = store.claimNext()) {
      try {
        await (isRedecision(job.event) ? redecideJob : reviewJob)(job);
      } catch (err) {
        // Errors come from git, GitHub or the model and carry no credentials.
        if (err instanceof StepError) store.finish(job.id, 'failed', { error: err.message });
        else {
          logFailure(job, 'run', err, true);
          store.finish(job.id, 'failed', { error: `run: ${errorMessage(err)}` });
        }
      }
      log({ level: 'info', msg: 'run finished', run: job.id, repo: job.repo, pr: job.pr, ...store.outcome(job.id) });
    }
  }

  const workers = new Set<Promise<void>>();
  /**
   * Top the workers back up to `workerConcurrency` and wait for them to empty the queue, including jobs enqueued
   * meanwhile. A worker stops when it finds the queue empty, so every enqueue must be followed by a drain.
   */
  function drain(): Promise<void> {
    while (workers.size < concurrency) {
      const w: Promise<void> = worker().finally(() => workers.delete(w));
      workers.add(w);
    }
    return Promise.all(workers).then(() => {});
  }

  const dashboard = createDashboard(store, config.adminPassword, () => deps.clock.now());
  return { receive, drain, checkModels, prune, dashboard, runs: store.runs, close: store.close };
}

const TRIGGERS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited', 'labeled']);
const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 3600_000;
/** Fetch and publish: four attempts, 2s, 8s and 32s apart. */
const RETRY_ATTEMPTS = 4;
const BACKOFF_MS = 2000;

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether the PR is open, ready, and at the job's head and base. */
const isCurrent = (live: PullRequest, job: Job) =>
  live.state === 'open' && !live.draft && live.headSha === job.headSha && live.baseSha === job.baseSha;

/** Why a delivery starts no review, or undefined when it should. Drafts are never reviewed. */
function ignoreReason(event: unknown, payload: any, label: string): string | undefined {
  if (event === 'pull_request_review_thread') {
    // Resolving can waive a finding, so approval is decided again; unresolving revokes nothing.
    if (payload.action !== 'resolved') return `action ${payload.action} is not a re-decision trigger`;
    return prReason(payload);
  }
  if (event !== 'pull_request') return `event ${String(event)} is not pull_request`;
  if (!TRIGGERS.has(payload.action)) return `action ${payload.action} is not a review trigger`;
  // changes.base holds the old base; the new one is pull_request.base.
  if (payload.action === 'edited' && !payload.changes?.base) return 'edited without a base change';
  if (payload.action === 'labeled' && payload.label?.name !== label) {
    return `label ${payload.label?.name} is not the review label`;
  }
  return prReason(payload);
}

function prReason(payload: any): string | undefined {
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

/**
 * Paths come from the PR: code spans keep them from mentioning anyone or breaking out, dropping angle brackets keeps
 * them from forging a marker (and so skipping a later review) in the raw body, and long lists are capped.
 */
function pathList(paths: string[], sep: string, max: number): string {
  return capped(paths.map((p) => '`' + p.replace(/[`<>\r\n]/g, '') + '`'), max).join(sep);
}

/** The first `max` items, then a count of the rest. */
function capped(items: string[], max: number): string[] {
  return items.length > max ? [...items.slice(0, max), `…and ${items.length - max} more`] : items;
}

const listed = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
// Locations are built here from the finding's path and line: code spans keep them inert.
const at = (hits: RecordedFinding[]) => ({ n: hits.length, where: pathList(hits.map((f) => `${f.path}:${f.line}`), ', ', 10) });

/**
 * What stops an approval that a waiver or a thread can change: findings reported again or outside the changed lines,
 * and this app's threads (`open` undefined when they couldn't be read). `unchecked` counts threads the verifier failed on.
 */
function standing(findings: RecordedFinding[], t: {
  open?: ReviewThread[]; stillOpen?: ReviewThread[]; outsideOpen: ReviewThread[]; unchecked?: number;
}): string[] {
  const duplicate = at(findings.filter((f) => f.outcome === 'duplicate'));
  const outside = at(findings.filter((f) => f.outcome === 'unanchorable'));
  return [
    duplicate.n > 0 && `a reviewer still reports ${count(duplicate.n, 'issue')} already commented on, at ${duplicate.where}`,
    outside.n > 0 && `${count(outside.n, 'issue')} found outside the changed lines, at ${outside.where}`,
    t.open === undefined && "this PR's review threads couldn't be read",
    t.unchecked !== undefined && `${count(t.unchecked, 'open review thread')} couldn't be re-checked`,
    t.unchecked === undefined && t.stillOpen?.length && `${count(t.stillOpen.length, 'review thread')} still open, on ${
      pathList([...new Set(t.stillOpen.map((x) => x.path))], ', ', 10)}`,
    t.outsideOpen.length > 0 && `${count(t.outsideOpen.length, 'review thread')} resolved by someone who can't waive it, on ${
      pathList([...new Set(t.outsideOpen.map((x) => x.path))], ', ', 10)}`,
  ].filter((b): b is string => typeof b === 'string');
}

/**
 * The waivers an approval lists. Fixed is the stronger end state: a maintainer tidying up a verified thread accepted
 * no risk, until it comes back.
 */
const accepted = (waivers: Waiver[], threads: ReviewThread[] | undefined, findings: RecordedFinding[]) => waivers.filter((w) => {
  const t = threads?.find((x) => x.id === w.thread);
  return !t || !isVerified(t) || absorbed(t, findings);
});

/** Titles are the app's own comments, sanitized again; logins are plain names, never mentions. */
const waivedList = (waivers: Waiver[], repo: string) => waivers.length > 0 && `Waived by a maintainer:\n- ${capped(waivers.map((w) => `${
  sanitize(w.title, repo)} (${pathList([w.line === null ? w.path : `${w.path}:${w.line}`], '', 1)}), waived by ${
  w.by.replace(/[^\w-]/g, '')}`), 50).join('\n- ')}`;

/** Findings counted by outcome, for the log. */
function outcomes(findings: { outcome: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.outcome] = (out[f.outcome] ?? 0) + 1;
  return out;
}

function summary(job: Job, count: number, notes: {
  scope: Scope; splitAbove?: number; focuses: RecordedFocus[]; fallbackUsed: boolean; since?: string; approve?: boolean;
  /** Why this run didn't approve, when approvals are on. */
  blockers: string[];
  /** Why an earlier approval by this app may still be in force, when it may. */
  undismissed?: string;
  /** Listed on an approval: the risks it accepted. */
  waivers: Waiver[];
}): string {
  const { scope, focuses } = notes;
  const failed = focuses.filter((f) => f.status === 'failed').map((f) => f.focus);
  return [
    notes.splitAbove !== undefined && `**This PR has ${scope.reviewableLines} reviewable changed lines, over the `
      + `${notes.splitAbove}-line limit. Consider splitting it.** Directories involved: ${
        pathList(scope.directories, ', ', 20).replace('`.`', '(repo root)')}.`,
    `**AI review** of \`head@${job.headSha.slice(0, 7)}\` against \`base@${job.baseSha.slice(0, 7)}\`: `
      + (notes.approve ? 'no issues found, and every earlier comment is resolved or verified fixed. Approved.'
        : count === 0 ? 'no issues to comment on.' : `${count} issue${count === 1 ? '' : 's'}, commented inline.`),
    // Names only: the reasons are PR-influenced, so they stay in the run record.
    focuses.length > 0 && `Reviewed for ${listed(focuses.map((f) => f.focus))}${
      notes.fallbackUsed ? ' (fallback selection: the orchestrator failed)' : ''}.`,
    notes.since && `Focused on changes since \`head@${notes.since.slice(0, 7)}\`, which was already reviewed.`,
    // Focus names only; error detail stays in the run record.
    failed.length > 0 && `Failed focuses: ${failed.join(', ')}. Their findings are missing from this review.`,
    notes.blockers.length > 0 && `**Not approved:** ${notes.blockers.join('; ')}.`,
    notes.undismissed,
    waivedList(notes.waivers, job.repo),
    scope.skipped.length > 0 && `Skipped (over the review budget):\n- ${pathList(scope.skipped, '\n- ', 50)}`,
    scope.binary.length > 0 && `Not reviewed (binary content):\n- ${pathList(scope.binary, '\n- ', 50)}`,
    marker(job),
  ].filter(Boolean).join('\n\n');
}

/** Ends a reply that verified a thread fixed. Only the app's own comments are trusted to carry it. */
const VERIFIED = '<!-- ai-review:verified -->';

/**
 * Whether the thread's last trusted word is the app's verified reply. Only a reply (never the thread's first
 * comment, a finding whose suggestion fence isn't sanitized) that ends with the marker counts: model text is
 * sanitized everywhere else, so nothing PR-influenced can end a reply with it.
 */
function isVerified(t: ReviewThread): boolean {
  const last = t.comments.at(-1);
  return t.comments.length > 1 && !!last?.byApp && last.body.endsWith(`\n\n${VERIFIED}`);
}

// A label re-review and a re-decision repeat a head/base pair on purpose, so their markers also name the run.
const marker = (job: Job) => `<!-- ai-review:${job.repo}#${job.pr}:${job.headSha}:${job.baseSha}${
  job.event === 'pull_request.labeled' || isRedecision(job.event) ? `:run-${job.id}` : ''} -->`;
