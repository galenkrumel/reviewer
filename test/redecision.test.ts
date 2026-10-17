import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/app.ts';
import type { PullRequest } from '../src/ports.ts';
import { delivery, FakeGitHub, gitFixture, noFindings, prPayload, ScriptedModel, select, testApp, toolCall, type Turn } from './harness.ts';

const REPO = 'acme/widgets';
const PATH = 'src/app.ts';
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n';
const f = (line: number) => ({ title: `issue at ${line}`, severity: 'high', confidence: 0.9, path: PATH, line, evidence: `Line ${line} is wrong.` });
const report = (...findings: unknown[]) => toolCall('report_findings', { findings });
const verdict = (resolved: boolean, thread = 0) =>
  toolCall('report_threads', { threads: [{ thread, resolved, reply: resolved ? 'Not a problem.' : 'Still wrong.' }] });

/** A thread-event delivery, as GitHub sends it when someone resolves or unresolves a thread. */
const threadEvent = (action: string, pr: PullRequest, prExtra: Record<string, unknown> = {}) =>
  delivery('pull_request_review_thread', prPayload(action, REPO, pr, { thread: { node_id: 'T0' } }, prExtra));

/** A first run posts a finding at line 5; its thread is then added, as GitHub would. */
async function reviewed(opts: { correctness?: Turn[]; verifier?: Turn[]; config?: Partial<AppConfig> } = {}) {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel({
    orchestrator: [select('correctness')], correctness: opts.correctness ?? [report(f(5))], security: [noFindings()],
    verifier: opts.verifier ?? [],
  });
  const t = testApp({ model, github, config: { approveWhenClean: true, ...opts.config } });
  await t.app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await t.app.drain();
  const thread = github.addThread(REPO, 7, PATH, 5, '**issue at 5**\n\nLine 5 is wrong.');
  const calls = () => model.requests.length;
  return { ...t, fx, pr, model, thread, calls };
}

test('a maintainer resolving a thread re-decides at once: approved, the waiver listed, no reviewer called', async () => {
  const { app, github, pr, thread, calls, logs } = await reviewed();
  assert.equal(github.reviews[0]!.review.event, 'COMMENT');
  const before = calls();

  github.resolveAs(thread.id, 'octo-maint', 'MEMBER');
  const res = await app.receive(threadEvent('resolved', pr));
  assert.equal(res.ignored, undefined);
  await app.drain();

  assert.equal(calls(), before);
  assert.equal(github.reviews.length, 2);
  const { review } = github.reviews[1]!;
  assert.equal(review.event, 'APPROVE');
  assert.equal(review.commit_id, pr.headSha);
  assert.deepEqual(review.comments, []);
  assert.match(review.body, /Waived by a maintainer:\n- issue at 5 \(`src\/app\.ts:5`\), waived by octo-maint/);
  const run = app.runs().at(-1)!;
  assert.equal(run.event, 'pull_request_review_thread.resolved');
  assert.equal(run.status, 'published');
  assert.ok(logs.some((l) => l.msg === 'finding waived' && l.by === 'octo-maint' && l.run === run.id));
});

test('an outsider resolving a thread changes nothing: the re-decision posts nothing', async () => {
  const { app, github, pr, thread } = await reviewed();
  github.resolveAs(thread.id, 'drive-by', 'CONTRIBUTOR');
  await app.receive(threadEvent('resolved', pr));
  await app.drain();
  assert.equal(github.reviews.length, 1);
  assert.equal(app.runs().at(-1)!.status, 'nothing_to_publish');
});

test('unresolving a thread is ignored with a reason', async () => {
  const { app, pr } = await reviewed();
  const res = await app.receive(threadEvent('unresolved', pr));
  assert.match(res.ignored ?? '', /unresolved is not a re-decision trigger/);
  await app.drain();
  assert.equal(app.runs().length, 1);
});

test('a re-decision with no review published at the head is skipped and posts nothing', async () => {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel({});
  const { app } = testApp({ model, github, config: { approveWhenClean: true } });
  await app.receive(threadEvent('resolved', pr));
  await app.drain();
  assert.deepEqual(app.runs().map((r) => r.status), ['skipped']);
  assert.equal(github.reviews.length, 0);
  assert.equal(model.requests.length, 0);

  // A queued re-decision doesn't stand in for the review of its head.
  await app.receive(threadEvent('resolved', pr));
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  assert.deepEqual(app.runs().map((r) => [r.event, r.status]), [
    ['pull_request_review_thread.resolved', 'skipped'], ['pull_request_review_thread.resolved', 'queued'],
    ['pull_request.opened', 'queued'],
  ]);
});

test("a re-decision is skipped when the head's run recorded no decision, as when its review was found already posted", async () => {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  // A review this run posted before a restart: the run finishes on it, with nothing else recorded.
  const marker = `<!-- ai-review:${REPO}#7:${pr.headSha}:${pr.baseSha} -->`;
  await github.createReview('ghs_fake_42', REPO, 7, { commit_id: pr.headSha, event: 'COMMENT', body: marker, comments: [] });
  const thread = github.addThread(REPO, 7, PATH, 5, '**issue at 5**\n\nLine 5 is wrong.');
  const { app } = testApp({ model: new ScriptedModel({}), github, config: { approveWhenClean: true } });
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();
  github.resolveAs(thread.id, 'octo-maint', 'MEMBER');
  await app.receive(threadEvent('resolved', pr));
  await app.drain();
  assert.deepEqual(app.runs().map((r) => r.status), ['published', 'skipped']);
  assert.equal(github.reviews.length, 1);
});

test('with approvals off, a re-decision is skipped: no verdict can change', async () => {
  const { app, github, pr, thread, calls } = await reviewed({ config: { approveWhenClean: false } });
  thread.comments.push({ byApp: false, byPrAuthor: true, association: 'MEMBER', body: 'Not a bug.' });
  const before = calls();
  await app.receive(threadEvent('resolved', pr));
  await app.drain();
  assert.equal(app.runs().at(-1)!.status, 'skipped');
  assert.equal(calls(), before);
  assert.equal(github.reviews.length, 1);
});

test('resolves arriving together queue one re-decision', async () => {
  const { app, github, pr, thread } = await reviewed();
  const other = github.addThread(REPO, 7, PATH, 20, '**issue at 20**\n\nLine 20 is wrong.');
  github.resolveAs(thread.id, 'octo-maint', 'OWNER');
  github.resolveAs(other.id, 'octo-maint', 'OWNER');
  await app.receive(threadEvent('resolved', pr));
  await app.receive(threadEvent('resolved', pr));
  await app.drain();
  assert.equal(app.runs().length, 2);
  assert.equal(github.reviews.at(-1)!.review.event, 'APPROVE');
});

test('the verifier sees only open threads where someone spoke after the app', async () => {
  const { app, github, pr, thread, model } = await reviewed({ verifier: [verdict(true)] });
  github.resolveAs(thread.id, 'octo-maint', 'MEMBER');
  const argued = github.addThread(REPO, 7, PATH, 30, '**issue at 30**\n\nLine 30 is wrong.');
  argued.comments.push({ byApp: false, byPrAuthor: true, association: 'MEMBER', body: 'v30 is meant to be 30.' });
  github.addThread(REPO, 7, PATH, 40, '**issue at 40**\n\nLine 40 is wrong.');
  await app.receive(threadEvent('resolved', pr));
  await app.drain();

  const sent = String(model.requestsFor('verifier')[0]!.messages[1]!.content);
  assert.match(sent, /issue at 30/);
  assert.doesNotMatch(sent, /issue at 40|issue at 5\b/);
  assert.match(argued.comments.at(-1)!.body, /^Resolved: Not a problem\./);
  // The thread at line 40 is still open, so the verdict stays "not approved" and nothing new is posted.
  assert.equal(github.reviews.length, 1);
});

test('a run in flight when a maintainer resolves a thread honours the waiver', async () => {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const thread = github.addThread(REPO, 7, PATH, 5, '**issue at 5**\n\nLine 5 is wrong.');
  thread.comments.push({ byApp: false, byPrAuthor: true, association: 'MEMBER', body: 'We accept this.' });
  let app: ReturnType<typeof testApp>['app'];
  const model = new ScriptedModel({
    orchestrator: [select('correctness')], correctness: [noFindings()], security: [noFindings()],
    // While the verifier works, the maintainer resolves the thread.
    verifier: [async () => {
      github.resolveAs(thread.id, 'octo-maint', 'MEMBER');
      await app.receive(threadEvent('resolved', pr));
      return verdict(false);
    }],
  });
  ({ app } = testApp({ model, github, config: { approveWhenClean: true } }));
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 1);
  assert.equal(github.reviews[0]!.review.event, 'APPROVE');
  assert.match(github.reviews[0]!.review.body, /waived by octo-maint/);
  // The verifier's "still wrong" isn't posted on a waived thread.
  assert.equal(thread.comments.at(-1)!.body, 'We accept this.');
  assert.deepEqual(app.runs().map((r) => r.status), ['published', 'nothing_to_publish']);
});

test('a re-decision that finds a thread reopened withdraws the approval', async () => {
  const { app, github, pr, thread } = await reviewed({ correctness: [noFindings()], verifier: [verdict(false)] });
  // The first run approved: the thread was added after it.
  assert.equal(github.reviews[0]!.review.event, 'APPROVE');
  thread.comments.push({ byApp: false, byPrAuthor: true, association: 'MEMBER', body: 'Is line 5 right?' });
  github.resolveAs(github.addThread(REPO, 7, PATH, 50, 'x').id, 'octo-maint', 'MEMBER');
  await app.receive(threadEvent('resolved', pr));
  await app.drain();

  assert.equal(github.reviews.length, 2);
  const { review } = github.reviews[1]!;
  assert.equal(review.event, 'COMMENT');
  assert.match(review.body, /no longer approved\.\n\n\*\*Not approved:\*\* 1 review thread still open, on `src\/app\.ts`\./);
  assert.equal(github.reviews[0]!.dismissed, 'Not approved: 1 review thread still open, on `src/app.ts`.');
});
