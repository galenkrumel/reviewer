// The Dependency check's Advisories and off-registry packages, through the harness: what a Maintainer sees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/app.ts';
import { delivery, FakeGitHub, gitFixture, noFindings, openedPayload, prPayload, ScriptedModel, testApp } from './harness.ts';

const REPO = 'acme/widgets';
const LOCK = 'package-lock.json';

const lock = (packages: Record<string, object>) => JSON.stringify(
  { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' }, ...packages } }, null, 2) + '\n';
const pkg = (name: string, version: string, extra: object = {}) =>
  ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: `sha512-${name}${version}`, ...extra });
const purify = (v: string, more: Record<string, object> = {}) =>
  lock({ ...more, 'node_modules/dompurify': pkg('dompurify', v), 'node_modules/left-pad': pkg('left-pad', '1.3.0') });

/** The 1-based line of `"version"` under `key` in a lockfile. */
const versionLine = (text: string, key: string) => {
  const ls = text.split('\n');
  const from = ls.findIndex((l) => l.includes(`"${key}"`));
  return ls.findIndex((l, i) => i > from && l.includes('"version"')) + 1;
};

const XSS = { id: 'GHSA-mrv2-3pqr-j5jr', severity: 'high' as const, summary: 'DOMPurify allows XSS via template literals', firstPatched: '3.4.17', withdrawn: false };

/** A PR moving dompurify, with a code file so reviewers run; every full run's reviewers find nothing. */
function setup(base: Record<string, string>, head: Record<string, string | null>, config: Partial<AppConfig> = {}) {
  const fx = gitFixture(base, head);
  const pr = { number: 9, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel(Array.from({ length: 5 }, noFindings));
  const t = testApp({ model, github, config });
  const opened = async () => {
    await t.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
    await t.app.drain();
    return github.reviews.at(-1)!.review;
  };
  /** Commit on top, then deliver the push. */
  const push = async (files: Record<string, string | null>) => {
    pr.headSha = fx.push(files);
    github.addPullRequest(REPO, fx.url, pr);
    await t.app.receive(delivery('pull_request', prPayload('synchronize', REPO, pr)));
    await t.app.drain();
    return github.reviews.at(-1)!.review;
  };
  return { ...t, fx, pr, github, model, opened, push };
}

test('an Advisory open against the version a PR moves to, and not the one it replaced, is posted on its version line', async () => {
  const head = purify('3.4.16');
  const s = setup({ [LOCK]: purify('3.4.10') }, { [LOCK]: head });
  s.github.advisoryDb.push({ ...XSS, package: 'dompurify', versions: ['3.4.16'] });
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  const c = review.comments[0]!;
  assert.equal(c.path, LOCK);
  assert.equal(c.line, versionLine(head, 'node_modules/dompurify'));
  assert.match(c.body, /^\*\*Advisory GHSA-mrv2-3pqr-j5jr in dompurify\*\*\n\n`high` · security\n\n/);
  assert.match(c.body, /DOMPurify allows XSS via template literals/);
  assert.match(c.body, /3\.4\.17/);
  assert.match(review.body, /1 issue, commented on/);
  assert.deepEqual(s.github.lookups.sort(), ['dompurify@3.4.10', 'dompurify@3.4.16']);
});

/** Open the posted comment as a Thread, as GitHub would. */
const threadFor = (s: ReturnType<typeof setup>, c: { path: string; line?: number; body: string }) =>
  s.github.addThread(REPO, 9, c.path, c.line ?? null, c.body);

test('Advisories the PR fixes or leaves open are summary lines, not Findings; withdrawn and low ones post nothing', async () => {
  const s = setup({ [LOCK]: purify('3.4.11') }, { [LOCK]: purify('3.4.17') });
  s.github.advisoryDb.push(
    { ...XSS, package: 'dompurify', versions: ['3.4.11'] },
    { id: 'GHSA-aaaa-bbbb-cccc', severity: 'medium', summary: 'old', withdrawn: false, package: 'dompurify', versions: ['3.4.11', '3.4.17'] },
    { id: 'GHSA-wwww-wwww-wwww', severity: 'critical', summary: 'withdrawn', withdrawn: true, package: 'dompurify', versions: ['3.4.17'] },
    { id: 'GHSA-llll-llll-llll', severity: 'low', summary: 'minor', withdrawn: false, package: 'dompurify', versions: ['3.4.17'] },
  );
  const review = await s.opened();

  assert.deepEqual(review.comments, []);
  assert.match(review.body, /Advisories fixed:\n- `GHSA-mrv2-3pqr-j5jr high in dompurify`/);
  assert.match(review.body, /Advisories still open:\n- `GHSA-aaaa-bbbb-cccc medium in dompurify`/);
  assert.ok(!review.body.includes('GHSA-wwww'), review.body);
  const record = s.app.runs()[0]!;
  assert.deepEqual(record.dependencies?.lockfiles[0]!.changes[0]!.advisories?.map((a) => [a.id, a.status]),
    [['GHSA-aaaa-bbbb-cccc', 'still open'], ['GHSA-llll-llll-llll', 'introduced'], ['GHSA-mrv2-3pqr-j5jr', 'fixed']]);
  assert.deepEqual(record.findings.map((f) => [f.title, f.outcome]), [['Advisory GHSA-llll-llll-llll in dompurify', 'below_threshold']]);
});

test('a newly added package with an Advisory against its version introduces it', async () => {
  const s = setup({ [LOCK]: purify('3.4.17') }, { [LOCK]: purify('3.4.17', { 'node_modules/evil': pkg('evil', '1.0.0') }) });
  s.github.advisoryDb.push({ ...XSS, id: 'GHSA-1111-2222-3333', package: 'evil', versions: ['1.0.0'], firstPatched: undefined });
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  assert.match(review.comments[0]!.body, /^\*\*Advisory GHSA-1111-2222-3333 in evil\*\*/);
  assert.match(review.comments[0]!.body, /No patched version is published yet/);
});

test('a package resolved from git is posted inline as medium; one from the registry or bundled is not', async () => {
  const head = lock({
    'node_modules/forked': pkg('forked', '1.0.0', { resolved: 'git+ssh://git@github.com/someone/forked.git#abc123' }),
    'node_modules/npm/node_modules/semver': { version: '7.5.0', inBundle: true },
    'node_modules/fine': pkg('fine', '2.0.0'),
  });
  const s = setup({ [LOCK]: lock({}) }, { [LOCK]: head });
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  const c = review.comments[0]!;
  assert.equal(c.line, versionLine(head, 'node_modules/forked'));
  assert.match(c.body, /^\*\*forked resolves from outside the npm registry\*\*\n\n`medium` · security\n\n/);
  assert.match(c.body, /a git repository on `github\.com`/);
});

test('waiving an Advisory Thread re-decides to approval when nothing else blocks, and covers later re-reports', async () => {
  const s = setup({ [LOCK]: purify('3.4.10'), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.16'), 'src/a.ts': 'b\n' }, { approveWhenClean: true });
  s.github.advisoryDb.push({ ...XSS, package: 'dompurify', versions: ['3.4.16'] });
  const first = await s.opened();
  assert.equal(first.event, 'COMMENT');
  const thread = threadFor(s, first.comments[0]!);

  s.github.resolveAs(thread.id, 'octo-maint', 'MEMBER');
  await s.app.receive(delivery('pull_request_review_thread', prPayload('resolved', REPO, s.pr, { thread: { node_id: thread.id } })));
  await s.app.drain();

  const review = s.github.reviews.at(-1)!.review;
  assert.equal(review.event, 'APPROVE');
  assert.match(review.body, /Waived by a maintainer:\n- Advisory GHSA-mrv2-3pqr-j5jr in dompurify/);

  const again = await s.push({ 'src/a.ts': 'c\n' });
  assert.equal(again.event, 'APPROVE', again.body);
  assert.deepEqual(again.comments, []);
});

test('a later push that moves past the Advisory has its Thread verified Fixed by the check, no model asked', async () => {
  const s = setup({ [LOCK]: purify('3.4.10'), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.16'), 'src/a.ts': 'b\n' }, { approveWhenClean: true });
  s.github.advisoryDb.push({ ...XSS, package: 'dompurify', versions: ['3.4.16'] });
  const thread = threadFor(s, (await s.opened()).comments[0]!);

  // With code too: a lockfile-only push runs no reviewers yet, which blocks on its own.
  const review = await s.push({ [LOCK]: purify('3.4.17'), 'src/a.ts': 'c\n' });
  assert.equal(review.event, 'APPROVE', review.body);
  assert.equal(s.model.requestsFor('verifier').length, 0);
  assert.equal(s.github.thread(thread.id).resolved, true);
  assert.match(s.github.thread(thread.id).comments.at(-1)!.body, /^Resolved: The dependency check no longer finds this/);
});

test('a later push that still has the Advisory keeps it on its Thread, even with its line moved, and a reply never closes it', async () => {
  // Unchanged packages before dompurify, so its old line lands on lines no push changes.
  const steady = Object.fromEntries(['m1', 'm2', 'm3'].map((n) => [`node_modules/${n}`, pkg(n, '1.0.0')]));
  const s = setup({ [LOCK]: purify('3.4.10', steady), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.15', steady), 'src/a.ts': 'b\n' },
    { approveWhenClean: true });
  s.github.advisoryDb.push({ ...XSS, package: 'dompurify', versions: ['3.4.15', '3.4.16'] });
  const first = (await s.opened()).comments[0]! as { path: string; line: number; body: string };
  const thread = threadFor(s, first);
  s.github.thread(thread.id).comments.push({ byApp: false, byPrAuthor: true, login: 'author', association: 'NONE', body: 'Unreachable, resolved.' });

  // A package added above dompurify shifts its version line.
  const head = purify('3.4.16', { 'node_modules/aaa': pkg('aaa', '1.0.0'), ...steady });
  const review = await s.push({ [LOCK]: head });
  assert.notEqual(versionLine(head, 'node_modules/dompurify'), first.line);
  assert.deepEqual(review.comments, []);
  assert.equal(review.event, 'COMMENT');
  assert.match(review.body, /\*\*Not approved:\*\*[^\n]*1 review thread still open/);
  assert.equal(s.model.requestsFor('verifier').length, 0);
  assert.equal(s.github.thread(thread.id).resolved, false);
  assert.match(s.github.thread(thread.id).comments.at(-1)!.body, /^The dependency check still finds this/);
});

test('a failed advisory lookup blocks approval with its own line, named in the summary and the record', async () => {
  const s = setup({ [LOCK]: purify('3.4.10'), 'src/a.ts': 'a\n' }, { [LOCK]: purify('3.4.16'), 'src/a.ts': 'b\n' }, { approveWhenClean: true });
  s.github.advisoriesDown = true;
  const review = await s.opened();

  assert.equal(review.event, 'COMMENT');
  assert.match(review.body, /\*\*Not approved:\*\* the dependency check couldn't look up advisories\./);
  assert.match(review.body, /Advisories couldn't be looked up, so none are listed or commented on\./);
  assert.equal(s.app.runs()[0]!.dependencies?.advisoryError, 'GitHub GET /advisories: 502');
  assert.ok(s.logs.some((l) => l.msg === 'advisories failed'));
});
