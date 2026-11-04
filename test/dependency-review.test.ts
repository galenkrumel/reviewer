// The security focus on dependency changes, through the harness: it runs whenever a supported lockfile changes, sees
// the Dependency check's output as untrusted data, and a clean lockfile-only PR can be approved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/app.ts';
import type { ChatRequest } from '../src/ports.ts';
import {
  delivery, FakeGitHub, gitFixture, noFindings, openedPayload, prPayload, ScriptedModel, select, testApp, toolCall, type Turn,
} from './harness.ts';

const REPO = 'acme/widgets';
const LOCK = 'package-lock.json';

const lock = (packages: Record<string, object>, root: object = { dependencies: { dompurify: '^3.4.0' } }) => JSON.stringify(
  { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', ...root }, ...packages } }, null, 2) + '\n';
const pkg = (name: string, version: string, extra: object = {}) =>
  ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: `sha512-${name}${version}`, ...extra });
const purify = (v: string, more: Record<string, object> = {}) => lock({
  ...more, 'node_modules/dompurify': pkg('dompurify', v), 'node_modules/jsdom': pkg('jsdom', '20.0.0', { dependencies: { dompurify: '*' } }),
});

/** The 1-based line of `"version"` under `key` in a lockfile. */
const versionLine = (text: string, key: string) => {
  const ls = text.split('\n');
  const from = ls.findIndex((l) => l.includes(`"${key}"`));
  return ls.findIndex((l, i) => i > from && l.includes('"version"')) + 1;
};

const FIXES = [
  { id: 'GHSA-mrv2-3pqr-j5jr', severity: 'critical' as const, summary: 'DOMPurify allows XSS', firstPatched: '3.4.17', withdrawn: false },
  { id: 'GHSA-c6gr-qvv4-5v3f', severity: 'high' as const, summary: 'Prototype pollution', firstPatched: '3.4.14', withdrawn: false },
];

/** The user message of a request: the data blocks the agent was given. */
const userText = (r: ChatRequest) => r.messages.find((m) => m.role === 'user')!.content as string;
const block = (r: ChatRequest, name: string) =>
  new RegExp(`<untrusted-data name="${name}">\\n([\\s\\S]*?)\\n</untrusted-data>`).exec(userText(r))?.[1];

function setup(base: Record<string, string>, head: Record<string, string | null>, opts: {
  config?: Partial<AppConfig>; turns?: Record<string, Turn[]>;
} = {}) {
  const fx = gitFixture(base, head);
  const pr = { number: 256, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel(opts.turns ?? { security: Array.from({ length: 5 }, noFindings) });
  const t = testApp({ model, github, config: opts.config });
  const opened = async () => {
    await t.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
    await t.app.drain();
    return github.reviews.at(-1)!.review;
  };
  const push = async (files: Record<string, string | null>) => {
    pr.headSha = fx.push(files);
    github.addPullRequest(REPO, fx.url, pr);
    await t.app.receive(delivery('pull_request', prPayload('synchronize', REPO, pr)));
    await t.app.drain();
    return github.reviews.at(-1)!.review;
  };
  return { ...t, fx, pr, github, model, opened, push };
}

test("a lockfile-only PR runs the security focus, given the Dependency check's output as untrusted data", async () => {
  const head = purify('3.4.17', { 'node_modules/newdep': pkg('newdep', '1.0.0'), 'node_modules/big': pkg('big', '2.0.0') });
  const s = setup({ [LOCK]: purify('3.4.11', { 'node_modules/big': pkg('big', '1.9.0') }) }, { [LOCK]: head });
  s.github.advisoryDb.push(...FIXES.map((a) => ({ ...a, package: 'dompurify', versions: ['3.4.11'] })));
  const review = await s.opened();

  assert.deepEqual(s.model.agents(), ['security']);
  const data = block(s.model.requestsFor('security')[0]!, 'dependency-check');
  assert.ok(data, userText(s.model.requestsFor('security')[0]!));
  assert.match(data, new RegExp(`^${LOCK}:$`, 'm'));
  assert.match(data, new RegExp(`- dompurify 3\\.4\\.11 → 3\\.4\\.17, line ${versionLine(head, 'node_modules/dompurify')}; pulled in by app, jsdom`));
  assert.match(data, /  - fixed: GHSA-mrv2-3pqr-j5jr \(critical\): DOMPurify allows XSS/);
  assert.match(data, /- big 1\.9\.0 → 2\.0\.0, major version bump; line \d+/);
  assert.match(data, /- newdep 1\.0\.0 \(added\), line \d+/);
  assert.match(review.body, /Reviewed for security\./);
});

test("neither the orchestrator's picks nor per-repo config can stop security running on a lockfile change", async () => {
  const config = '.github/ai-review.yml';
  const s = setup({ [LOCK]: purify('3.4.11'), 'README.md': 'a\n', [config]: 'disable_focuses: [security]\nmax_reviewers: 3\n' },
    { [LOCK]: purify('3.4.17'), 'README.md': 'b\n' },
    { turns: { orchestrator: [select('documentation', 'performance', 'architecture')], security: [noFindings()], documentation: [noFindings()], performance: [noFindings()] } });
  await s.opened();

  assert.deepEqual(s.app.runs()[0]!.focuses.map((f) => f.focus), ['security', 'documentation', 'performance']);
  assert.ok(block(s.model.requestsFor('security')[0]!, 'dependency-check'));
  // Other focuses never get the check's block.
  assert.equal(block(s.model.requestsFor('documentation')[0]!, 'dependency-check'), undefined);
});

test('a lockfile-only bump that fixes Advisories and introduces none is approved with approvals on (911day#256)', async () => {
  const s = setup({ [LOCK]: purify('3.4.11') }, { [LOCK]: purify('3.4.17') }, { config: { approveWhenClean: true } });
  s.github.advisoryDb.push(...FIXES.map((a) => ({ ...a, package: 'dompurify', versions: ['3.4.11'] })));
  const review = await s.opened();

  assert.equal(review.event, 'APPROVE', review.body);
  assert.match(review.body, /Advisories fixed:\n- `GHSA-mrv2-3pqr-j5jr critical in dompurify`/);
  assert.ok(!review.body.includes('no reviewers ran'));
});

test("the security focus's Finding on a package's lockfile line is posted", async () => {
  const head = purify('3.4.17');
  const line = versionLine(head, 'node_modules/dompurify');
  const s = setup({ [LOCK]: purify('3.4.11') }, { [LOCK]: head }, {
    turns: {
      security: [toolCall('report_findings', {
        findings: [{
          title: 'Sanitizer bypass reachable from comment rendering', severity: 'high', confidence: 0.9, path: LOCK, line,
          evidence: 'src/render.ts passes user HTML to DOMPurify with the option this release changed.',
        }],
      })],
    },
  });
  const review = await s.opened();

  assert.deepEqual(review.comments.map((c) => [c.path, c.line, c.body.split('\n')[0]]),
    [[LOCK, line, '**Sanitizer bypass reachable from comment rendering**']]);
});

test("a model that says nothing about an introduced Advisory, or reports it lower, can't soften its Finding", async () => {
  const head = purify('3.4.16');
  const line = versionLine(head, 'node_modules/dompurify');
  const s = setup({ [LOCK]: purify('3.4.10') }, { [LOCK]: head }, {
    config: { approveWhenClean: true },
    turns: {
      security: [toolCall('report_findings', {
        findings: [{ title: 'XSS advisory is unreachable here', severity: 'low', confidence: 1, path: LOCK, line, evidence: 'Not used.' }],
      })],
    },
  });
  s.github.advisoryDb.push({ ...FIXES[0]!, package: 'dompurify', versions: ['3.4.16'] });
  const review = await s.opened();

  assert.equal(review.event, 'COMMENT');
  assert.deepEqual(review.comments.map((c) => c.body.split('\n').slice(0, 3).join(' ')),
    ['**Advisory GHSA-mrv2-3pqr-j5jr in dompurify**  `critical` · security']);
  assert.match(review.body, /\*\*Not approved:\*\* 1 new issue commented on/);
});

test('an introduced Advisory the security focus says nothing about still blocks', async () => {
  const s = setup({ [LOCK]: purify('3.4.10') }, { [LOCK]: purify('3.4.16') }, { config: { approveWhenClean: true } });
  s.github.advisoryDb.push({ ...FIXES[0]!, package: 'dompurify', versions: ['3.4.16'] });
  const review = await s.opened();

  assert.equal(review.event, 'COMMENT');
  assert.equal(review.comments.length, 1);
  assert.match(review.body, /\*\*Not approved:\*\* 1 new issue commented on/);
});

test('a PR changing only excluded files and no supported lockfile still runs no reviewers', async () => {
  const s = setup({ 'yarn.lock': 'a@1\n' }, { 'yarn.lock': 'a@2\n' }, { config: { approveWhenClean: true }, turns: {} });
  const review = await s.opened();

  assert.deepEqual(s.model.agents(), []);
  assert.match(review.body, /\*\*Not approved:\*\* no reviewers ran: nothing reviewable changed\./);
});

test('a lockfile-only push after a review has security review the dependency changes in full, and can approve', async () => {
  const s = setup({ [LOCK]: purify('3.4.11'), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.12'), 'src/a.ts': 'b\n' }, {
    config: { approveWhenClean: true },
    turns: { orchestrator: [select('correctness')], correctness: [noFindings()], security: [noFindings(), noFindings()] },
  });
  await s.opened();
  const review = await s.push({ [LOCK]: purify('3.4.17') });

  assert.equal(review.event, 'APPROVE', review.body);
  const second = s.model.requestsFor('security')[1]!;
  assert.match(block(second, 'dependency-check')!, /dompurify 3\.4\.11 → 3\.4\.17/);
  assert.equal(s.model.requestsFor('correctness').length, 1);
});

test("a code-only push after a review doesn't hand security the unchanged dependency changes again", async () => {
  const s = setup({ [LOCK]: purify('3.4.11'), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.17'), 'src/a.ts': 'b\n' }, {
    turns: { orchestrator: [select('correctness'), select('correctness')], correctness: [noFindings(), noFindings()], security: [noFindings(), noFindings()] },
  });
  await s.opened();
  await s.push({ 'src/a.ts': 'c\n' });

  const [first, second] = s.model.requestsFor('security');
  assert.ok(block(first!, 'dependency-check'));
  assert.equal(block(second!, 'dependency-check'), undefined);
});

test('a deletion-only push on a PR with a lockfile change is still not approved: no code reviewer ran on it', async () => {
  // Enough added lines that the push's diff stays smaller than the PR's, so the push is reviewed incrementally.
  const body = Array.from({ length: 20 }, (_, i) => `line${i}()`).join('\n');
  const s = setup({ [LOCK]: purify('3.4.11'), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.17'), 'src/a.ts': `a\n${body}\ncheck()\n` }, {
    config: { approveWhenClean: true },
    turns: { orchestrator: [select('correctness')], correctness: [noFindings()], security: [noFindings(), noFindings()] },
  });
  assert.equal((await s.opened()).event, 'APPROVE');
  // The lockfile moves too, so security runs on this push: that alone mustn't count as reviewing the deletion.
  const review = await s.push({ 'src/a.ts': `a\n${body}\n`, [LOCK]: purify('3.4.18') });

  assert.deepEqual(s.app.runs().at(-1)!.focuses.map((f) => f.focus), ['security']);
  assert.equal(review.event, 'COMMENT');
  assert.match(review.body, /no reviewers ran on this push; add the `ai-review` label for a full review/);
});
