import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, openedPayload, ScriptedModel, tempDir, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';
const SECRET = 'host-secret-do-not-leak';

function setup() {
  const outside = join(tempDir(), 'secret.txt');
  writeFileSync(outside, SECRET);
  const fx = gitFixture(
    { 'src/a.ts': 'one\nbasemarker\nthree\n', 'gone.ts': 'deleted later\n' },
    {
      'src/a.ts': 'one\nneedle here\nthree\nfour\n',
      'docs/notes.md': 'needle in docs\n',
      'escape': { symlink: outside },
      'up': { symlink: '../..' },
    },
  );
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  return { fx, pr, github };
}

/** Run one review whose reviewer makes the given tool calls; return each tool result in order. */
async function callTools(calls: [string, unknown][]) {
  const { pr, github } = setup();
  const model = new ScriptedModel([
    ...calls.map(([name, args]) => toolCall(name, args)),
    toolCall('report_findings', { findings: [] }),
  ]);
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();
  assert.equal(app.runs()[0]!.status, 'nothing_to_publish');
  return model.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content!);
}

test('read_file rejects traversal, absolute, missing and non-file paths', async () => {
  const results = await callTools([
    ['read_file', { path: '../secret.txt' }],
    ['read_file', { path: 'src/../../secret.txt' }],
    ['read_file', { path: '/etc/passwd' }],
    ['read_file', { path: 'nope.ts' }],
    ['read_file', { path: 'src' }],
    ['read_file', { path: '' }],
  ]);
  for (const r of results) assert.match(r, /^error: /);
  assert.ok(!results.join().includes('root:'));
});

test('symlinks do not expose content outside the repo', async () => {
  const results = await callTools([
    ['read_file', { path: 'escape' }],
    ['read_file', { path: 'up/secret.txt' }],
    ['list_dir', { path: 'up' }],
    ['grep', { pattern: 'host-secret' }],
  ]);
  for (const r of results.slice(0, 3)) assert.match(r, /^error: /);
  assert.ok(!results.join().includes(SECRET));
});

test('read_file returns a line range at head', async () => {
  const [range, whole] = await callTools([
    ['read_file', { path: 'src/a.ts', start_line: 2, end_line: 3 }],
    ['read_file', { path: 'src/a.ts' }],
  ]);
  assert.match(range!, /needle here\nthree\n/);
  assert.ok(!range!.includes('one') && !range!.includes('four'));
  assert.match(whole!, /one\nneedle here\nthree\nfour/);
});

test('grep and list_dir see only the head revision', async () => {
  const [hits, globbed, baseOnly, root, src] = await callTools([
    ['grep', { pattern: 'needle' }],
    ['grep', { pattern: 'needle', glob: '**/*.md' }],
    ['grep', { pattern: 'basemarker' }],
    ['list_dir', {}],
    ['list_dir', { path: 'src' }],
  ]);
  assert.match(hits!, /src\/a\.ts:2:needle here/);
  assert.match(hits!, /docs\/notes\.md:1:needle in docs/);
  assert.ok(!globbed!.includes('src/a.ts'));
  assert.match(globbed!, /docs\/notes\.md/);
  assert.match(baseOnly!, /no matches/);
  assert.ok(!baseOnly!.includes('basemarker:'));
  for (const name of ['docs/', 'src/', 'gone.ts', 'escape', 'up']) assert.ok(root!.includes(name), name);
  assert.match(src!, /a\.ts/);
});

test('diff is the reviewed base...head diff, optionally for one path', async () => {
  const { pr, github } = setup();
  const model = new ScriptedModel([
    toolCall('diff', {}),
    toolCall('diff', { path: 'src/a.ts' }),
    toolCall('diff', { path: '../x' }),
    toolCall('report_findings', { findings: [] }),
  ]);
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();

  const reviewed = model.requests[0]!.messages[1]!.content!;
  const [full, one, bad] = model.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content!);
  const body = (s: string) => s.slice(s.indexOf('diff --git'), s.lastIndexOf('</untrusted-data>'));
  assert.equal(body(full!), body(reviewed));
  assert.match(one!, /-basemarker\n\+needle here/);
  assert.ok(!one!.includes('docs/notes.md'));
  assert.match(bad!, /^error: /);
});

test('credentials never appear in prompts, tool results, logs or run records', async (t) => {
  const logged: unknown[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, m, (...args: unknown[]) => void logged.push(args));
  }
  const { pr, github } = setup();
  const model = new ScriptedModel([
    toolCall('read_file', { path: '../../.git/config' }),
    toolCall('grep', { pattern: 'x', glob: '/etc/*' }),
    toolCall('list_dir', { path: 'nope' }),
    toolCall('diff', {}),
    toolCall('report_findings', { findings: [] }),
  ]);
  const { app } = testApp({ model, github });
  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();
  // A run whose git fetch fails records an error.
  github.addPullRequest('acme/broken', 'file:///nonexistent/repo', { ...pr, number: 9 });
  const { app: broken } = testApp({ model: new ScriptedModel([]), github, allowlist: ['acme/broken'] });
  await broken.receive(delivery('pull_request', openedPayload('acme/broken', { ...pr, number: 9 })));
  await broken.drain();
  assert.equal(broken.runs()[0]!.status, 'failed');

  const token = await github.mintToken(42);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const recorded = JSON.stringify([model.requests, app.runs(), broken.runs(), logged.map(String)]);
  assert.ok(!recorded.includes(token));
  assert.ok(!recorded.includes(basic));
});
