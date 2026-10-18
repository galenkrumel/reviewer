import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { gitHubApp } from '../src/github.ts';
import { openRouter } from '../src/openrouter.ts';
import type { AssistantMessage } from '../src/ports.ts';
import {
  agentOf, delivery, FakeGitHub, gitFixture, noFindings, openedPayload, ScriptedModel, select, tempDir, testApp, toolCall,
} from './harness.ts';

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
  const results = model.requestsFor('correctness').at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content!);
  return { results, model };
}

test('read_file rejects traversal, absolute, missing and non-file paths', async () => {
  const { results } = await callTools([
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
  const { results } = await callTools([
    ['read_file', { path: 'escape' }],
    ['read_file', { path: 'up/secret.txt' }],
    ['list_dir', { path: 'up' }],
    ['grep', { pattern: 'host-secret' }],
  ]);
  for (const r of results.slice(0, 3)) assert.match(r, /^error: /);
  assert.ok(!results.join().includes(SECRET));
});

test('read_file returns a line range at head and rejects empty ranges', async () => {
  const { results: [range, whole, nulls, backwards, pastEnd] } = await callTools([
    ['read_file', { path: 'src/a.ts', start_line: 2, end_line: 3 }],
    ['read_file', { path: 'src/a.ts' }],
    ['read_file', { path: 'src/a.ts', start_line: null, end_line: null }],
    ['read_file', { path: 'src/a.ts', start_line: 3, end_line: 1 }],
    ['read_file', { path: 'src/a.ts', start_line: 5 }],
  ]);
  assert.match(range!, /needle here\nthree\n/);
  assert.ok(!range!.includes('one') && !range!.includes('four'));
  assert.match(whole!, /one\nneedle here\nthree\nfour/);
  assert.equal(nulls, whole);
  assert.match(backwards!, /^error: /);
  assert.match(pastEnd!, /^error: .*4 lines/);
});

test('grep and list_dir see only the head revision', async () => {
  const { results: [hits, globbed, baseOnly, root, src, srcSlash, nullPath] } = await callTools([
    ['grep', { pattern: 'needle' }],
    ['grep', { pattern: 'needle', glob: '**/*.md' }],
    ['grep', { pattern: 'basemarker' }],
    ['list_dir', {}],
    ['list_dir', { path: 'src' }],
    ['list_dir', { path: 'src/' }],
    ['list_dir', { path: null }],
  ]);
  assert.match(hits!, /src\/a\.ts:2:needle here/);
  assert.match(hits!, /docs\/notes\.md:1:needle in docs/);
  assert.ok(!globbed!.includes('src/a.ts'));
  assert.match(globbed!, /docs\/notes\.md/);
  assert.match(baseOnly!, /no matches/);
  assert.ok(!baseOnly!.includes('basemarker:'));
  for (const name of ['docs/', 'src/', 'gone.ts', 'escape', 'up']) assert.ok(root!.includes(name), name);
  assert.match(src!, /a\.ts/);
  assert.equal(srcSlash, src);
  assert.equal(nullPath, root);
});

test('diff is the reviewed base...head diff, optionally for one path', async () => {
  const { results: [full, one, bad, unknown], model } = await callTools([
    ['diff', {}],
    ['diff', { path: 'src/a.ts' }],
    ['diff', { path: '../x' }],
    ['diff', { path: 'nope.ts' }],
  ]);
  const reviewed = model.requestsFor('correctness')[0]!.messages[1]!.content!;
  const body = (s: string) => s.slice(s.indexOf('diff --git'), s.lastIndexOf('</untrusted-data>'));
  assert.equal(body(full!), body(reviewed));
  assert.match(one!, /-basemarker\n\+needle here/);
  assert.ok(!one!.includes('docs/notes.md'));
  assert.match(bad!, /^error: /);
  assert.match(unknown!, /^error: /);
});

test('credentials never appear in prompts, tool results, logs or run records', async (t) => {
  const logged: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, m, (...args: unknown[]) => void logged.push(inspect(args)));
  }
  const OPENROUTER_KEY = 'sk-or-v1-sentinel-openrouter-key';
  const TOKEN = 'ghs_fake_sentinel_installation_token';
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  // Real adapters over a faked network: GitHub mints TOKEN, OpenRouter replays turns per agent and then fails.
  const turns: Record<string, AssistantMessage[]> = {
    orchestrator: [select('correctness')],
    correctness: [
      toolCall('read_file', { path: '../../.git/config' }),
      toolCall('grep', { pattern: 'x', glob: '/etc/*' }),
      toolCall('list_dir', { path: 'nope' }),
      toolCall('diff', {}),
      toolCall('read_file', { path: 'src/a.ts' }),
      toolCall('report_findings', { findings: [] }),
    ],
    security: [noFindings()],
    documentation: [noFindings()],
  };
  const prompts: unknown[] = [];
  const auth: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    auth.push(new Headers(init.headers).get('authorization') ?? '');
    if (url.startsWith('https://api.github.com/')) return Response.json({ token: TOKEN });
    const req = JSON.parse(String(init.body));
    prompts.push(req);
    const turn = turns[agentOf(req)]?.shift();
    return turn ? Response.json({ choices: [{ message: turn }] }) : new Response('', { status: 500 });
  });
  const { pr, github } = setup();
  github.mintToken = gitHubApp('123', privateKey).mintToken;
  github.addPullRequest('acme/broken', 'file:///nonexistent/repo', { ...pr, number: 9 });
  github.addPullRequest(REPO, github.cloneUrl(REPO), { ...pr, number: 10 });
  const { app } = testApp({ model: openRouter(OPENROUTER_KEY), github, allowlist: [REPO, 'acme/broken'] });

  await app.receive(delivery('pull_request', openedPayload(REPO, pr))); // reviewed with every tool
  await app.receive(delivery('pull_request', openedPayload('acme/broken', { ...pr, number: 9 }))); // git fetch fails
  // OpenRouter fails: fallback selection, every reviewer fails, and a summary-only review names them (their errors are recorded).
  await app.receive(delivery('pull_request', openedPayload(REPO, { ...pr, number: 10 })));
  await app.drain();

  assert.deepEqual(app.runs().map((r) => r.status), ['nothing_to_publish', 'failed', 'published']);
  assert.ok(app.runs()[2]!.fallbackUsed);
  assert.deepEqual(app.runs()[2]!.focuses.map((f) => f.status), ['failed', 'failed', 'failed']);
  assert.ok(auth.includes(`Bearer ${OPENROUTER_KEY}`)); // the sentinels really were in play
  const recorded = JSON.stringify([prompts, app.runs(), logged]);
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const pemLine = privateKey.split('\n')[5]!;
  for (const secret of [TOKEN, basic, OPENROUTER_KEY, pemLine]) assert.ok(!recorded.includes(secret), secret);
});
