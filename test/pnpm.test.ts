// pnpm-lock.yaml in the Dependency check: the comparison itself, and through the harness what a Maintainer sees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/app.ts';
import { compareLockfile, dependencyFindings, describeMove } from '../src/dependencies.ts';
import { delivery, FakeGitHub, gitFixture, noFindings, openedPayload, ScriptedModel, testApp } from './harness.ts';

const PNPM = 'pnpm-lock.yaml';
const compare = (base: string | undefined, head: string | undefined) => compareLockfile(base, head, PNPM);
const integrity = (s: string) => `sha512-${Buffer.from(s).toString('base64')}==`;

/** A lockfile version 9 as pnpm 9 writes it: a `packages` entry per name and version, a `snapshots` entry per peer variant. */
const v9 = (packages: string, snapshots: string, importer = '') => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
${importer}
packages:
${packages}
snapshots:
${snapshots}`;

/** A registry package's `packages` entry, as pnpm writes it (quoted when scoped). */
const entry = (name: string, version: string, extra = '') => {
  const key = `${name}@${version}`;
  return `\n  ${name.startsWith('@') ? `'${key}'` : key}:\n    resolution: {integrity: ${integrity(key)}}\n${extra}`;
};
const dep = (name: string, version: string) =>
  `      ${name.startsWith('@') ? `'${name}'` : name}:\n        specifier: ^${version}\n        version: ${version}\n`;

const purify = (v: string) => v9(
  entry('dompurify', v) + entry('left-pad', '1.3.0', "    deprecated: use String.prototype.padStart()\n"),
  `\n  dompurify@${v}: {}\n\n  left-pad@1.3.0: {}\n`,
  dep('dompurify', v) + dep('left-pad', '1.3.0'),
);

/** The 1-based line of the line that is exactly `text`. */
const lineOf = (text: string, line: string) => text.split('\n').indexOf(line) + 1;

test('a v9 package moved from one version to another, with its registry tarball, integrity, key line and dependents', () => {
  const head = purify('3.4.17');
  assert.deepEqual(compare(purify('3.4.11'), head), [{
    name: 'dompurify', from: '3.4.11', to: '3.4.17',
    resolved: 'https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz', integrity: integrity('dompurify@3.4.17'),
    line: lineOf(head, '  dompurify@3.4.17:'), pulledBy: ['(root)'],
  }]);
});

test('packages added and removed, scoped names, and dependents from snapshots and workspace importers', () => {
  const base = v9(entry('a', '1.0.0'), '\n  a@1.0.0: {}\n', dep('a', '1.0.0'));
  const head = v9(
    entry('@scope/b', '2.0.0') + entry('c', '1.0.0'),
    "\n  '@scope/b@2.0.0':\n    dependencies:\n      c: 1.0.0\n\n  c@1.0.0: {}\n",
    dep('@scope/b', '2.0.0') + '\n  packages/web:\n    dependencies:\n      c:\n        specifier: ^1.0.0\n        version: 1.0.0\n'
      + '      app:\n        specifier: workspace:*\n        version: link:../app\n',
  );
  const changes = compare(base, head)!;
  assert.deepEqual(changes.map((c) => [c.name, describeMove(c), c.pulledBy]), [
    ['@scope/b', '2.0.0 (added)', ['(root)']],
    ['a', '1.0.0 (removed)', ['(root)']],
    ['c', '1.0.0 (added)', ['@scope/b', 'packages/web']],
  ]);
  assert.equal(changes[0]!.line, lineOf(head, "  '@scope/b@2.0.0':"));
  assert.equal(changes[1]!.line, undefined);
});

test('peer variants of one version are one package, in v9 snapshots and v6 packages alike', () => {
  const nine = (v: string) => v9(entry('react', '18.2.0') + entry('react', '18.3.1') + entry('react-dom', v,
    '    peerDependencies:\n      react: ^18.2.0\n'),
  `\n  react-dom@${v}(react@18.2.0):\n    dependencies:\n      react: 18.2.0\n\n  react-dom@${v}(react@18.3.1):\n    dependencies:\n      react: 18.3.1\n`);
  assert.deepEqual(compare(nine('18.2.0'), nine('18.3.0'))?.map(describeMove), ['18.2.0 → 18.3.0']);
  assert.deepEqual(compare(undefined, nine('18.3.0'))?.map((c) => [c.name, c.to, c.pulledBy]),
    [['react', '18.2.0', ['react-dom']], ['react', '18.3.1', ['react-dom']], ['react-dom', '18.3.0', undefined]]);

  const six = (v: string) => `lockfileVersion: '6.0'

dependencies:
  react-dom:
    specifier: ^${v}
    version: ${v}(react@18.2.0)

packages:

  /react-dom@${v}(react@18.2.0):
    resolution: {integrity: ${integrity(v)}}
    peerDependencies:
      react: ^18.2.0
    dependencies:
      loose-envify: 1.4.0
    dev: false

  /react-dom@${v}(react@18.3.1):
    resolution: {integrity: ${integrity(v)}}
    peerDependencies:
      react: ^18.2.0
    dev: false
`;
  const head = six('18.3.0');
  assert.deepEqual(compare(six('18.2.0'), head), [{
    name: 'react-dom', from: '18.2.0', to: '18.3.0', resolved: 'https://registry.npmjs.org/react-dom/-/react-dom-18.3.0.tgz',
    integrity: integrity('18.3.0'), line: lineOf(head, '  /react-dom@18.3.0(react@18.2.0):'), pulledBy: ['(root)'],
  }]);
});

test('repository and tarball resolutions are off-registry Findings on their key line; directories and runtimes are not packages', () => {
  const head = v9(`
  is-negative@https://codeload.github.com/kevva/is-negative/tar.gz/1d7e288222b53a0cab90a331f1865220ec29560c:
    resolution: {tarball: https://codeload.github.com/kevva/is-negative/tar.gz/1d7e288222b53a0cab90a331f1865220ec29560c}
    version: 2.1.0
    engines: {node: '>=4'}

  forked@git+https://gitlab.com/acme/forked.git#4f2c6e1:
    resolution: {commit: 4f2c6e1, repo: https://gitlab.com/acme/forked.git, type: git}
    version: 1.0.0

  '@acme/local@file:packages/local':
    resolution: {directory: packages/local, type: directory}
    version: 0.0.0

  node@runtime:22.11.0:
    resolution:
      type: variations
      variants:
        - resolution:
            type: binary
            url: https://nodejs.org/download/release/v22.11.0/node-v22.11.0-linux-x64.tar.gz
          targets:
            - cpu: x64
              os: linux
` + entry('dompurify', '3.4.17'), '\n  dompurify@3.4.17: {}\n');
  const changes = compare(undefined, head)!;
  assert.deepEqual(changes.map((c) => [c.name, c.to, c.resolved]), [
    ['dompurify', '3.4.17', 'https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz'],
    ['forked', '1.0.0', 'git+https://gitlab.com/acme/forked.git#4f2c6e1'],
    ['is-negative', '2.1.0', 'https://codeload.github.com/kevva/is-negative/tar.gz/1d7e288222b53a0cab90a331f1865220ec29560c'],
  ]);
  const findings = dependencyFindings({ lockfiles: [{ path: PNPM, changes }], unreadable: [], unchecked: [] });
  assert.deepEqual(findings.map((f) => [f.title, f.line]), [
    ['forked resolves from outside the npm registry', lineOf(head, '  forked@git+https://gitlab.com/acme/forked.git#4f2c6e1:')],
    ['is-negative resolves from outside the npm registry', lineOf(head, '  is-negative@https://codeload.github.com/kevva/is-negative/tar.gz/1d7e288222b53a0cab90a331f1865220ec29560c:')],
  ]);
  assert.match(findings[0]!.evidence, /a git repository on `gitlab\.com`/);

  // v6 keys a repository package by where it comes from, and records its name and version.
  const six = `lockfileVersion: '6.0'

packages:

  github.com/kevva/is-negative/1d7e288222b53a0cab90a331f1865220ec29560c:
    resolution: {tarball: https://codeload.github.com/kevva/is-negative/tar.gz/1d7e288222b53a0cab90a331f1865220ec29560c}
    name: is-negative
    version: 2.1.0
    dev: false

  file:packages/local:
    resolution: {directory: packages/local, type: directory}
    name: '@acme/local'
    dev: false
`;
  assert.deepEqual(compare(undefined, six)?.map((c) => [c.name, c.to, c.line]), [['is-negative', '2.1.0', 5]]);
});

test('the same version from a new source or integrity is a change to itself', () => {
  const swapped = purify('3.4.17').replace(integrity('dompurify@3.4.17'), 'sha512-evil==');
  assert.deepEqual(compare(purify('3.4.17'), swapped)?.map((c) => [describeMove(c), c.integrity]),
    [['3.4.17 (source or integrity changed)', 'sha512-evil==']]);
});

test('a registry tarball, name or version that says another package than its key is not understood', () => {
  const ok = purify('3.4.17');
  for (const bad of [
    ok.replace(/(resolution: \{integrity: [^}]*)\}/, '$1, tarball: https://registry.npmjs.org/evil/-/evil-3.4.17.tgz}'),
    ok.replace('  dompurify@3.4.17:\n', '  dompurify@3.4.17:\n    name: evil\n'),
    ok.replace('  dompurify@3.4.17:\n', '  dompurify@3.4.17:\n    version: 9.9.9\n'),
    v9(entry('a%2f..%2fevil', '1.0.0'), ''),
    v9(entry('a', '1.0.0#x'), ''),
  ]) assert.equal(compare(undefined, bad), undefined, bad);
});

test('a reformat moves no packages', () => {
  const base = purify('3.4.17');
  const head = base.replace('  dompurify@3.4.17:', "  'dompurify@3.4.17':").replace(/\n\n/g, '\n').replace('{}', '{ }');
  assert.notEqual(head, base);
  assert.deepEqual(compare(base, head), []);
});

test('a lockfile pnpm 10 writes, an env lockfile ahead of the main one, is read whole', () => {
  const env = (v: string) => `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: ${v}
        version: ${v}

packages:
${entry('pnpm', v, "    engines: {node: '>=18'}\n    hasBin: true\n")}
snapshots:

  pnpm@${v}: {}

---
`;
  const head = env('10.2.0') + purify('3.4.17');
  assert.deepEqual(compare(env('10.1.0') + purify('3.4.11'), head)?.map((c) => [c.name, describeMove(c), c.line]), [
    ['dompurify', '3.4.11 → 3.4.17', lineOf(head, '  dompurify@3.4.17:')],
    ['pnpm', '10.1.0 → 10.2.0', lineOf(head, '  pnpm@10.2.0:')],
  ]);
});

test('an aliased dependency counts toward the real package', () => {
  const head = v9(entry('string-width', '4.2.3') + entry('wrap', '1.0.0'),
    '\n  string-width@4.2.3: {}\n\n  wrap@1.0.0:\n    dependencies:\n      string-width-cjs: string-width@4.2.3\n');
  assert.deepEqual(compare(undefined, head)?.find((c) => c.name === 'string-width')?.pulledBy, ['wrap']);
});

test('unparseable text, another lockfile version, or YAML pnpm never writes is not understood, on either side', () => {
  const ok = purify('3.4.17');
  for (const bad of [
    '', 'lockfileVersion: 5.4\n', "lockfileVersion: '5.4'\n\npackages:\n\n  /a/1.0.0:\n    resolution: {integrity: x}\n",
    "lockfileVersion: '10.0'\n", ok.replace("lockfileVersion: '9.0'", "lockfileVersion: '7.0'"), ok.replace("lockfileVersion: '9.0'\n", ''),
    ok.replace('  dompurify@3.4.17:', '\tdompurify@3.4.17:'),
    ok + entry('dompurify', '3.4.17'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: &r {integrity: x}'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: *r'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: !!map {integrity: x}'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, "resolution: '{integrity: x}'"),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: {integrity: x'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: {type: mystery}'),
    ok.replace('  dompurify@3.4.17:', '  "dompurify\\x40.4.17":'),
    ok.replace('  dompurify@3.4.17:\n', '  dompurify@3.4.17:\n    deprecated: "\\x41"\n'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: {integrity: "\\x41"}'),
    ok.replace(/resolution: \{integrity: ([^}]*)\}/, 'resolution: {integrity: $1 #, tarball: https://evil.example/a.tgz}'),
    ok.replace(/resolution: \{integrity: [^}]*\}/, 'resolution: {type: binary, url: https://evil.example/a.tgz}'),
    ok.replace(/resolution: \{integrity: ([^}]*)\}/, 'resolution:\n      integrity: $1\n      tarball: >-\n        https://evil.example/a.tgz'),
    ok.replace('  dompurify@3.4.17:\n', '  dompurify@3.4.17:\n    version: |\n      9.9.9\n'),
    ok.replace("lockfileVersion: '9.0'", "lockfileVersion: '9.1'"),
    ok.replace(/    resolution: \{integrity: [^}]*\}\n/, ''),
    ok.replace('  dompurify@3.4.17:', '  dompurify@3.4.17:\n   misaligned: true'),
    ok.replace('  dompurify@3.4.17:', '  <<: {}\n  dompurify@3.4.17:'),
    ok.replace('packages:\n', 'packages:\n  - dompurify@3.4.17\n'),
  ]) {
    assert.equal(compare(bad, ok), undefined, bad);
    assert.equal(compare(ok, bad), undefined, bad);
  }
});

test('a pathological line is read in linear time', () => {
  const spaces = ' '.repeat(200_000);
  const started = Date.now();
  for (const bad of [`  a${spaces}x:${spaces}x`, `    resolution: {a${spaces}b${spaces}`, `    resolution: {a: b${spaces}c${spaces}`]) {
    assert.equal(compare(undefined, purify('3.4.17').replace('  left-pad@1.3.0:', `${bad}\n  left-pad@1.3.0:`)), undefined);
  }
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test('fields the check never reads may be block lists or multi-line text', () => {
  const head = purify('3.4.17').replace('  dompurify@3.4.17:\n', `  dompurify@3.4.17:
    deprecated: >-
      Use the maintained fork: see
      https://example.com/notes: everything
    transitivePeerDependencies:
      - supports-color
`);
  assert.deepEqual(compare(purify('3.4.11'), head)?.map(describeMove), ['3.4.11 → 3.4.17']);
});

// Through the harness.

const REPO = 'acme/widgets';

async function opened(base: Record<string, string>, head: Record<string, string>, config: Partial<AppConfig> = {}) {
  const fx = gitFixture(base, head);
  const pr = { number: 85, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  github.advisoryDb.push({ id: 'GHSA-mrv2-3pqr-j5jr', severity: 'high', summary: 'DOMPurify allows XSS', firstPatched: '3.4.17',
    withdrawn: false, package: 'dompurify', versions: ['3.4.16'] });
  const model = new ScriptedModel(Array.from({ length: 5 }, noFindings));
  const t = testApp({ model, github, config });
  await t.app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await t.app.drain();
  return { review: github.reviews.at(-1)!.review, model, github, logs: t.logs };
}

test('a pnpm-lock.yaml change is listed in the summary, and its introduced Advisory posted on the package key line', async () => {
  const head = purify('3.4.16');
  const { review, model, github } = await opened({ 'web/pnpm-lock.yaml': purify('3.4.10') }, { 'web/pnpm-lock.yaml': head });

  assert.deepEqual(model.agents(), ['security']);
  assert.match(review.body, /Dependencies changed in `web\/pnpm-lock\.yaml`:\n- `dompurify 3\.4\.10 → 3\.4\.16`/);
  assert.ok(!review.body.includes('Not checked'), review.body);
  assert.deepEqual(review.comments.map((c) => [c.path, c.line, c.body.split('\n')[0]]),
    [['web/pnpm-lock.yaml', lineOf(head, '  dompurify@3.4.16:'), '**Advisory GHSA-mrv2-3pqr-j5jr in dompurify**']]);
  assert.deepEqual(github.lookups.sort(), ['dompurify@3.4.10', 'dompurify@3.4.16']);
});

test('a pnpm-lock.yaml of an unknown lockfile version is named as not understood and blocks approval', async () => {
  const { review } = await opened({ [PNPM]: purify('3.4.10') }, { [PNPM]: purify('3.4.17').replace("'9.0'", "'10.0'") },
    { approveWhenClean: true });
  assert.equal(review.event, 'COMMENT');
  assert.match(review.body, /Not understood by the dependency check: `pnpm-lock\.yaml`/);
  assert.match(review.body, /\*\*Not approved:\*\*[^\n]*the dependency check couldn't understand `pnpm-lock\.yaml`/);
});

test("an integrity-only package resolves from the registry the repo's .npmrc sets for its scope, or for every package", () => {
  const lock = v9(entry('@acme/ui', '1.0.0') + entry('dompurify', '3.4.17'), '');
  const resolved = (...npmrc: string[]) => compareLockfile(undefined, lock, PNPM, { head: npmrc })?.map((c) => [c.name, c.resolved]);
  assert.deepEqual(resolved('; private scope\n"@acme:registry" = "https://npm.acme.dev/"\n'), [
    ['@acme/ui', 'https://npm.acme.dev/@acme/ui/-/ui-1.0.0.tgz'],
    ['dompurify', 'https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz'],
  ]);
  // A registry's path can hold a token (Gemfury's does): only its host is kept, and a hash that tells paths apart.
  const [mirror, other] = ['registry=https://mirror.example/npm/', 'registry=https://mirror.example/other/'].map((n) => resolved(n)![1]![1]!);
  assert.match(mirror, /^https:\/\/mirror\.example\/…[0-9a-f]{12}\/dompurify\/-\/dompurify-3\.4\.17\.tgz$/);
  assert.notEqual(mirror, other);
  // npm's default however it is written; the last setting wins; npm ignores settings under a `[section]` header, but
  // only a whole header line starts one, and each file starts outside any.
  const npm = ['https://registry.npmjs.org/@acme/ui/-/ui-1.0.0.tgz', 'https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz'];
  assert.deepEqual(resolved('registry=https://mirror.example/\nregistry=HTTPS://registry.npmjs.org ; default\n[x]\nregistry=https://evil.example/')
    ?.map(([, r]) => r), npm);
  assert.deepEqual(resolved('registry=https://mirror.example/\n[x]', 'registry=https://registry.npmjs.org/')?.map(([, r]) => r), npm);
  assert.match(resolved('[x\nregistry=https://evil.example/')![1]![1]!, /^https:\/\/evil\.example\//);
  // A quoted value with a comment after it isn't quoted to npm: the quotes stay, and it isn't a URL.
  assert.match(resolved('registry="https://registry.npmjs.org/" ; c')![1]![1]!, /^unknown registry\//);
  // Credentials in the URL never reach `resolved`, nor does a value that isn't a URL; auth lines aren't read at all.
  for (const npmrc of [
    '//npm.acme.dev/:_authToken=SECRET\n@acme:registry=https://u:SECRET@npm.acme.dev/?t=SECRET\n',
    '@acme:registry=https://npm.acme.dev/SECRET/acme/', '@acme:registry=//u:SECRET@npm.acme.dev/',
  ]) assert.ok(!JSON.stringify(resolved(npmrc)).includes('SECRET'), npmrc);
  assert.equal(resolved('@acme:registry=https://u:SECRET@npm.acme.dev/?t=SECRET')?.[0]?.[1], 'https://npm.acme.dev/@acme/ui/-/ui-1.0.0.tgz');
  // A registry from the environment is unknowable: off-registry, from an unrecognised source.
  const env = compareLockfile(undefined, lock, PNPM, { head: ['registry=${NPM_REGISTRY}'] })!;
  assert.deepEqual(dependencyFindings({ lockfiles: [{ path: PNPM, changes: env }], unreadable: [], unchecked: [] })
    .map((f) => [f.title, /an unrecognised source/.test(f.evidence)]),
  [['@acme/ui resolves from outside the npm registry', true], ['dompurify resolves from outside the npm registry', true]]);
});

test(".npmrc at the root and next to the lockfile decide where a pnpm package resolves, and none of its secrets get out", async () => {
  const lock = (extra = '') => v9(entry('dompurify', '3.4.10') + extra, '');
  const npmrc = {
    '.npmrc': 'registry=https://mirror.example/\n//npm.acme.dev/:_authToken=SECRET\n@acme:registry=https://u:SECRET@npm.acme.dev/\n',
    // The lockfile's own directory overrides the root's repo-wide registry.
    'web/.npmrc': 'registry=https://registry.npmjs.org/\n',
  };
  const fx = await opened({ ...npmrc, 'web/pnpm-lock.yaml': lock() }, {
    ...npmrc, 'web/pnpm-lock.yaml': lock(entry('@acme/ui', '1.0.0') + entry('left-pad', '1.3.0')),
  });
  // Posting marks the scope's `@` so it mentions no one.
  assert.deepEqual(fx.review.comments.map((c) => c.body.split('\n')[0]), ['**@​acme/ui resolves from outside the npm registry**']);
  assert.match(fx.review.comments[0]!.body, /another registry on `npm\.acme\.dev`/);
  const seen = JSON.stringify([fx.review, fx.model.requests, fx.logs]);
  assert.ok(seen.includes('npm.acme.dev') && !seen.includes('SECRET'));
});

test('each side reads its own .npmrc: a PR that switches the registry moves every integrity-only package', () => {
  const lock = purify('3.4.17');
  assert.deepEqual(compareLockfile(lock, lock, PNPM, { head: ['registry=https://evil.example/'] })?.map(describeMove),
    ['3.4.17 (source or integrity changed)', '1.3.0 (source or integrity changed)']);
});
