import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, noFindings, prPayload, ScriptedModel, testApp } from './harness.ts';

const REPO = 'acme/widgets';
const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

test('recovery redelivers what the service never answered, oldest first, and logs each', async () => {
  const github = new FakeGitHub();
  github.deliveries = [
    // Newest first, as GitHub lists them; one entry per attempt.
    { id: 9, guid: 'answered-later', deliveredAt: ago(5), statusCode: 202, event: 'pull_request', redelivery: false },
    { id: 8, guid: 'down-2', deliveredAt: ago(10), statusCode: 502, event: 'pull_request_review_thread', redelivery: false },
    { id: 7, guid: 'answered-later', deliveredAt: ago(15), statusCode: 0, event: 'pull_request', redelivery: false },
    { id: 6, guid: 'down-1', deliveredAt: ago(20), statusCode: 0, event: 'pull_request', redelivery: false },
    { id: 5, guid: 'rejected', deliveredAt: ago(25), statusCode: 401, event: 'pull_request', redelivery: false },
    { id: 4, guid: 'gave-up', deliveredAt: ago(30), statusCode: 503, event: 'pull_request', redelivery: false },
    { id: 3, guid: 'gave-up', deliveredAt: ago(35), statusCode: 503, event: 'pull_request', redelivery: false },
    { id: 2, guid: 'gave-up', deliveredAt: ago(40), statusCode: 503, event: 'pull_request', redelivery: false },
    { id: 1, guid: 'too-old', deliveredAt: ago(7 * 60), statusCode: 0, event: 'pull_request', redelivery: false },
  ];
  const { app, logs } = testApp({ model: new ScriptedModel([]), github, time: NOW });

  await app.recoverDeliveries();

  assert.deepEqual(github.redelivered, [6, 8]);
  assert.deepEqual(logs.filter((l) => l.msg === 'redelivered').map((l) => [l.delivery, l.event, l.status]), [
    ['down-1', 'pull_request', 0], ['down-2', 'pull_request_review_thread', 502],
  ]);
});

test("a delivery older than the window stays out of it, though a recent redelivery of it failed too", async () => {
  const github = new FakeGitHub();
  github.deliveries = [
    { id: 2, guid: 'old', deliveredAt: ago(30), statusCode: 502, event: 'pull_request', redelivery: false },
    { id: 1, guid: 'old', deliveredAt: ago(7 * 60), statusCode: 0, event: 'pull_request', redelivery: false },
  ];
  const { app } = testApp({ model: new ScriptedModel([]), github, time: NOW });

  await app.recoverDeliveries();

  assert.deepEqual(github.redelivered, []);
});

test("a delivery whose first attempt is past the listing, behind a recent failed redelivery, is not redelivered", async () => {
  const github = new FakeGitHub();
  // Paging stopped before the first attempt: only GitHub's redelivery flag shows it was older.
  github.deliveries = [{ id: 2, guid: 'old', deliveredAt: ago(30), statusCode: 502, event: 'pull_request', redelivery: true }];
  const { app } = testApp({ model: new ScriptedModel([]), github, time: NOW });

  await app.recoverDeliveries();

  assert.deepEqual(github.redelivered, []);
});

test('a redelivery that fails is logged and the rest still go', async () => {
  const github = new FakeGitHub();
  github.deliveries = [
    { id: 2, guid: 'b', deliveredAt: ago(5), statusCode: 0, event: 'pull_request', redelivery: false },
    { id: 1, guid: 'a', deliveredAt: ago(10), statusCode: 0, event: 'pull_request', redelivery: false },
  ];
  github.redeliverRefused = new Set([1]);
  const { app, logs } = testApp({ model: new ScriptedModel([]), github, time: NOW });

  await app.recoverDeliveries();

  assert.deepEqual(github.redelivered, [1, 2]);
  assert.deepEqual(logs.filter((l) => /^redeliver/.test(String(l.msg))).map((l) => [l.level, l.msg, l.delivery]), [
    ['warn', 'redelivery failed', 'a'], ['info', 'redelivered', 'b'],
  ]);
});

function setup() {
  const fx = gitFixture({ 'a.ts': 'export const a = 1;\n' }, { 'a.ts': 'export const a = 2;\n' });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  return { pr, github };
}

test('a delivery received before, redelivered with its GUID, starts no second run', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([noFindings()]), github });
  // A label re-review is never a duplicate by SHAs, so only the GUID stops a second full review.
  const labeled = delivery('pull_request', prPayload('labeled', REPO, pr, { label: { name: 'ai-review' } }));

  assert.equal((await app.receive(labeled)).status, 202);
  assert.deepEqual(await app.receive(labeled), { status: 202, ignored: 'delivery already received' });
  await app.drain();

  assert.deepEqual(app.runs().map((r) => r.event), ['pull_request.labeled']);
});

test('a captured delivery replayed under a fresh GUID starts no second run', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([noFindings()]), github });
  const labeled = delivery('pull_request', prPayload('labeled', REPO, pr, { label: { name: 'ai-review' } }));
  // The signature covers only the body, so the replay still verifies.
  const replay = { ...labeled, headers: { ...labeled.headers, 'x-github-delivery': 'forged' } };

  assert.equal((await app.receive(labeled)).status, 202);
  assert.deepEqual(await app.receive(replay), { status: 202, ignored: 'delivery already received' });
  await app.drain();

  assert.deepEqual(app.runs().map((r) => r.event), ['pull_request.labeled']);
});

test('a close and reopen redelivered in reverse order still gets the PR reviewed', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([noFindings()]), github });

  await app.receive(delivery('pull_request', prPayload('reopened', REPO, pr, {}, { updated_at: '2026-01-01T00:02:00Z' })));
  await app.receive(delivery('pull_request', prPayload('closed', REPO, pr, {}, { state: 'closed', updated_at: '2026-01-01T00:01:00Z' })));
  await app.drain();

  // Reviewed (a clean one posts nothing), not cancelled by the older close.
  assert.deepEqual(app.runs().map((r) => r.status), ['nothing_to_publish']);
});

test('a close with the same timestamp as the reopen it arrived after cancels nothing', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([noFindings()]), github });
  const at = { updated_at: '2026-01-01T00:01:00Z' };

  await app.receive(delivery('pull_request', prPayload('reopened', REPO, pr, {}, at)));
  await app.receive(delivery('pull_request', prPayload('closed', REPO, pr, {}, { ...at, state: 'closed' })));
  await app.drain();

  assert.deepEqual(app.runs().map((r) => r.status), ['nothing_to_publish']);
});
