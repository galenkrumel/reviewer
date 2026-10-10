import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, openedPayload, ScriptedModel, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';

function prFor(base: Record<string, string>, head: Record<string, string | null>) {
  const fx = gitFixture(base, head);
  const pr = { number: 9, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  return { fx, pr, github };
}

async function review(
  setup: ReturnType<typeof prFor>, model: ScriptedModel, opts: { maxReviewableLines?: number; reviewTokenBudget?: number } = {},
) {
  const { app } = testApp({ model, github: setup.github, ...opts });
  await app.receive(delivery('pull_request', openedPayload(REPO, setup.pr)));
  await app.drain();
  return { app, reviews: setup.github.reviews, diffSent: model.requests[0]?.messages[1]?.content ?? '' };
}

const lines = (n: number, tag = 'x') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};\n`).join('');
const finding = (path: string, line: number) =>
  ({ title: `bad ${path}`, severity: 'high', confidence: 0.9, path, line, evidence: 'wrong' });
const clean = () => new ScriptedModel([toolCall('report_findings', { findings: [] })]);

test('lockfiles, vendored and generated files are excluded from the diff and never commented on', async () => {
  const s = prFor({ 'src/a.ts': 'a\n' }, {
    'src/a.ts': 'a\nb\n',
    'package-lock.json': '{}\n',
    'vendor/lib.js': 'v\n',
    'public/app.min.js': 'm\n',
  });
  const model = new ScriptedModel([toolCall('report_findings', {
    findings: [finding('package-lock.json', 1), finding('vendor/lib.js', 1), finding('public/app.min.js', 1), finding('src/a.ts', 2)],
  })]);
  const { app, reviews, diffSent } = await review(s, model);

  assert.match(diffSent, /src\/a\.ts/);
  assert.doesNotMatch(diffSent, /package-lock|vendor\/lib|app\.min/);
  assert.deepEqual(reviews[0]!.review.comments.map((c) => c.path), ['src/a.ts']);
  assert.equal(app.runs()[0]!.findings.filter((f) => f.outcome === 'unanchorable').length, 3);
});

test('a source file git sees as binary is named in the summary; image assets are not', async () => {
  const s = prFor({ 'README.md': 'hi\n' }, { 'src/sneaky.ts': 'run();\0\n', 'img/logo.png': '\0PNG\n' });
  const model = new ScriptedModel([]);
  const { reviews } = await review(s, model);

  assert.equal(model.requests.length, 0);
  const { body, comments } = reviews[0]!.review;
  assert.equal(comments.length, 0);
  assert.match(body, /binary content[^]*`src\/sneaky\.ts`/);
  assert.ok(!body.includes('logo.png'));
});

test('a clean run whose only other changes are excluded files posts nothing', async () => {
  const s = prFor({ 'src/a.ts': 'a\n' }, { 'src/a.ts': 'a\nb\n', 'yarn.lock': lines(2000) });
  const { app, reviews } = await review(s, clean(), { maxReviewableLines: 10 });

  assert.equal(reviews.length, 0);
  assert.equal(app.runs()[0]!.status, 'nothing_to_publish');
});

test('a PR that only changes excluded files never reaches the model and posts nothing', async () => {
  const s = prFor({ 'README.md': 'hi\n' }, { 'package-lock.json': '{}\n', 'go.sum': 'x\n' });
  const model = new ScriptedModel([]);
  const { app, reviews } = await review(s, model);

  assert.equal(model.requests.length, 0);
  assert.equal(reviews.length, 0);
  assert.equal(app.runs()[0]!.status, 'nothing_to_publish');
});

test('paths marked linguist-generated or linguist-vendored in the base .gitattributes are excluded', async () => {
  const s = prFor(
    { '.gitattributes': 'gen/** linguist-generated\nthird/** linguist-vendored=true\n', 'README.md': 'hi\n' },
    { 'gen/client.ts': 'g\n', 'third/x.ts': 't\n' },
  );
  const model = new ScriptedModel([]);
  const { reviews } = await review(s, model);

  assert.equal(model.requests.length, 0);
  assert.equal(reviews.length, 0);
});

test('a PR that adds a linguist-generated entry does not exclude its own files', async () => {
  const s = prFor({ 'README.md': 'hi\n' }, { '.gitattributes': 'gen/** linguist-generated\n', 'gen/client.ts': 'g\n' });
  const model = new ScriptedModel([toolCall('report_findings', { findings: [finding('gen/client.ts', 1)] })]);
  const { reviews, diffSent } = await review(s, model);

  assert.match(diffSent, /gen\/client\.ts/);
  assert.deepEqual(reviews[0]!.review.comments.map((c) => c.path), ['gen/client.ts']);
});

test('a pure rename does not count toward reviewable lines', async () => {
  const s = prFor({ 'old/big.ts': lines(50), 'src/a.ts': 'a\n' }, { 'old/big.ts': null, 'new/big.ts': lines(50), 'src/a.ts': 'a\nb\n' });
  const { app, reviews } = await review(s, clean(), { maxReviewableLines: 10 });

  assert.equal(reviews.length, 0);
  assert.equal(app.runs()[0]!.status, 'nothing_to_publish');
});

test('a PR above max_reviewable_lines gets a summary that opens with a split recommendation', async () => {
  const s = prFor({ 'README.md': 'hi\n' }, { 'src/api/a.ts': lines(8), 'lib/b.ts': lines(5), 'c.ts': 'c\n' });
  const { app, reviews } = await review(s, clean(), { maxReviewableLines: 10 });

  assert.equal(reviews.length, 1);
  const { body, comments } = reviews[0]!.review;
  assert.equal(comments.length, 0);
  const opening = body.split('\n\n')[0]!;
  assert.match(opening, /split/i);
  assert.match(opening, /14 reviewable changed lines/);
  assert.ok(opening.includes('`src/api`') && opening.includes('`lib`') && opening.includes('(repo root)'), opening);
  assert.ok(body.includes(`<!-- ai-review:${REPO}#9:${s.pr.headSha}:${s.pr.baseSha} -->`));
  assert.equal(app.runs()[0]!.status, 'published');
});

test('when files exceed the token budget, security-sensitive paths go first and the rest are listed as skipped', async () => {
  const s = prFor({ 'README.md': 'hi\n' }, { 'src/auth/login.ts': lines(3), 'src/big.ts': lines(20) });
  const { reviews, diffSent } = await review(s, clean(), { reviewTokenBudget: 100 });

  assert.match(diffSent, /src\/auth\/login\.ts/);
  assert.doesNotMatch(diffSent, /src\/big\.ts/);
  assert.equal(reviews.length, 1);
  const { body, comments } = reviews[0]!.review;
  assert.equal(comments.length, 0);
  assert.match(body, /Skipped[^\n]*\n[^]*`src\/big\.ts`/);
  assert.ok(!body.includes('src/auth/login.ts'));
});

test('a failed focus produces a summary-only review naming it', async () => {
  const s = prFor({ 'src/a.ts': 'a\n' }, { 'src/a.ts': 'a\nb\n' });
  const { app, reviews } = await review(s, new ScriptedModel([])); // runs out of turns: the reviewer throws

  assert.equal(reviews.length, 1);
  const { body, comments } = reviews[0]!.review;
  assert.equal(comments.length, 0);
  assert.match(body, /Failed[^\n]*correctness/i);
  const [run] = app.runs();
  assert.equal(run!.status, 'published');
  assert.match(run!.error ?? '', /ran out of turns/);
});
