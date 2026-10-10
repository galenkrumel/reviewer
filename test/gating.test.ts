import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/app.ts';
import { delivery, FakeGitHub, gitFixture, prPayload, ScriptedModel, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';
const LABEL = { name: 'ai-review' };
const report = () => toolCall('report_findings', {
  findings: [{ title: 'b', severity: 'high', confidence: 0.9, path: 'a.ts', line: 2, evidence: 'b' }],
});

function setup(config: Partial<AppConfig> = {}, turns = 2) {
  const fx = gitFixture({ 'a.ts': 'a\n' }, { 'a.ts': 'a\nb\n' });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel(Array.from({ length: turns }, report));
  const t = testApp({ model, github, config });
  const send = (action: string, prExtra: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    t.app.receive(delivery('pull_request', prPayload(action, REPO, pr, extra, prExtra)));
  return { fx, pr, send, ...t };
}

const outsider = { author_association: 'CONTRIBUTOR' };
const labelled = { ...outsider, labels: [LABEL] };

test('an outside PR without the label is not reviewed, and applying the label reviews it', async () => {
  const { fx, send, app, github } = setup();
  const res = await send('opened', outsider);
  assert.match(res.ignored ?? '', /label/);
  await app.drain();
  assert.equal(github.reviews.length, 0);

  assert.equal((await send('labeled', labelled, { label: LABEL })).ignored, undefined);
  await app.drain();
  assert.equal(github.reviews.length, 1);
  assert.equal(github.reviews[0]!.review.commit_id, fx.headSha);
  assert.equal(app.runs()[0]!.event, 'pull_request.labeled');
});

test('a labelled outside PR keeps being reviewed on new pushes', async () => {
  const { send } = setup();
  assert.equal((await send('synchronize', labelled)).ignored, undefined);
});

for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
  test(`${association} PRs are reviewed without the label`, async () => {
    const { send, app, github } = setup();
    assert.equal((await send('opened', { author_association: association })).ignored, undefined);
    await app.drain();
    assert.equal(github.reviews.length, 1);
  });
}

test('a missing author_association counts as an outsider', async () => {
  const { send } = setup();
  assert.match((await send('opened', { author_association: undefined })).ignored ?? '', /label/);
});

test('policy always reviews outside PRs without the label', async () => {
  const { send } = setup({ reviewOutsidePrs: 'always' });
  assert.equal((await send('opened', outsider)).ignored, undefined);
});

test('policy never ignores outside PRs even with the label, but still reviews members', async () => {
  const { send } = setup({ reviewOutsidePrs: 'never' });
  assert.ok((await send('labeled', labelled, { label: LABEL })).ignored);
  assert.equal((await send('opened', { author_association: 'MEMBER' })).ignored, undefined);
});

test('the label name is configurable', async () => {
  const { send } = setup({ reviewLabel: 'please-review' });
  const custom = { name: 'please-review' };
  assert.ok((await send('labeled', labelled, { label: LABEL })).ignored);
  assert.equal((await send('labeled', { ...outsider, labels: [custom] }, { label: custom })).ignored, undefined);
});

test('removing and re-applying the label produces a new review of the same head', async () => {
  const { fx, send, app, github } = setup();
  await send('labeled', labelled, { label: LABEL });
  await app.drain();
  assert.ok((await send('unlabeled', outsider, { label: LABEL })).ignored);
  await send('labeled', labelled, { label: LABEL });
  await app.drain();

  assert.equal(github.reviews.length, 2);
  assert.ok(github.reviews.every((r) => r.review.commit_id === fx.headSha));
});

test('labeled events for other labels are ignored', async () => {
  const { send, app } = setup();
  const bug = { name: 'bug' };
  const res = await send('labeled', { labels: [LABEL, bug] }, { label: bug });
  assert.match(res.ignored ?? '', /bug/);
  await app.drain();
  assert.deepEqual(app.runs(), []);
});

test('a labeled draft is still not reviewed', async () => {
  const { send } = setup();
  assert.match((await send('labeled', { ...labelled, draft: true }, { label: LABEL })).ignored ?? '', /draft/);
});

test('the 11th eligible event within 24h is recorded and skipped; one after the window is reviewed', async () => {
  const { pr, app, clock } = setup();
  // Distinct heads so no run is a duplicate of another.
  const push = (i: number) =>
    app.receive(delivery('pull_request', prPayload('synchronize', REPO, { ...pr, headSha: String(i).padStart(40, '0') })));
  const start = clock.time.getTime();
  for (let i = 0; i < 11; i++) {
    clock.time = new Date(start + i * 60_000);
    await push(i);
  }
  // An ineligible event neither counts nor gets recorded.
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr, {}, outsider)));

  // Each new head supersedes the last, but superseded runs still count toward the cap.
  const skipped = app.runs().map((r) => r.status === 'skipped');
  assert.deepEqual(skipped, [...Array(10).fill(false), true]);

  // Still inside the window of the first run: skipped.
  clock.time = new Date(start + 24 * 3600_000 - 1);
  await push(11);
  assert.equal(app.runs().at(-1)!.status, 'skipped');

  // The first run has aged out.
  clock.time = new Date(start + 24 * 3600_000 + 1);
  await push(12);
  assert.equal(app.runs().at(-1)!.status, 'queued');
});

test('the run cap is configurable', async () => {
  const { pr, app } = setup({ runCap: 1 });
  const push = (sha: string) =>
    app.receive(delivery('pull_request', prPayload('synchronize', REPO, { ...pr, headSha: sha.repeat(40) })));
  await push('a');
  await push('b');
  assert.deepEqual(app.runs().map((r) => r.status), ['queued', 'skipped']);
});
