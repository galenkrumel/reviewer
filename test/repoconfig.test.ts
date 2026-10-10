import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRepoConfig } from '../src/repoconfig.ts';
import { delivery, FakeGitHub, gitFixture, noFindings, openedPayload, ScriptedModel, select, testApp, type Turn } from './harness.ts';

const REPO = 'acme/widgets';
const CONFIG = '.github/ai-review.yml';
const CODE = { 'src/math.ts': 'export const two = 2;\n' };
const CHANGED = { 'src/math.ts': 'export const two = 3;\n' };
const quiet = () => ({
  correctness: [noFindings()], security: [noFindings()], performance: [noFindings()],
  architecture: [noFindings()], conciseness: [noFindings()],
});

async function review(
  base: Record<string, string | { symlink: string }>, head: Record<string, string | null>,
  turns: Record<string, Turn[]> = { orchestrator: [select('performance', 'architecture')], ...quiet() },
) {
  const fx = gitFixture(base, head);
  const pr = { number: 3, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel(turns);
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();
  return { model, run: app.runs()[0]!, reviewers: model.agents().filter((a) => a !== 'orchestrator') };
}

test('config at the base SHA applies: a disabled focus does not run and takes no reviewer slot', async () => {
  const { reviewers, run } = await review({ ...CODE, [CONFIG]: 'disable_focuses: [performance]\n' }, CHANGED);

  assert.deepEqual(reviewers, ['correctness', 'security', 'architecture']);
  assert.deepEqual(run.configWarnings, []);
});

test('a PR that edits .github/ai-review.yml does not change its own review', async () => {
  const { reviewers, run } = await review(
    { ...CODE, [CONFIG]: 'disable_focuses: [performance]\n' },
    { ...CHANGED, [CONFIG]: 'disable_focuses: []\nmax_reviewers: 2\n' },
  );

  assert.deepEqual(reviewers, ['correctness', 'security', 'architecture']);
  assert.deepEqual(run.configWarnings, []);
});

test('disabling an always-on focus, lowering a threshold, raising a cap or setting a model is ignored with a warning', async () => {
  const config = `
disable_focuses: [correctness, security, performance]
thresholds:
  severity: low
  confidence: 0.5
max_reviewers: 5
max_comments: 50
max_reviewable_lines: 5000
model: openai/gpt-5
review_outside_prs: always
`;
  const { reviewers, run } = await review({ ...CODE, [CONFIG]: config }, CHANGED,
    { orchestrator: [select('performance', 'architecture', 'conciseness')], ...quiet() });

  assert.deepEqual(reviewers, ['correctness', 'security', 'architecture']);
  assert.equal(run.status, 'nothing_to_publish');
  const w = run.configWarnings;
  for (const pattern of [/correctness.*cannot be disabled/, /security.*cannot be disabled/, /severity/, /confidence/,
    /max_reviewers/, /max_comments/, /max_reviewable_lines/, /"model"/, /"review_outside_prs"/]) {
    assert.ok(w.some((x) => pattern.test(x)), `${pattern} in ${JSON.stringify(w)}`);
  }
  assert.equal(w.length, 9);
});

test('malformed YAML is ignored with a warning and the review proceeds with defaults', async () => {
  const { reviewers, run } = await review({ ...CODE, [CONFIG]: 'disable_focuses: [performance\nmax_reviewers: {2}\n' }, CHANGED);

  assert.deepEqual(reviewers, ['correctness', 'security', 'performance']);
  assert.equal(run.configWarnings.length, 1);
  assert.match(run.configWarnings[0]!, /malformed/);
});

test('a symlinked config is ignored with a warning', async () => {
  const { reviewers, run } = await review({ ...CODE, 'other.yml': 'disable_focuses: [performance]\n', [CONFIG]: { symlink: '../other.yml' } }, CHANGED);

  assert.deepEqual(reviewers, ['correctness', 'security', 'performance']);
  assert.match(run.configWarnings.join(), /symlink/);
});

test('repo exclusions add to the built-in exclusions', async () => {
  const { model } = await review(
    { ...CODE, [CONFIG]: 'exclude:\n  - "legacy/**"  # old code\n' },
    { ...CHANGED, 'legacy/old.ts': 'x\n', 'yarn.lock': 'a@2\n' },
    { orchestrator: [select('correctness')], ...quiet() },
  );

  const diff = model.requestsFor('correctness')[0]!.messages[1]!.content!;
  assert.match(diff, /src\/math\.ts/);
  assert.doesNotMatch(diff, /legacy\/old\.ts|yarn\.lock/);
});

test('path hints for changed paths reach the orchestrator as untrusted data', async () => {
  const { model } = await review(
    { ...CODE, [CONFIG]: 'path_hints:\n  "src/**": money math, check rounding\n  docs/**: prose only\n' }, CHANGED);

  const content = model.requestsFor('orchestrator')[0]!.messages[1]!.content!;
  assert.match(content, /<untrusted-data name="repo-path-hints">\nsrc\/\*\*: money math, check rounding\n<\/untrusted-data>/);
  assert.doesNotMatch(content, /prose only/);
});

const DEFAULTS = { minSeverity: 'medium', minConfidence: 0.7, maxReviewers: 3, maxComments: 10, maxReviewableLines: 800 } as const;

test('the YAML subset: comments, quotes, block and flow lists, maps, document marker, CRLF', () => {
  const { settings, warnings } = parseRepoConfig([
    '---', '# tighten', 'disable_focuses:', '  - performance', "  - 'conciseness'  # nah", '',
    'exclude: ["gen/**", build/*.js]', 'thresholds:', '  severity: high', '  confidence: 0.85',
    'max_reviewers: 2', 'max_comments: 4', 'max_reviewable_lines: "400"',
  ].join('\r\n'), DEFAULTS);

  assert.deepEqual(warnings, []);
  assert.deepEqual([...settings.disabledFocuses], ['performance', 'conciseness']);
  assert.deepEqual(settings.exclude, ['gen/**', 'build/*.js']);
  assert.equal(settings.minSeverity, 'high');
  assert.equal(settings.minConfidence, 0.85);
  assert.deepEqual([settings.maxReviewers, settings.maxComments, settings.maxReviewableLines], [2, 4, 400]);
});

test('a bad value ignores only that key; a cap that would drop an always-on reviewer is refused', () => {
  const { settings, warnings } = parseRepoConfig('max_reviewers: 1\nmax_comments: lots\nthresholds:\n  severity: huge\n  confidence: 0.9\n', DEFAULTS);

  assert.equal(settings.maxReviewers, 3);
  assert.equal(settings.maxComments, 10);
  assert.equal(settings.minSeverity, 'medium');
  assert.equal(settings.minConfidence, 0.9);
  assert.equal(warnings.length, 3);
});

test('no config, or an empty one, means deployment defaults and no warnings', () => {
  for (const text of [undefined, '', '# nothing yet\n']) {
    const { settings, warnings } = parseRepoConfig(text, DEFAULTS);
    assert.deepEqual(warnings, []);
    assert.equal(settings.maxReviewers, 3);
  }
});

test('unsupported YAML is malformed rather than half-read', () => {
  for (const text of ['a: {b: 1}', 'exclude:\n  - x\n    - y', 'key:value', '\tmax_comments: 2', 'max_comments: 2\nmax_comments: 3', 'path_hints:\n  a:\n    b: c']) {
    const { warnings } = parseRepoConfig(text, DEFAULTS);
    assert.match(warnings.join(), /malformed/, JSON.stringify(text));
  }
});
