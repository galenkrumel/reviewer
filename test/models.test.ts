import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery, FakeGitHub, gitFixture, noFindings, openedPayload, ScriptedModel, select, testApp, toolCall } from './harness.ts';
import type { AppConfig } from '../src/app.ts';
import type { AssistantMessage } from '../src/ports.ts';

const REPO = 'acme/widgets';

async function review(turns: Record<string, AssistantMessage[]>, config: Partial<AppConfig> = {}, served?: string) {
  const fx = gitFixture({ 'src/math.ts': 'export const two = 2;\n' }, { 'src/math.ts': 'export const two = 3;\n' });
  const pr = { number: 7, state: 'open' as const, draft: false, headSha: fx.headSha, baseSha: fx.baseSha };
  const github = new FakeGitHub();
  github.addPullRequest(REPO, fx.url, pr);
  const model = new ScriptedModel(turns);
  model.served = served;
  const { app } = testApp({ model, github, config });
  await app.receive(delivery('pull_request', openedPayload(REPO, pr)));
  await app.drain();
  return { model, run: app.runs()[0]!, reviews: github.reviews };
}

const readFile = () => toolCall('read_file', { path: 'src/math.ts' });
const info = (id: string, params = ['tools', 'temperature']) => ({ id, supported_parameters: params });

test('the startup check fails naming the agent and model when a configured model lacks tool support', async () => {
  const model = new ScriptedModel([]);
  model.catalog = [info('test/model'), info('sec/model'), info('sec/backup', ['temperature'])];
  const { app } = testApp({ model, config: { agents: { security: { model: 'sec/model', fallbackModel: 'sec/backup' } } } });
  await assert.rejects(app.checkModels(), /security.*sec\/backup.*tools/);

  model.catalog[2] = info('sec/backup');
  await app.checkModels();

  // A model OpenRouter doesn't list fails too.
  const missing = testApp({ model, config: { agents: { orchestrator: { model: 'gone/model' } } } });
  await assert.rejects(missing.app.checkModels(), /orchestrator.*gone\/model/);
});

test('each agent calls its configured model with the fallback passed through', async () => {
  const { model } = await review(
    { orchestrator: [select('correctness')], correctness: [noFindings()], security: [noFindings()] },
    { fallbackModel: 'test/backup', agents: { security: { model: 'sec/model', fallbackModel: 'sec/backup' } } },
  );
  const [orch] = model.requestsFor('orchestrator');
  assert.equal(orch!.model, 'test/model');
  assert.deepEqual(orch!.models, ['test/model', 'test/backup']);
  const [sec] = model.requestsFor('security');
  assert.equal(sec!.model, 'sec/model');
  assert.deepEqual(sec!.models, ['sec/model', 'sec/backup']);
  // Every call carries the PR as its OpenRouter session, URL-safe so the dashboard can filter on it.
  assert.ok(model.requests.every((r) => r.session_id === 'acme--widgets--pr-7'));

  // No fallback configured: no models array.
  const plain = await review({ orchestrator: [select('correctness')], correctness: [noFindings()], security: [noFindings()] });
  assert.equal(plain.model.requests[0]!.models, undefined);
});

test('every agent invocation records the model that served it, its tokens and its cost', async () => {
  const { run } = await review(
    { orchestrator: [select('correctness')], correctness: [readFile(), noFindings()], security: [noFindings()] },
    {},
    'served/model',
  );
  assert.deepEqual(run.invocations, [
    { agent: 'orchestrator', models: ['served/model'], inputTokens: 100, outputTokens: 20, cost: 0.001 },
    { agent: 'correctness', models: ['served/model'], inputTokens: 200, outputTokens: 40, cost: 0.002 },
    { agent: 'security', models: ['served/model'], inputTokens: 100, outputTokens: 20, cost: 0.001 },
    { agent: 'documentation', models: ['served/model'], inputTokens: 100, outputTokens: 20, cost: 0.001 },
  ]);
});

for (const [budget, config] of [
  ['turn', { agents: { correctness: { maxTurns: 2 } } }],
  ['token', { agents: { correctness: { maxTokens: 150 } } }],
] as const) {
  test(`a reviewer over its ${budget} budget fails without a retry, and the others still publish`, async () => {
    const { model, run, reviews } = await review({
      orchestrator: [select('correctness')],
      correctness: [readFile(), readFile(), readFile()],
      security: [toolCall('report_findings', { findings: [{
        title: 'bad', severity: 'high', confidence: 0.9, path: 'src/math.ts', line: 1, evidence: 'Wrong.',
      }] })],
    }, config);
    assert.equal(model.requestsFor('correctness').length, 2);
    const correctness = run.focuses.find((f) => f.focus === 'correctness')!;
    assert.equal(correctness.status, 'failed');
    assert.match(correctness.error!, new RegExp(`${budget} budget`));
    assert.equal(run.status, 'published');
    assert.equal(reviews[0]!.review.comments.length, 1);
    assert.match(reviews[0]!.review.body, /Failed focuses: correctness/);
    // The failed invocation's spend is still recorded.
    assert.equal(run.invocations.find((i) => i.agent === 'correctness')!.inputTokens, 200);
  });
}
