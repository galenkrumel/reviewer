import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, noFindings, prPayload, ScriptedModel, select, testApp, toolCall, type Turn } from './harness.ts';

const REPO = 'acme/widgets';
const PATH = 'src/app.ts';
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n';
const f = (line: number) => ({ title: `issue at ${line}`, severity: 'high', confidence: 0.9, path: PATH, line, evidence: `Line ${line} is wrong.` });
const report = (...findings: unknown[]) => toolCall('report_findings', { findings });
const stillOpen = (thread = 0) => toolCall('report_threads', { threads: [{ thread, resolved: false, reply: 'Still wrong.' }] });

/** A comment on the PR's conversation, as GitHub sends it. */
const comment = (body: string, association = 'MEMBER', number = 7) => delivery('issue_comment', {
  action: 'created', installation: { id: 42 }, repository: { full_name: REPO },
  issue: {
    number, title: 'Change things', body: 'Please review', author_association: 'MEMBER', labels: [],
    pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
  },
  comment: { body, author_association: association, user: { login: 'octo-maint' } },
});

/**
 * A first run where correctness posts a finding at line 5 and performance fails twice (no turn scripted); its thread is
 * then added, as GitHub would. `perf` is the performance reviewer's script, to fill before a retry.
 */
async function failedRun(opts: { perf?: Turn[] } = {}) {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const perf: Turn[] = opts.perf ?? [];
  const verifier: Turn[] = [];
  const model = new ScriptedModel({
    orchestrator: [select('correctness', 'performance')], correctness: [report(f(5))], security: [noFindings()], performance: perf, verifier,
  });
  const t = testApp({ model, github, config: { approveWhenClean: true, adminPassword: 'pw' } });
  await t.app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await t.app.drain();
  github.addThread(REPO, 7, PATH, 5, '**issue at 5**\n\nLine 5 is wrong.');
  return { ...t, pr, model, perf, verifier };
}

const page = (app: ReturnType<typeof testApp>['app'], url: string) => String(app.dashboard({
  method: 'GET', url, headers: { authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` },
})!.body);

test('a maintainer\'s "Retry" runs only the failed focus, reuses the others\' findings and posts nothing twice', async () => {
  const { app, github, model, perf, verifier } = await failedRun();
  const first = github.reviews[0]!.review;
  assert.equal(first.comments.length, 1);
  assert.match(first.body, /the performance review failed/);
  const firstRun = app.runs()[0]!;
  const before = model.requests.length;

  perf.push(report(f(30)));
  verifier.push(stillOpen());
  const res = await app.receive(comment(' retry '));
  assert.equal(res.ignored, undefined);
  await app.drain();

  // Only the failed focus ran again, plus the verifier on the open thread; no orchestrator.
  assert.deepEqual([...new Set(model.requests.slice(before).map((r) => /^You are the (\w+)/.exec(r.messages[0]!.content as string)?.[1]))],
    ['performance', 'verifier']);
  assert.equal(github.reviews.length, 2);
  const { review } = github.reviews[1]!;
  // The line 5 finding is already a thread: only performance's is commented on.
  assert.deepEqual(review.comments.map((c) => c.line), [30]);
  assert.doesNotMatch(review.body, /failed/);
  assert.match(review.body, /Reviewed for correctness, security, documentation and performance\./);
  assert.match(review.body, /Retried performance; the findings of the other focuses are from the earlier review of this head\./);
  assert.equal(review.event, 'COMMENT');

  const run = app.runs().at(-1)!;
  assert.equal(run.event, 'pull_request.retry');
  assert.equal(run.status, 'published');
  assert.deepEqual(run.focuses.map((x) => [x.focus, x.status, x.reusedFrom]), [
    ['correctness', 'succeeded', firstRun.id], ['security', 'succeeded', firstRun.id],
    ['documentation', 'succeeded', firstRun.id], ['performance', 'succeeded', undefined],
  ]);
  assert.deepEqual(run.findings.map((x) => [x.line, x.focus, x.outcome]), [[30, 'performance', 'published'], [5, 'correctness', 'published']]);

  // The dashboard says it was a retry, and which focuses it reused.
  const detail = page(app, `/admin/runs/${run.id}`);
  assert.match(detail, /&#34;Retry&#34; comment/);
  assert.match(detail, new RegExp(`correctness</td><td>succeeded, reused from run <a class="ref" href="/admin/runs/${firstRun.id}">`));
  assert.match(detail, /performance<\/td><td>succeeded<\/td>/);
  assert.match(page(app, '/admin/runs'), /correctness \(reused\)/);
});

test('a retry that fails again can be retried, still reusing the first run\'s findings', async () => {
  const { app, github, model, perf, verifier } = await failedRun();
  const firstRun = app.runs()[0]!;
  verifier.push(stillOpen());
  await app.receive(comment('Retry'));
  await app.drain();
  assert.match(github.reviews[1]!.review.body, /the performance review failed/);
  assert.deepEqual(github.reviews[1]!.review.comments, []);

  const before = model.requests.length;
  perf.push(noFindings());
  verifier.push(stillOpen());
  await app.receive(comment('Retry'));
  await app.drain();
  assert.equal(github.reviews.length, 3);
  assert.doesNotMatch(github.reviews[2]!.review.body, /failed/);
  assert.deepEqual(github.reviews[2]!.review.comments, []);
  assert.ok(model.requests.slice(before).every((r) => /^You are the (performance|verifier)/.test(r.messages[0]!.content as string)));
  const run = app.runs().at(-1)!;
  assert.equal(run.focuses.find((x) => x.focus === 'correctness')!.reusedFrom, firstRun.id);
  assert.ok(run.findings.some((x) => x.line === 5 && x.outcome === 'published'));
});

test('a retry when nothing failed is recorded skipped and posts nothing', async () => {
  const { app, github, model } = await failedRun({ perf: [noFindings()] });
  const before = model.requests.length;
  await app.receive(comment('Retry'));
  await app.drain();
  assert.equal(model.requests.length, before);
  assert.equal(github.reviews.length, 1);
  const run = app.runs().at(-1)!;
  assert.equal(run.event, 'pull_request.retry');
  assert.equal(run.status, 'skipped');
});

test('"Retry" from someone who isn\'t a maintainer, any other comment, or on a PR never reviewed is ignored', async () => {
  const { app } = await failedRun();
  const runs = app.runs().length;
  assert.match((await app.receive(comment('Retry', 'CONTRIBUTOR'))).ignored!, /maintainer/);
  assert.match((await app.receive(comment('Please retry this'))).ignored!, /Retry/);
  assert.match((await app.receive(comment('Retry', 'MEMBER', 8))).ignored!, /no review/);
  assert.equal(app.runs().length, runs);
});

test('"Retry" while the latest run is still queued is ignored, however that run ends', async () => {
  const { app, pr } = await failedRun();
  const runs = app.runs().length;
  await app.receive(delivery('pull_request', prPayload('labeled', REPO, pr, { label: { name: 'ai-review' } })));
  assert.match((await app.receive(comment('Retry'))).ignored!, /still in progress/);
  assert.equal(app.runs().length, runs + 1);
});

test('the Dependency check\'s finding is posted once however many retries follow', async () => {
  const lock = (v: string) => JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'app' }, 'node_modules/dompurify': { version: v, resolved: `https://registry.npmjs.org/dompurify/-/dompurify-${v}.tgz`, integrity: `sha512-${v}` },
  } }, null, 2) + '\n';
  const fx = gitFixture({ [PATH]: 'keep\n', 'package-lock.json': lock('3.4.10') }, { [PATH]: 'keep\n' + lines(10), 'package-lock.json': lock('3.4.16') });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  github.advisoryDb.push({ id: 'GHSA-mrv2-3pqr-j5jr', severity: 'high', summary: 'XSS', withdrawn: false, package: 'dompurify', versions: ['3.4.16'] });
  // Performance never answers.
  const model = new ScriptedModel({ orchestrator: [select('correctness', 'performance')], correctness: [noFindings()], security: [noFindings()] });
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();
  assert.deepEqual(github.reviews[0]!.review.comments.map((c) => c.path), ['package-lock.json']);
  for (const _ of [1, 2]) {
    await app.receive(comment('Retry'));
    await app.drain();
  }
  assert.equal(github.reviews.length, 3);
  assert.deepEqual(github.reviews.slice(1).map((r) => r.review.comments), [[], []]);
});

test('a retry of a run that failed outright runs every focus again, since its findings may never have been posted', async () => {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel({
    orchestrator: [select('correctness'), select('correctness')], correctness: [report(f(5)), report(f(5))],
    security: [noFindings(), noFindings()],
  });
  const { app } = testApp({ model, github });
  const createReview = github.createReview.bind(github);
  github.createReview = async () => { throw new Error('GitHub POST reviews: 502'); };
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();
  assert.equal(app.runs()[0]!.status, 'failed');

  github.createReview = createReview;
  await app.receive(comment('Retry'));
  await app.drain();
  assert.equal(model.requestsFor('orchestrator').length, 2);
  assert.equal(model.requestsFor('correctness').length, 2);
  assert.deepEqual(github.reviews.map((r) => r.review.comments.map((c) => c.line)), [[5]]);
  assert.equal(app.runs().at(-1)!.status, 'published');
});
