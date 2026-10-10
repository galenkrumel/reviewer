import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewReview } from '../src/ports.ts';
import { delivery, FakeGitHub, gitFixture, openedPayload, prPayload, ScriptedModel, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';

function setup(github = new FakeGitHub()) {
  const fx = gitFixture(
    { 'src/math.ts': 'export const one = 1;\nexport const two = 2;\n' },
    { 'src/math.ts': 'export const one = 1;\nexport const two = 3;\n' },
  );
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  github.addPullRequest(REPO, fx.url, pr);
  const marker = `<!-- ai-review:${REPO}#7:${fx.headSha}:${fx.baseSha} -->`;
  return { fx, pr, github, marker, live: () => github.prs.get(`${REPO}#7`)! };
}

const report = (findings = [{
  title: 'two is three', severity: 'high', confidence: 0.9, path: 'src/math.ts', line: 2, evidence: 'Wrong value.',
}]) => toolCall('report_findings', { findings });

async function until(cond: () => boolean) {
  while (!cond()) await new Promise((r) => setImmediate(r));
}

test('delivering the same event twice produces one run and one review', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([report()]), github });
  const d = delivery('pull_request', openedPayload(REPO, pr));

  await app.receive(d);
  await app.receive(d);
  await app.drain();
  await app.receive(d);
  await app.drain();

  assert.equal(app.runs().length, 1);
  assert.equal(github.reviews.length, 1);
});

test('a run whose review already carries the marker posts nothing and is recorded as published', async () => {
  const { pr, github, marker } = setup();
  const existing = await github.createReview('ghs_fake_42', REPO, 7, {
    commit_id: pr.headSha, event: 'COMMENT', body: `earlier\n\n${marker}`, comments: [],
  });
  const { app } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 1);
  assert.equal(app.runs()[0]!.status, 'published');
  assert.equal(app.runs()[0]!.reviewId, existing.id);
});

test('a marker in a review by someone else does not stop publishing', async () => {
  const { pr, github, marker } = setup();
  github.reviews.push({
    repo: REPO, number: 7, id: 99, foreign: true,
    review: { commit_id: pr.headSha, event: 'COMMENT', body: marker, comments: [] },
  });
  const { app } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 2);
  assert.equal(app.runs()[0]!.reviewId, github.reviews[1]!.id);
});

test('a head change mid-run publishes nothing and the run is recorded stale', async () => {
  const { pr, github, live } = setup();
  const model = new ScriptedModel([() => ((live().headSha = 'f'.repeat(40)), report())]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 0);
  assert.equal(app.runs()[0]!.status, 'stale');
});

test('a base change mid-run publishes nothing', async () => {
  const { pr, github, live } = setup();
  const model = new ScriptedModel([() => ((live().baseSha = 'e'.repeat(40)), report())]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 0);
  assert.equal(app.runs()[0]!.status, 'stale');
});

for (const action of ['converted_to_draft', 'closed'] as const) {
  test(`${action} arriving mid-run supersedes the run and nothing is published`, async () => {
    const { pr, github, live } = setup();
    const moved = action === 'closed' ? { ...pr, state: 'closed' as const } : { ...pr, draft: true };
    const model = new ScriptedModel([async () => {
      Object.assign(live(), moved);
      await app.receive(delivery('pull_request', prPayload(action, REPO, moved)));
      return report();
    }]);
    const { app } = testApp({ model, github });

    await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
    await app.drain();

    assert.equal(github.reviews.length, 0);
    assert.equal(app.runs()[0]!.status, 'superseded');
  });
}

test('a run that fails after being superseded stays superseded', async () => {
  const { pr, github } = setup();
  const model = new ScriptedModel([async () => {
    await app.receive(delivery('pull_request', prPayload('closed', REPO, pr)));
    throw new Error('model down');
  }]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(app.runs()[0]!.status, 'superseded');
});

test('enqueuing a job for a new head supersedes the running job for the old one', async () => {
  const { fx, pr, github, live } = setup();
  const pushed = { ...pr, headSha: fx.baseSha };
  const model = new ScriptedModel([
    async () => {
      Object.assign(live(), pushed);
      await app.receive(delivery('pull_request', openedPayload(REPO, pushed)));
      return report();
    },
    report([]),
  ]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 0);
  assert.deepEqual(app.runs().map((r) => [r.headSha, r.status]), [
    [fx.headSha, 'superseded'], [fx.baseSha, 'nothing_to_publish'],
  ]);
});

// A is an older head: a real commit, or one force-pushed away that can no longer be fetched.
for (const [kind, older] of [['fetchable', 'base'], ['unfetchable', 'a'.repeat(40)]] as const) {
  test(`a late synchronize for an older ${kind} head does not cancel the review of the current head`, async () => {
    const { fx, pr, github } = setup();
    const a = { ...pr, headSha: older === 'base' ? fx.baseSha : older };
    const { app } = testApp({ model: new ScriptedModel([report()]), github });

    await app.receive(delivery('pull_request', prPayload('synchronize', REPO, pr)));
    await app.receive(delivery('pull_request', prPayload('synchronize', REPO, a)));
    await app.drain();

    assert.equal(github.reviews.length, 1);
    assert.equal(github.reviews[0]!.review.commit_id, fx.headSha);
    assert.deepEqual(app.runs().map((r) => [r.headSha, r.status]), [
      [fx.headSha, 'superseded'], [a.headSha, 'stale'], [fx.headSha, 'published'],
    ]);
  });
}

test('synchronize for A then B, delivered in order, reviews only B', async () => {
  const { fx, pr, github } = setup();
  const a = { ...pr, headSha: fx.baseSha };
  const { app } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', prPayload('synchronize', REPO, a)));
  await app.receive(delivery('pull_request', prPayload('synchronize', REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 1);
  assert.equal(github.reviews[0]!.review.commit_id, fx.headSha);
  assert.deepEqual(app.runs().map((r) => [r.headSha, r.status]), [[fx.baseSha, 'superseded'], [fx.headSha, 'published']]);
});

/** Records the review, then never answers: the process "dies" mid-publish. */
class CrashOnPublish extends FakeGitHub {
  crashed = false;
  override async createReview(token: string, repo: string, number: number, review: NewReview) {
    const r = await super.createReview(token, repo, number, review);
    if (this.crashed) return r;
    this.crashed = true;
    return new Promise<never>(() => {});
  }
}

test('after a restart the running job is re-queued and completes without double-posting', async () => {
  const { pr, github } = setup(new CrashOnPublish());
  const first = testApp({ model: new ScriptedModel([report()]), github });
  await first.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  void first.app.drain();
  await until(() => github.reviews.length === 1);
  assert.equal(first.app.runs()[0]!.status, 'running');

  const { app } = testApp({ model: new ScriptedModel([]), github, dataDir: first.dataDir });
  await app.drain();

  assert.equal(github.reviews.length, 1);
  assert.equal(app.runs()[0]!.status, 'published');
  assert.equal(app.runs()[0]!.reviewId, github.reviews[0]!.id);
});
