import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, openedPayload, ScriptedModel, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';

function setup() {
  const fx = gitFixture(
    { 'src/math.ts': 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n', 'README.md': 'hi\n' },
    { 'src/math.ts': 'export const one = 1;\nexport const two = 3;\nexport const three = 3;\nexport const four = 5;\n' },
  );
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  return { fx, pr, github };
}

const finding = (line: number, title = 'two is three') => ({
  title,
  severity: 'high',
  confidence: 0.9,
  path: 'src/math.ts',
  line,
  evidence: `The constant on line ${line} has the wrong value.`,
});

test('a non-draft opened PR gets exactly one COMMENT review pinned to the head', async () => {
  const { fx, pr, github } = setup();
  const model = new ScriptedModel([
    toolCall('read_file', { path: 'src/math.ts' }),
    toolCall('report_findings', { findings: [finding(2)] }),
  ]);
  const { app } = testApp({ model, github });

  const res = await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  assert.equal(res.status, 202);
  await app.drain();

  assert.equal(github.reviews.length, 1);
  const { review } = github.reviews[0]!;
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, fx.headSha);
  assert.deepEqual(review.comments.map(({ path, line, side }) => ({ path, line, side })), [
    { path: 'src/math.ts', line: 2, side: 'RIGHT' },
  ]);
  assert.match(review.comments[0]!.body, /two is three/);

  // read_file returned the head revision's content, read from git objects
  const toolResult = model.requests[1]!.messages.at(-1)!;
  assert.equal(toolResult.role, 'tool');
  assert.match(toolResult.content!, /export const four = 5;/);
});

test('a delivery with an invalid or missing signature is rejected and creates no run', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([]), github });

  const forged = delivery('pull_request', openedPayload(REPO, pr), 'wrong-secret');
  assert.equal((await app.receive(forged)).status, 401);
  const unsigned = delivery('pull_request', openedPayload(REPO, pr));
  delete (unsigned.headers as Record<string, string | undefined>)['x-hub-signature-256'];
  assert.equal((await app.receive(unsigned)).status, 401);
  await app.drain();

  assert.deepEqual(app.runs(), []);
  assert.deepEqual(github.tokensMinted, []);
  assert.equal(github.reviews.length, 0);
});

test('a PR on a repo outside the allowlist is ignored', async () => {
  const { pr, github } = setup();
  const { app } = testApp({ model: new ScriptedModel([]), github, allowlist: ['acme/other'] });

  assert.equal((await app.receive(delivery('pull_request', openedPayload(REPO, pr)))).status, 202);
  await app.drain();

  assert.deepEqual(app.runs(), []);
  assert.equal(github.reviews.length, 0);
});

test('a finding on an unchanged line is omitted and recorded as unanchorable', async () => {
  const { pr, github } = setup();
  const model = new ScriptedModel([
    toolCall('report_findings', { findings: [finding(1, 'one is fine actually'), finding(4, 'four is five')] }),
  ]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.deepEqual(github.reviews[0]!.review.comments.map((c) => c.line), [4]);
  assert.deepEqual(app.runs()[0]!.findings.map((f) => [f.line, f.outcome]), [[1, 'unanchorable'], [4, 'published']]);
});

test('when the reviewer reports no findings, no review is created', async () => {
  const { pr, github } = setup();
  const model = new ScriptedModel([toolCall('report_findings', { findings: [] })]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(github.reviews.length, 0);
  assert.equal(app.runs()[0]!.status, 'nothing_to_publish');
});

test('source is read from a bare clone with no working tree', async () => {
  const { pr, github } = setup();
  const model = new ScriptedModel([toolCall('report_findings', { findings: [] })]);
  const { app, dataDir } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  assert.equal(app.runs()[0]!.status, 'nothing_to_publish');
  const clone = join(dataDir, 'repos', 'acme__widgets.git');
  assert.equal(execFileSync('git', ['-C', clone, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim(), 'true');
  const checkedOut = readdirSync(dataDir, { recursive: true }).map(String).filter((p) => p.endsWith('math.ts'));
  assert.deepEqual(checkedOut, []);
});

test('the summary names both revisions, the focus and the hidden marker, without repeating comments', async () => {
  const { fx, pr, github } = setup();
  const model = new ScriptedModel([toolCall('report_findings', { findings: [finding(2)] })]);
  const { app } = testApp({ model, github });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const { body } = github.reviews[0]!.review;
  assert.ok(body.includes(`head@${fx.headSha.slice(0, 7)}`));
  assert.ok(body.includes(`base@${fx.baseSha.slice(0, 7)}`));
  assert.match(body, /correctness/);
  assert.ok(body.includes(`<!-- ai-review:acme/widgets#7:${fx.headSha}:${fx.baseSha} -->`));
  assert.ok(!body.includes('two is three'));
  assert.ok(!body.includes('wrong value'));
});

test('the run record shows the event, revisions, findings with outcomes and publish status', async () => {
  const { fx, pr, github } = setup();
  const model = new ScriptedModel([toolCall('report_findings', { findings: [finding(2)] })]);
  const { app } = testApp({ model, github });

  const d = delivery('pull_request', openedPayload(REPO, pr));
  await app.receive(d);
  await app.drain();

  const [run] = app.runs();
  assert.equal(run!.deliveryId, d.headers['x-github-delivery']);
  assert.equal(run!.event, 'pull_request.opened');
  assert.equal(run!.repo, REPO);
  assert.equal(run!.pr, 7);
  assert.equal(run!.headSha, fx.headSha);
  assert.equal(run!.baseSha, fx.baseSha);
  assert.equal(run!.status, 'published');
  assert.equal(run!.reviewId, github.reviews[0]!.id);
  assert.deepEqual(run!.findings.map((f) => [f.focus, f.title, f.outcome]), [['correctness', 'two is three', 'published']]);
});
