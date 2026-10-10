import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, noFindings, prPayload, ScriptedModel, select, testApp, toolCall } from './harness.ts';
import type { AppConfig } from '../src/app.ts';
import type { AssistantMessage } from '../src/ports.ts';

const REPO = 'acme/widgets';
const PATH = 'src/app.ts';

// Line 1 is unchanged; lines 2..61 are added.
const lines = (n: number, v = 0) => Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1 + v};`).join('\n') + '\n';

function setup() {
  const fx = gitFixture({ [PATH]: 'keep\n' }, { [PATH]: 'keep\n' + lines(60) });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  return { fx, pr, github };
}

const f = (line: number, extra: Record<string, unknown> = {}) => ({
  title: `issue at ${line}`, severity: 'high', confidence: 0.9, path: PATH, line, evidence: `Line ${line} is wrong.`, ...extra,
});
const report = (...findings: unknown[]) => toolCall('report_findings', { findings });

/** One run: the orchestrator picks correctness, security is always on. */
async function run(correctness: AssistantMessage[], security: AssistantMessage[] = [noFindings()], config: Partial<AppConfig> = {}) {
  const { pr, github } = setup();
  const model = new ScriptedModel({ orchestrator: [select('correctness')], correctness, security });
  const { app } = testApp({ model, github, config });
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();
  const comments = github.reviews[0]?.review.comments ?? [];
  const record = app.runs()[0]!;
  return { comments, record, review: github.reviews[0]?.review };
}

const outcomes = (record: { findings: { line: number; outcome: string }[] }) => record.findings.map((x) => [x.line, x.outcome]);

test('findings below the severity or confidence threshold are omitted and recorded as below_threshold', async () => {
  const proposed = [f(2, { severity: 'low' }), f(10, { confidence: 0.69 }), f(20, { severity: 'medium', confidence: 0.7 })];
  const { comments, record } = await run([report(...proposed)]);
  assert.deepEqual(comments.map((c) => c.line), [20]);
  assert.deepEqual(outcomes(record), [[2, 'below_threshold'], [10, 'below_threshold'], [20, 'published']]);

  const relaxed = await run([report(...proposed)], undefined, { minSeverity: 'low', minConfidence: 0.5 });
  assert.deepEqual(relaxed.comments.map((c) => c.line), [2, 10, 20]);
});

test('two reviewers flagging lines within ±3 produce one comment naming both focuses', async () => {
  const { comments, record } = await run(
    [report(f(10, { title: 'off by one', confidence: 0.8 }), f(17, { title: 'separate issue' }))],
    [report(f(13, { title: 'unchecked index', severity: 'critical' }))],
  );
  assert.deepEqual(comments.map((c) => c.line).sort((a, b) => a - b), [13, 17]);
  const merged = comments.find((c) => c.line === 13)!.body;
  assert.match(merged, /unchecked index/);
  assert.match(merged, /security/);
  assert.match(merged, /correctness/);
  assert.ok(!merged.includes('off by one'));
  assert.deepEqual(record.findings.map((x) => [x.focus, x.line, x.outcome]), [
    ['correctness', 10, 'merged'], ['correctness', 17, 'published'], ['security', 13, 'published'],
  ]);
});

test('a finding already posted on an earlier head is not posted again after a push', async () => {
  const { fx, pr, github } = setup();
  const model = new ScriptedModel({
    orchestrator: [select('correctness'), select('correctness')],
    correctness: [
      report(f(5, { title: 'Off-by-one in loop' })),
      report(f(5, { title: 'off by one in loop!' }), f(30, { title: 'new problem' })),
    ],
    security: [noFindings(), noFindings()],
  });
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();

  const pushed = { ...pr, headSha: fx.push({ [PATH]: 'keep\n' + lines(60) + 'const extra = 1;\n' }) };
  github.addPullRequest(REPO, fx.url, pushed);
  await app.receive(delivery('pull_request', prPayload('synchronize', REPO, pushed)));
  await app.drain();

  assert.equal(github.reviews.length, 2);
  assert.deepEqual(github.reviews[1]!.review.comments.map((c) => c.line), [30]);
  assert.deepEqual(outcomes(app.runs()[1]!), [[5, 'duplicate'], [30, 'published']]);
});

test('a finding is posted again when the line of its earlier comment no longer exists', async () => {
  const { fx, pr, github } = setup();
  const model = new ScriptedModel({
    orchestrator: [select('correctness'), select('correctness')],
    correctness: [report(f(30, { title: 'leaky handle' })), report(f(5, { title: 'leaky handle' }))],
    security: [noFindings(), noFindings()],
  });
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.drain();

  const pushed = { ...pr, headSha: fx.push({ [PATH]: 'keep\n' + lines(10) }) };
  github.addPullRequest(REPO, fx.url, pushed);
  await app.receive(delivery('pull_request', prPayload('synchronize', REPO, pushed)));
  await app.drain();

  assert.deepEqual(github.reviews[1]!.review.comments.map((c) => c.line), [5]);
});

test('a review never has more than max_comments comments, keeping the highest ranked', async () => {
  // Lines 2, 7, ..., 57, ranked by confidence: the first two lose.
  const proposed = Array.from({ length: 12 }, (_, i) => f(2 + 5 * i, { confidence: 0.7 + i * 0.02 }));
  const { comments, record, review } = await run([report(...proposed)]);
  assert.equal(comments.length, 10);
  assert.deepEqual(comments.map((c) => c.line).sort((a, b) => a - b), proposed.slice(2).map((x) => x.line));
  assert.deepEqual(record.findings.filter((x) => x.outcome === 'over_cap').map((x) => x.line), [2, 7]);
  assert.match(review!.body, /10 inline comments/);

  const capped = await run([report(...proposed)], undefined, { maxComments: 3 });
  assert.deepEqual(capped.comments.map((c) => c.line).sort((a, b) => a - b), [47, 52, 57]);
});

test('every proposed finding is recorded with exactly one outcome', async () => {
  const { record } = await run(
    [report(f(1), f(10, { severity: 'low' }), f(20), f(40, { confidence: 0.8 }))],
    [report(f(22, { confidence: 0.75 }))],
    { maxComments: 1 },
  );
  assert.deepEqual(record.findings.map((x) => [x.focus, x.line, x.outcome]), [
    ['correctness', 1, 'unanchorable'],
    ['correctness', 10, 'below_threshold'],
    ['correctness', 20, 'published'],
    ['correctness', 40, 'over_cap'],
    ['security', 22, 'merged'],
  ]);
});

test('a suggestion block appears only when the fix covers exactly the anchored lines', async () => {
  const { comments } = await run([report(
    f(5, { suggested_fix: '@Injectable() const v4 = 5;', fix_replaces_anchor: true }),
    f(30, { start_line: 28, suggested_fix: 'a\nb\nc', fix_replaces_anchor: true }),
    f(2, { start_line: 1, suggested_fix: 'const kept = 1;', fix_replaces_anchor: true }),
    f(40, { suggested_fix: 'Use a guard clause.' }),
    f(50, { suggested_fix: 'const s = "```";', fix_replaces_anchor: true }),
  )]);
  const at = (line: number) => comments.find((c) => c.line === line)!;

  assert.ok(at(5).body.includes('```suggestion\n@Injectable() const v4 = 5;\n```'));
  assert.equal(at(5).start_line, undefined);
  assert.ok(at(30).body.includes('```suggestion\na\nb\nc\n```'));
  assert.equal(at(30).start_line, 28);
  assert.equal(at(30).start_side, 'RIGHT');
  // Line 1 is unchanged, so the range can't be anchored: single-line comment, fix as prose.
  assert.equal(at(2).start_line, undefined);
  assert.ok(!at(2).body.includes('suggestion'));
  assert.ok(at(2).body.includes('const kept = 1;'));
  assert.ok(!at(40).body.includes('```suggestion'));
  assert.ok(at(40).body.includes('Use a guard clause.'));
  // A fence in the fix can't close the block early.
  assert.ok(at(50).body.includes('````suggestion\nconst s = "```";\n````'));
  for (const c of comments) assert.ok(!c.body.includes('0.9'), 'confidence is never shown');
});

test('mentions and links outside the repo are sanitized out of comments', async () => {
  const evidence = 'Ping @octocat and @acme/security. See [docs](https://evil.example/phish), https://evil.example/x, '
    + 'www.evil.example/y, ![t](https://evil.example/p.png), <a href="https://evil.example">here</a>, '
    + '[up](https://github.com/acme/widgets/../../evil/repo) and https://github.com/acme/widgets/blob/main/src/app.ts#L3. '
    + 'Entities: &#64;mona [e](https://github.com/acme/widgets/&#46;&#46;/&#46;&#46;/evil/entity). '
    + 'Refs: [a][1] [b][2] [c][3]\n\n[1]: //evil.example/a\n[2]:\n  //evil.example/b\n[3]: javascript:alert(1)\n';
  const { comments } = await run([report(f(5, {
    title: 'Tell @admin', evidence, suggested_fix: 'Read [this](https://github.com/acme/widgets.evil.com/x) first.',
  }))]);
  const body = comments[0]!.body;
  assert.doesNotMatch(body, /@(octocat|acme|admin)/);
  assert.ok(!body.includes('&#64;mona') && !body.includes('&#46;'), body);
  assert.ok(!body.includes('javascript:'), body);
  assert.ok(!body.includes('evil.example'), body);
  assert.ok(!body.includes('widgets.evil.com'), body);
  assert.ok(!body.includes('evil/repo'), body);
  assert.doesNotMatch(body, /<a\s/i);
  assert.ok(body.includes('https://github.com/acme/widgets/blob/main/src/app.ts#L3'));
  assert.ok(body.includes('docs'));
});

test('an off-schema report is rejected and the reviewer retried once', async () => {
  const { comments, record } = await run([report(f(5, { confidence: 1.5 })), report(f(9, { start_line: 12 })), report(f(5))]);
  // Both bad reports fail, so the retry is used up and correctness fails.
  assert.equal(comments.length, 0);
  assert.equal(record.focuses.find((x) => x.focus === 'correctness')!.status, 'failed');

  const retried = await run([report(f(5, { confidence: 1.5 })), report(f(5))]);
  assert.deepEqual(retried.comments.map((c) => c.line), [5]);
});
