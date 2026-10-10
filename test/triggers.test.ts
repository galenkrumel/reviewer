import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, prPayload, ScriptedModel, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';

function setup(draft = false) {
  const fx = gitFixture({ 'a.ts': 'a\n' }, { 'a.ts': 'a\nb\n' });
  const pr = { number: 7, state: 'open' as const, draft, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel([
    toolCall('report_findings', {
      findings: [{ title: 'b', severity: 'low', confidence: 0.9, path: 'a.ts', line: 2, evidence: 'b' }],
    }),
  ]);
  return { fx, pr, ...testApp({ model, github }) };
}

for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
  test(`non-draft ${action} reviews the payload head`, async () => {
    const { fx, pr, app, github } = setup();
    const res = await app.receive(delivery('pull_request', prPayload(action, REPO, pr)));
    assert.equal(res.ignored, undefined);
    await app.drain();

    assert.equal(github.reviews.length, 1);
    assert.equal(github.reviews[0]!.review.commit_id, fx.headSha);
    assert.equal(app.runs()[0]!.event, `pull_request.${action}`);
  });
}

for (const action of ['opened', 'reopened', 'synchronize']) {
  test(`draft ${action} is ignored with a reason`, async () => {
    const { pr, app, github } = setup(true);
    const res = await app.receive(delivery('pull_request', prPayload(action, REPO, pr)));
    assert.equal(res.status, 202);
    assert.match(res.ignored ?? '', /draft/);
    await app.drain();

    assert.deepEqual(app.runs(), []);
    assert.equal(github.reviews.length, 0);
  });
}

test('edited with a base change reviews against the new base from pull_request.base', async () => {
  const { fx, pr, app, github } = setup();
  // changes.base carries the old values; the new base is pull_request.base.
  const changes = { base: { ref: { from: 'old' }, sha: { from: 'deadbeef'.repeat(5) } } };
  const res = await app.receive(delivery('pull_request', prPayload('edited', REPO, pr, { changes })));
  assert.equal(res.ignored, undefined);
  await app.drain();

  assert.equal(app.runs()[0]!.baseSha, fx.baseSha);
  assert.ok(github.reviews[0]!.review.body.includes(`:${fx.headSha}:${fx.baseSha} -->`));
});

test('edited without a base change is ignored with a reason', async () => {
  const { pr, app } = setup();
  const changes = { title: { from: 'old title' } };
  const res = await app.receive(delivery('pull_request', prPayload('edited', REPO, pr, { changes })));
  assert.match(res.ignored ?? '', /base/);
  await app.drain();
  assert.deepEqual(app.runs(), []);
});

test('a base change on a draft is still ignored', async () => {
  const { pr, app } = setup(true);
  const changes = { base: { ref: { from: 'old' } } };
  const res = await app.receive(delivery('pull_request', prPayload('edited', REPO, pr, { changes })));
  assert.match(res.ignored ?? '', /draft/);
  await app.drain();
  assert.deepEqual(app.runs(), []);
});

test('other actions and other events are ignored with a reason', async () => {
  const { pr, app } = setup();
  const cases = [['pull_request', 'labeled'], ['pull_request', 'closed'],
    ['pull_request', 'converted_to_draft'], ['issues', 'opened']] as const;
  for (const [event, action] of cases) {
    const res = await app.receive(delivery(event, prPayload(action, REPO, pr)));
    assert.equal(res.status, 202);
    assert.ok(res.ignored, `${event}.${action} should carry a reason`);
  }
  await app.drain();
  assert.deepEqual(app.runs(), []);
});

test('a repo outside the allowlist is ignored with a reason', async () => {
  const { pr, app } = setup();
  const res = await app.receive(delivery('pull_request', prPayload('opened', 'acme/other', pr)));
  assert.match(res.ignored ?? '', /allowlist/);
});
