import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, gitFixture, prPayload, ScriptedModel, testApp, toolCall } from './harness.ts';

const REPO = 'acme/widgets';
const PASSWORD = 'pa:ss';
const auth = (password = PASSWORD) => ({ authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` });
const get = (app: ReturnType<typeof testApp>['app'], url: string, headers: Record<string, string> = auth()) =>
  app.dashboard({ method: 'GET', url, headers });

const XSS = '<img src=x onerror=alert(1)>';

function setup() {
  const fx = gitFixture({ 'src/math.ts': 'export const two = 2;\n' }, { 'src/math.ts': 'export const two = 3;\n' });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const report = toolCall('report_findings', { findings: [{
    title: `two is ${XSS}`, severity: 'high', confidence: 0.9, path: 'src/math.ts', line: 1, evidence: `<script>x</script>`,
  }] });
  const t = testApp({ model: new ScriptedModel([report]), config: { adminPassword: PASSWORD } });
  t.github.addPullRequest(REPO, fx.url, pr);
  return { ...t, pr };
}

test('the dashboard is not served without a password, and only under /admin', () => {
  const { app } = testApp({ model: new ScriptedModel([]) });
  assert.equal(get(app, '/admin')!.status, 404);
  assert.equal(get(app, '/admin/runs/1')!.status, 404);
  assert.equal(get(app, '/administrator'), undefined);
  assert.equal(get(app, '/'), undefined);
});

test('the dashboard needs the password', () => {
  const { app } = setup();
  const none = get(app, '/admin', {})!;
  assert.equal(none.status, 401);
  assert.match(none.headers['WWW-Authenticate']!, /^Basic/);
  assert.equal(get(app, '/admin', auth('wrong'))!.status, 401);
  assert.equal(get(app, '/admin', { authorization: 'Bearer x' })!.status, 401);
  assert.equal(get(app, '/admin')!.status, 200);
  assert.equal(app.dashboard({ method: 'POST', url: '/admin', headers: auth() })!.status, 405);
});

test('a published run is listed and detailed with everything PR-controlled escaped', async () => {
  const { app, pr } = setup();
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr, {}, { title: `Fix ${XSS}` })));
  await app.drain();
  const id = app.runs()[0]!.id;

  const list = get(app, '/admin')!;
  assert.equal(list.status, 200);
  assert.match(list.headers['Content-Security-Policy']!, /default-src 'none'/);
  assert.ok(list.body.includes(`href="/admin/runs/${id}"`));
  assert.ok(list.body.includes('Fix &#60;img src=x onerror=alert(1)&#62;'));
  assert.ok(list.body.includes('#pullrequestreview-'));

  const detail = get(app, `/admin/runs/${id}`)!;
  assert.equal(detail.status, 200);
  assert.ok(detail.body.includes('&#60;script&#62;x&#60;/script&#62;'));
  assert.ok(detail.body.includes('published'));
  assert.ok(detail.body.includes('correctness matters here'), 'focus reason');
  for (const body of [list.body, detail.body]) {
    assert.ok(!body.includes('<img'), 'no raw markup from the PR');
    assert.ok(!body.includes('<script'), 'no raw markup from the PR');
  }
});

test('queued runs show their place in line, and the list filters and pages', async () => {
  const { app, pr } = setup();
  await app.receive(delivery('pull_request', prPayload('opened', REPO, pr)));
  await app.receive(delivery('pull_request', prPayload('opened', REPO, { ...pr, number: 8 })));

  const list = get(app, '/admin')!.body;
  assert.ok(list.includes('queued · 1 ahead'));
  assert.ok(list.includes('<meta http-equiv="refresh"'));
  const rows = (url: string) => get(app, url)!.body.match(/href="\/admin\/runs\/\d+"/g) ?? [];
  assert.equal(rows('/admin').length, 2);
  assert.equal(rows('/admin?pr=8').length, 1);
  assert.equal(rows('/admin?repo=ACME/widgets').length, 2);
  assert.equal(rows('/admin?status=published').length, 0);
  assert.equal(rows('/admin?kind=redecision').length, 0);
  assert.equal(rows('/admin?kind=full').length, 2);
  assert.deepEqual(rows('/admin?before=2'), ['href="/admin/runs/1"']);
  assert.ok(get(app, `/admin?repo=${encodeURIComponent('"><b>')}`)!.body.includes('value="&#34;&#62;&#60;b&#62;"'));
});

test('an unknown or malformed run id is not found', () => {
  const { app } = setup();
  assert.equal(get(app, '/admin/runs/99')!.status, 404);
  assert.equal(get(app, '/admin/runs/abc')!.status, 404);
  assert.equal(get(app, '/admin/runs/1/x')!.status, 404);
});
