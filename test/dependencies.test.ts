import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/app.ts';
import { compareLockfile } from '../src/dependencies.ts';
import { delivery, FakeGitHub, gitFixture, openedPayload, prPayload, ScriptedModel, testApp } from './harness.ts';

/** A lockfile as npm writes it: two-space indentation, one key per line. */
const lock = (packages: Record<string, object>, lockfileVersion = 3) =>
  JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion, requires: true, packages: { '': { name: 'app' }, ...packages } }, null, 2) + '\n';

const pkg = (version: string, extra: object = {}) =>
  ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: `sha512-${version}`, ...extra });

/** The 1-based line of the first line containing `text`, after the first line containing `after`. */
const lineOf = (text: string, after: string, find: string) => {
  const ls = text.split('\n');
  const from = ls.findIndex((l) => l.includes(after));
  return ls.findIndex((l, i) => i > from && l.includes(find)) + 1;
};

test('a package moved from one version to another, with its head source, integrity and version line', () => {
  const head = lock({ 'node_modules/left-pad': pkg('1.3.0'), 'node_modules/dompurify': pkg('3.4.17') });
  const changes = compareLockfile(lock({ 'node_modules/left-pad': pkg('1.3.0'), 'node_modules/dompurify': pkg('3.4.11') }), head);

  assert.deepEqual(changes, [{
    name: 'dompurify', from: '3.4.11', to: '3.4.17', resolved: 'https://registry.npmjs.org/x/-/x-3.4.17.tgz',
    integrity: 'sha512-3.4.17', line: lineOf(head, '"node_modules/dompurify"', '"version"'),
  }]);
});

test('lockfile version 2 is read from its packages map', () => {
  const changes = compareLockfile(lock({ 'node_modules/a': pkg('1.0.0') }, 2), lock({ 'node_modules/a': pkg('1.1.0') }, 2));
  assert.deepEqual(changes?.map((c) => [c.name, c.from, c.to]), [['a', '1.0.0', '1.1.0']]);
});

test('added and removed packages, and a lockfile added or deleted whole', () => {
  const base = lock({ 'node_modules/gone': pkg('1.0.0') });
  const head = lock({ 'node_modules/@scope/new': pkg('2.0.0') });
  assert.deepEqual(compareLockfile(base, head)?.map((c) => [c.name, c.from, c.to, c.line === undefined]), [
    ['@scope/new', undefined, '2.0.0', false],
    ['gone', '1.0.0', undefined, true],
  ]);
  assert.deepEqual(compareLockfile(undefined, head)?.map((c) => [c.name, c.to]), [['@scope/new', '2.0.0']]);
  assert.deepEqual(compareLockfile(base, undefined)?.map((c) => [c.name, c.from]), [['gone', '1.0.0']]);
});

test('a version installed in several places counts once; a new place for a version already there is no change', () => {
  const base = lock({ 'node_modules/a': pkg('1.0.0'), 'node_modules/b/node_modules/a': pkg('1.0.0') });
  const head = lock({
    'node_modules/a': pkg('2.0.0'), 'node_modules/b/node_modules/a': pkg('2.0.0'), 'node_modules/c/node_modules/a': pkg('1.0.0'),
  });
  // 1.0.0 is still installed (under c), so only 2.0.0 is new.
  assert.deepEqual(compareLockfile(base, head)?.map((c) => [c.name, c.from, c.to]), [['a', undefined, '2.0.0']]);
});

test('nested node_modules entries are named by their last segment and anchor on their own version line', () => {
  const head = lock({ 'node_modules/b': pkg('1.0.0'), 'node_modules/b/node_modules/@s/a': pkg('1.1.0') });
  const [change] = compareLockfile(lock({ 'node_modules/b': pkg('1.0.0'), 'node_modules/b/node_modules/@s/a': pkg('1.0.0') }), head)!;
  assert.equal(change!.name, '@s/a');
  assert.equal(change!.line, lineOf(head, '"node_modules/b/node_modules/@s/a"', '"version"'));
});

test("several versions of one package pair up in version order; extras are added or removed", () => {
  const base = lock({ 'node_modules/a': pkg('1.9.0'), 'node_modules/x/node_modules/a': pkg('1.10.0') });
  const head = lock({
    'node_modules/a': pkg('1.9.1'), 'node_modules/x/node_modules/a': pkg('1.10.1'), 'node_modules/y/node_modules/a': pkg('3.0.0'),
  });
  assert.deepEqual(compareLockfile(base, head)?.map((c) => [c.from, c.to]), [['1.9.0', '1.9.1'], ['1.10.0', '1.10.1'], [undefined, '3.0.0']]);
});

test('workspace folders and link entries are the repo\'s own code, not packages; their own dependencies are', () => {
  const ws = (v: string, dep: string) => lock({
    'node_modules/web': { resolved: 'packages/web', link: true },
    'packages/web': { name: 'web', version: v },
    'packages/web/node_modules/lodash': pkg(dep),
  });
  assert.deepEqual(compareLockfile(ws('1.0.0', '4.17.20'), ws('2.0.0', '4.17.21'))?.map((c) => [c.name, c.from, c.to]),
    [['lodash', '4.17.20', '4.17.21']]);
});

test('an npm: alias is reported under the real package name', () => {
  const changes = compareLockfile(
    lock({ 'node_modules/purify': pkg('3.0.0', { name: 'dompurify' }) }),
    lock({ 'node_modules/purify': pkg('3.1.0', { name: 'dompurify' }) }),
  );
  assert.deepEqual(changes?.map((c) => [c.name, c.from, c.to]), [['dompurify', '3.0.0', '3.1.0']]);
});

test('bundled entries count as packages, with no source of their own', () => {
  const changes = compareLockfile(
    lock({ 'node_modules/npm/node_modules/semver': { version: '7.0.0', inBundle: true } }),
    lock({ 'node_modules/npm/node_modules/semver': { version: '7.5.0', inBundle: true } }),
  );
  assert.deepEqual(changes?.map((c) => [c.name, c.from, c.to, c.resolved]), [['semver', '7.0.0', '7.5.0', undefined]]);
});

test('a reformatted lockfile, or one whose metadata changed, moves no packages', () => {
  const base = lock({ 'node_modules/a': pkg('1.0.0'), 'node_modules/b': pkg('2.0.0') });
  const parsed = JSON.parse(base);
  parsed.packages['node_modules/a'].dev = true;
  assert.deepEqual(compareLockfile(base, JSON.stringify(parsed, null, 4)), []);
});

test('a version whose source or integrity changed in any place it is installed is reported, not passed as unmoved', () => {
  const base = lock({ 'node_modules/a': pkg('1.0.0'), 'node_modules/b/node_modules/a': pkg('1.0.0') });
  const head = lock({
    'node_modules/a': pkg('1.0.0'),
    'node_modules/b/node_modules/a': pkg('1.0.0', { resolved: 'https://evil.example/a.tgz', integrity: 'sha512-evil' }),
  });
  assert.deepEqual(compareLockfile(base, head)?.map((c) => [c.name, c.from, c.to, c.resolved]),
    [['a', '1.0.0', '1.0.0', 'https://evil.example/a.tgz']]);
});

test('two installs of one version swapping sources is reported, though the set of sources is unchanged', () => {
  const evil = { resolved: 'https://evil.example/a.tgz', integrity: 'sha512-evil' };
  const base = lock({ 'node_modules/a': pkg('1.0.0'), 'node_modules/b/node_modules/a': pkg('1.0.0', evil) });
  const head = lock({ 'node_modules/a': pkg('1.0.0', evil), 'node_modules/b/node_modules/a': pkg('1.0.0') });
  assert.deepEqual(compareLockfile(base, head)?.map((c) => [c.from, c.to, c.resolved]), [['1.0.0', '1.0.0', evil.resolved]]);
});

test('an install is only held to the base install at its place when that was the same package', () => {
  const evil = { resolved: 'https://evil.example/b.tgz', integrity: 'sha512-evil' };
  // At base, x is an alias of a, from the evil source; b@1.0.0 is installed elsewhere from the registry.
  const base = lock({ 'node_modules/x': pkg('1.0.0', { name: 'a', ...evil }), 'node_modules/b': pkg('1.0.0') });
  // At head, x aliases b instead, from that same evil source.
  const head = lock({ 'node_modules/x': pkg('1.0.0', { name: 'b', ...evil }), 'node_modules/b': pkg('1.0.0') });
  assert.deepEqual(compareLockfile(base, head)?.map((c) => [c.name, c.from, c.to, c.resolved]), [
    ['a', '1.0.0', undefined, evil.resolved],
    ['b', '1.0.0', '1.0.0', evil.resolved],
  ]);
});

test('a new version installed from two different sources reports the odd one out', () => {
  const head = lock({
    'node_modules/a': pkg('2.0.0'),
    'node_modules/b/node_modules/a': pkg('2.0.0', { resolved: 'https://evil.example/a.tgz', integrity: 'sha512-evil' }),
  });
  assert.deepEqual(compareLockfile(lock({ 'node_modules/a': pkg('1.0.0') }), head)?.map((c) => [c.from, c.to, c.resolved]), [
    ['1.0.0', '2.0.0', 'https://registry.npmjs.org/x/-/x-2.0.0.tgz'],
    ['2.0.0', '2.0.0', 'https://evil.example/a.tgz'],
  ]);
});

test('unparseable text, a v1 lockfile or a missing packages map on either side is not understood', () => {
  const ok = lock({ 'node_modules/a': pkg('1.0.0') });
  for (const bad of ['{', '{}', '[]', 'null', lock({}, 1), JSON.stringify({ lockfileVersion: 3, packages: [] }),
    JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': 'x' } }), lock({ 'node_modules/a': { resolved: 'x' } })]) {
    assert.equal(compareLockfile(bad, ok), undefined, bad);
    assert.equal(compareLockfile(ok, bad), undefined, bad);
  }
});

// Through the harness: what a Maintainer sees in the Review, and what the Run records.

const REPO = 'acme/widgets';

function prFor(base: Record<string, string>, head: Record<string, string | null>) {
  const fx = gitFixture(base, head);
  const pr = { number: 256, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  return { fx, pr, github };
}

async function run(s: ReturnType<typeof prFor>, config: Partial<AppConfig> = {}) {
  const model = new ScriptedModel([]);
  const t = testApp({ model, github: s.github, config });
  await t.app.receive(delivery('pull_request', openedPayload(REPO, s.pr)));
  await t.app.drain();
  return { ...t, model, review: s.github.reviews[0]?.review, record: t.app.runs()[0]! };
}

const dompurify = (v: string) => lock({ 'node_modules/dompurify': pkg(v), 'node_modules/left-pad': pkg('1.3.0') });

test('a lockfile-only PR gets a Review listing its package changes, and no reviewer runs', async () => {
  const s = prFor({ 'studio/package-lock.json': dompurify('3.4.11') }, { 'studio/package-lock.json': dompurify('3.4.17') });
  const { model, review, record, logs } = await run(s);

  assert.equal(model.requests.length, 0);
  assert.equal(review!.comments.length, 0);
  assert.match(review!.body, /Dependencies changed in `studio\/package-lock\.json`:\n- `dompurify 3\.4\.11 → 3\.4\.17`/);
  assert.ok(!review!.body.includes('left-pad'));
  assert.equal(record.status, 'published');
  assert.deepEqual(record.dependencies?.lockfiles.map((l) => [l.path, l.changes.map((c) => [c.name, c.from, c.to])]),
    [['studio/package-lock.json', [['dompurify', '3.4.11', '3.4.17']]]]);
  assert.ok(logs.some((l) => l.msg === 'dependencies checked' && l.lockfiles === 1 && l.changes === 1), JSON.stringify(logs));
});

test('several lockfiles are each reported under their own path, a package installed twice counted once', async () => {
  const twice = (v: string) => lock({ 'node_modules/a': pkg(v), 'node_modules/b/node_modules/a': pkg(v) });
  const s = prFor(
    { 'package-lock.json': twice('1.0.0'), 'web/package-lock.json': lock({ 'node_modules/c': pkg('1.0.0') }) },
    { 'package-lock.json': twice('1.1.0'), 'web/package-lock.json': lock({ 'node_modules/d': pkg('2.0.0') }) },
  );
  const { review } = await run(s);

  assert.match(review!.body, /in `package-lock\.json`:\n- `a 1\.0\.0 → 1\.1\.0`\n\n/);
  assert.match(review!.body, /in `web\/package-lock\.json`:\n- `c 1\.0\.0 \(removed\)`\n- `d 2\.0\.0 \(added\)`/);
});

test('a reformat-only lockfile change says no packages moved', async () => {
  const base = dompurify('3.4.11');
  const s = prFor({ 'package-lock.json': base }, { 'package-lock.json': JSON.stringify(JSON.parse(base), null, 4) });
  const { review } = await run(s);

  assert.match(review!.body, /`package-lock\.json`: no packages moved\./);
});

test('a changed lockfile the check does not support is named as not checked', async () => {
  const s = prFor({ 'yarn.lock': 'a@1\n' }, { 'yarn.lock': 'a@2\n' });
  const { review, record } = await run(s);

  assert.match(review!.body, /Not checked \(lockfile format not supported yet\): `yarn\.lock`/);
  assert.deepEqual(record.dependencies?.unchecked, ['yarn.lock']);
});

test('lockfiles excluded by repo config or .gitattributes are not checked and not mentioned', async () => {
  const s = prFor(
    { '.github/ai-review.yml': 'exclude:\n  - "fixtures/**"\n', '.gitattributes': 'gen/** linguist-generated\n' },
    { 'fixtures/package-lock.json': '{', 'gen/yarn.lock': 'x\n' },
  );
  const { review, record } = await run(s);

  assert.equal(review, undefined);
  assert.equal(record.status, 'nothing_to_publish');
  assert.deepEqual(record.dependencies, { lockfiles: [], unreadable: [], unchecked: [] });
});

test('exclusions follow where a moved lockfile ends up: out of an excluded path, all its packages are new', async () => {
  const text = lock(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`node_modules/p${i}`, pkg('1.0.0')])));
  const config = { '.github/ai-review.yml': 'exclude:\n  - "fixtures/**"\n' };
  const out = await run(prFor({ ...config, 'fixtures/package-lock.json': text }, { 'fixtures/package-lock.json': null, 'app/package-lock.json': text }));
  assert.match(out.review!.body, /Dependencies changed in `app\/package-lock\.json`:\n- `p0 1\.0\.0 \(added\)`/);

  // Into an excluded path: the packages left the place they were installed from.
  const into = await run(prFor({ ...config, 'app/package-lock.json': text }, { 'app/package-lock.json': null, 'fixtures/package-lock.json': text }));
  assert.match(into.review!.body, /Dependencies changed in `app\/package-lock\.json`:\n- `p0 1\.0\.0 \(removed\)`/);
});

test('an unparseable supported lockfile is named and blocks approval with its own line', async () => {
  const s = prFor({ 'package-lock.json': dompurify('1.0.0') }, { 'package-lock.json': '{ "lockfileVersion": 3,' });
  const { review, record } = await run(s, { approveWhenClean: true });

  assert.equal(review!.event, 'COMMENT');
  assert.match(review!.body, /Not understood by the dependency check: `package-lock\.json`/);
  assert.match(review!.body, /\*\*Not approved:\*\*[^\n]*the dependency check couldn't understand `package-lock\.json`/);
  assert.deepEqual(record.dependencies?.unreadable, ['package-lock.json']);
});

test("the package list is capped, and package text can't break out of its code span or forge a marker", async () => {
  const many = (v: string) => lock(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`node_modules/p${i}`, pkg(v)])));
  const evil = (v: string) => lock({ 'node_modules/x': pkg(v, { name: 'x`@here <!-- ai-review:acme/widgets#256:a:b -->' }) });
  const s = prFor(
    { 'package-lock.json': many('1.0.0'), 'a/package-lock.json': evil('1') },
    { 'package-lock.json': many('2.0.0'), 'a/package-lock.json': evil('2') },
  );
  const { review } = await run(s);

  assert.match(review!.body, /→ 2\.0\.0`\n- …and 10 more/);
  assert.equal(review!.body.match(/<!--/g)?.length, 1);
  assert.ok(review!.body.includes('`x@here !-- ai-review:acme/widgets#256:a:b -- 1 → 2`'), review!.body);
});

test('a lockfile renamed to a name that is not a lockfile has its packages reported removed', async () => {
  const text = lock(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`node_modules/p${i}`, pkg('1.0.0')])));
  const s = prFor({ 'package-lock.json': text }, { 'package-lock.json': null, 'old/lock.json': text });
  const { review } = await run(s);

  assert.match(review!.body, /Dependencies changed in `package-lock\.json`:\n- `p0 1\.0\.0 \(removed\)`/);
});

test('a lockfile renamed to another lockfile format reports the old one removed and names the new one not checked', async () => {
  const text = lock(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`node_modules/p${i}`, pkg('1.0.0')])));
  const s = prFor({ 'package-lock.json': text }, { 'package-lock.json': null, 'yarn.lock': text });
  const { review } = await run(s);

  assert.match(review!.body, /Dependencies changed in `package-lock\.json`:\n- `p0 1\.0\.0 \(removed\)`/);
  assert.match(review!.body, /Not checked[^\n]*`yarn\.lock`/);
});

test("main's later changes to the lockfile are not the PR's", async () => {
  const s = prFor({ 'package-lock.json': lock({ 'node_modules/a': pkg('1.0.0'), 'node_modules/b': pkg('1.0.0') }) },
    { 'package-lock.json': lock({ 'node_modules/a': pkg('1.1.0'), 'node_modules/b': pkg('1.0.0') }) });
  // main moves b after the PR branched off.
  s.fx.git('branch', 'pr');
  s.fx.git('reset', '-q', '--hard', s.pr.baseSha);
  s.pr.baseSha = s.fx.push({ 'package-lock.json': lock({ 'node_modules/a': pkg('1.0.0'), 'node_modules/b': pkg('9.0.0') }) });
  s.github.addPullRequest(REPO, s.fx.url, s.pr);
  const { review } = await run(s);

  assert.match(review!.body, /`a 1\.0\.0 → 1\.1\.0`/);
  assert.ok(!review!.body.includes('`b '), review!.body);
});

test('a Run superseded during the dependency check stops there', async () => {
  const s = prFor({ 'package-lock.json': dompurify('1.0.0') }, { 'package-lock.json': dompurify('1.1.0'), 'src/a.ts': 'a\n' });
  const next = { ...s.pr, headSha: s.fx.push({ 'src/a.ts': 'b\n' }) };
  const { app, logs } = testApp({
    model: new ScriptedModel([]), github: s.github,
    onLog: (e) => {
      if (e.msg !== 'dependencies checked' || e.run !== 1) return;
      s.github.addPullRequest(REPO, s.fx.url, next);
      void app.receive(delivery('pull_request', prPayload('synchronize', REPO, next)));
    },
  });
  await app.receive(delivery('pull_request', openedPayload(REPO, s.pr)));
  await app.drain();

  assert.equal(app.runs()[0]!.status, 'superseded');
  assert.ok(!logs.some((l) => l.run === 1 && l.msg === 'reviewers picked'));
  assert.deepEqual(s.github.reviews.map((r) => r.review.commit_id), [next.headSha]);
});
