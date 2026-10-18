import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { NewReview } from '../src/ports.ts';
import {
  delivery, FakeGitHub, gitFixture, openedPayload, ScriptedModel, testApp, toolCall,
} from './harness.ts';

const REPO = 'acme/widgets';

function setup(github = new FakeGitHub()) {
  const fx = gitFixture(
    { 'src/math.ts': 'export const one = 1;\nexport const two = 2;\n' },
    { 'src/math.ts': 'export const one = 1;\nexport const two = 3;\n' },
  );
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  github.addPullRequest(REPO, fx.url, pr);
  return { fx, pr, github };
}

const report = (findings: unknown[] = [{
  title: 'two is three', severity: 'high', confidence: 0.9, path: 'src/math.ts', line: 2, evidence: 'Wrong value.',
}]) => toolCall('report_findings', { findings });

/** Log entries for one step, as [level, step]. */
const logged = (logs: Record<string, unknown>[], step: string) =>
  logs.filter((l) => l.step === step).map((l) => [l.level, l.step]);

/** Hands out an unfetchable clone URL for the first `failures` fetches. */
class FlakyClone extends FakeGitHub {
  failures: number;
  constructor(failures: number) { super(); this.failures = failures; }
  override cloneUrl(repo: string) {
    return this.failures-- > 0 ? 'file:///nonexistent/reviewer-test.git' : super.cloneUrl(repo);
  }
}

/** Fails the first `failures` publishes, either before or after GitHub recorded the review. */
class FlakyPublish extends FakeGitHub {
  failures: number;
  lostResponse: boolean;
  constructor(failures: number, lostResponse: boolean) { super(); this.failures = failures; this.lostResponse = lostResponse; }
  override async createReview(token: string, repo: string, number: number, review: NewReview) {
    if (this.failures-- <= 0) return super.createReview(token, repo, number, review);
    if (this.lostResponse) await super.createReview(token, repo, number, review);
    throw new Error('GitHub POST reviews: 502');
  }
}

test('a transient fetch failure is retried with backoff and the review is published once', async () => {
  const { pr, github } = setup(new FlakyClone(2));
  const { app, sleeps, logs } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 1);
  assert.equal(app.runs()[0]!.status, 'published');
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1]! > sleeps[0]!, 'backoff grows');
  assert.deepEqual(logged(logs, 'fetch'), [['warn', 'fetch'], ['warn', 'fetch']]);
});

test('a fetch that keeps failing fails the run, recorded and logged as a fetch failure', async () => {
  const { pr, github } = setup(new FlakyClone(Infinity));
  const { app, sleeps, logs } = testApp({ model: new ScriptedModel([]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const run = app.runs()[0]!;
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /^fetch: /);
  assert.equal(github.reviews.length, 0);
  assert.equal(sleeps.length, 3);
  assert.deepEqual(logged(logs, 'fetch').at(-1), ['error', 'fetch']);
  assert.ok(logs.every((l) => !JSON.stringify(l).includes('ghs_fake')), 'no token in logs');
});

for (const lostResponse of [false, true]) {
  test(`a transient publish failure ${lostResponse ? 'after GitHub recorded the review' : 'before posting'
  } is retried without double-posting`, async () => {
    const { pr, github } = setup(new FlakyPublish(1, lostResponse));
    const { app, sleeps, logs } = testApp({ model: new ScriptedModel([report()]), github });

    await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
    await app.drain();

    assert.equal(github.reviews.length, 1);
    const run = app.runs()[0]!;
    assert.equal(run.status, 'published');
    assert.equal(run.reviewId, github.reviews[0]!.id);
    assert.equal(sleeps.length, 1);
    assert.deepEqual(logged(logs, 'publish'), [['warn', 'publish']]);
  });
}

test('a publish that keeps failing fails the run and keeps its findings and costs', async () => {
  const { pr, github } = setup(new FlakyPublish(Infinity, false));
  const { app, logs } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const run = app.runs()[0]!;
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /^publish: .*502/);
  assert.equal(run.findings.length, 1);
  assert.ok(run.invocations.length > 0);
  assert.deepEqual(logged(logs, 'publish').at(-1), ['error', 'publish']);
});

test('reviewer, invalid-output and orchestrator failures are logged and recorded', async () => {
  const { pr, github } = setup();
  const boom = () => { throw new Error('model down'); };
  const malformed = toolCall('report_findings', { findings: [{ title: 'no fields' }] });
  const model = new ScriptedModel({
    orchestrator: [boom],
    correctness: [boom, boom],
    security: [malformed, malformed],
  });
  const { app, logs } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const run = app.runs()[0]!;
  assert.equal(run.fallbackUsed, true);
  assert.deepEqual(run.focuses.filter((f) => f.status === 'failed').map((f) => f.focus), ['correctness', 'security']);
  assert.deepEqual(logged(logs, 'orchestrator'), [['warn', 'orchestrator']]);
  assert.deepEqual(logged(logs, 'reviewer'), [['warn', 'reviewer'], ['error', 'reviewer']]);
  assert.deepEqual(logged(logs, 'validation'), [['warn', 'validation'], ['error', 'validation']]);
  for (const l of logs) assert.deepEqual([l.run, l.repo, l.pr], [run.id, REPO, 7]);
});

const DAY = 24 * 3600_000;

/** A data dir holding a published run for PR 7 and, never pruned however old, a queued one for PR 8. */
async function aging() {
  const { pr, github } = setup();
  const first = testApp({ model: new ScriptedModel([report()]), github });
  await first.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await first.app.drain();
  await first.app.receive(delivery('pull_request', openedPayload(REPO, { ...pr, number: 8 })));
  const after = (days: number) => new Date(first.clock.time.getTime() + days * DAY);
  const restart = (days: number, retentionDays?: number) =>
    testApp({ model: new ScriptedModel([]), github, dataDir: first.dataDir, time: after(days), config: { retentionDays } });
  return { restart, after, dataDir: first.dataDir };
}

test('startup prunes run records older than the default 90-day retention period', async () => {
  const { restart, dataDir } = await aging();
  const at89 = restart(89);
  assert.deepEqual(at89.app.runs().map((r) => r.pr), [7, 8]);

  assert.deepEqual(restart(91).app.runs().map((r) => r.pr), [8]);
  const db = new DatabaseSync(join(dataDir, 'reviewer.db'));
  for (const table of ['findings', 'focuses', 'invocations', 'orchestrations']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n, 0, table);
  }
  db.close();
});

test('prune() applies the configured retention period at the current time', async () => {
  const { restart, after } = await aging();
  const { app, clock } = restart(91, 100);
  assert.deepEqual(app.runs().map((r) => r.pr), [7, 8]);
  clock.time = after(101);
  app.prune();
  assert.deepEqual(app.runs().map((r) => r.pr), [8]);
});

test('with a concurrency of 2, two queued jobs run at the same time', async () => {
  const { fx, pr, github } = setup();
  github.addPullRequest(REPO, fx.url, { ...pr, number: 8 });
  let inFlight = 0;
  let most = 0;
  const overlapping = async () => {
    most = Math.max(most, ++inFlight);
    for (let i = 0; i < 1000 && inFlight < 2; i++) await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return report([]);
  };
  const { app } = testApp({ model: new ScriptedModel([overlapping, overlapping]), github, config: { workerConcurrency: 2 } });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.receive(delivery('pull_request', openedPayload(REPO, { ...pr, number: 8 })));
  await app.drain();

  assert.equal(most, 2);
  assert.deepEqual(app.runs().map((r) => r.status), ['nothing_to_publish', 'nothing_to_publish']);
});

test('a job enqueued while another runs starts at once when a worker slot is free', async () => {
  const { fx, pr, github } = setup();
  github.addPullRequest(REPO, fx.url, { ...pr, number: 8 });
  let inFlight = 0;
  let most = 0;
  const { app } = testApp({
    model: new ScriptedModel([
      async () => {
        most = Math.max(most, ++inFlight);
        // The second worker found the queue empty and stopped; this delivery must start one again.
        await app.receive(delivery('pull_request', openedPayload(REPO, { ...pr, number: 8 })));
        void app.drain();
        for (let i = 0; i < 1000 && inFlight < 2; i++) await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return report([]);
      },
      async () => {
        most = Math.max(most, ++inFlight);
        inFlight--;
        return report([]);
      },
    ]),
    github,
    config: { workerConcurrency: 2 },
  });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();
  await app.drain();

  assert.equal(most, 2);
  assert.deepEqual(app.runs().map((r) => r.status), ['nothing_to_publish', 'nothing_to_publish']);
});

test('worker concurrency must be a positive integer', () => {
  assert.throws(() => testApp({ model: new ScriptedModel({}), config: { workerConcurrency: 0 } }), /workerConcurrency/);
});


test('every finished run logs its outcome', async () => {
  const { pr, github } = setup();
  const { app, logs } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const run = app.runs()[0]!;
  const finished = logs.filter((l) => l.msg === 'run finished');
  assert.equal(finished.length, 1);
  assert.deepEqual(
    [finished[0]!.level, finished[0]!.run, finished[0]!.repo, finished[0]!.pr, finished[0]!.status, finished[0]!.reviewId],
    ['info', run.id, REPO, 7, 'published', run.reviewId],
  );
  assert.equal(typeof finished[0]!.cost, 'number');
});

test('a run logs each step: what it reviewed, which reviewers ran, what they found and what it decided', async () => {
  const { pr, github } = setup();
  const { app, logs } = testApp({ model: new ScriptedModel([report()]), github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const steps = logs.filter((l) => l.run !== undefined && l.level === 'info');
  assert.deepEqual(steps.map((l) => l.msg),
    [
      'run started', 'scope', 'reviewers picked', 'reviewer finished', 'reviewer finished', 'reviewer finished', 'threads checked',
      'review decided', 'run finished',
    ]);
  assert.ok(steps.every((l) => l.repo === REPO && l.pr === 7));
  const scope = steps.find((l) => l.msg === 'scope')!;
  assert.equal(scope.reviewed, 1);
  const correctness = steps.find((l) => l.msg === 'reviewer finished' && l.focus === 'correctness')!;
  assert.equal(correctness.findings, 1);
  assert.equal(correctness.tokens, 120);
  assert.deepEqual(steps.find((l) => l.msg === 'review decided')!.findings, { published: 1 });
});
