// Runs one reviewer focus on one pinned PR, outside the App, and prints what it found and how it got there (#88).
// Usage: OPENROUTER_API_KEY=… REVIEW_MODEL=… GITHUB_TOKEN="$(gh auth token)" node scripts/eval-reviewer.ts case.json [--json]
// case.json: { "id"?, "url", "baseSha", "headSha", "title", "body", "focus", "exclude"?: [globs] }. url is file:// or
// https://github.com/…; GITHUB_TOKEN is only needed for the latter. REVIEW_FALLBACK_MODEL is optional, as in the App.
// A missing argument, malformed case JSON, an unknown focus, an unsupported url or a missing required environment
// variable (OPENROUTER_API_KEY and REVIEW_MODEL always, GITHUB_TOKEN for a GitHub url) throws before the run, as does
// a PHOENIX_API_KEY with a Phoenix endpoint that is plain http to anywhere but this machine.
// The run prints a summary: the result, calls, cost and models, a line per finding, and the Phoenix trace id. With
// --json it prints { findings | error, score?, transcript, usage } instead, for when Phoenix isn't running or to pipe into jq.
// A fetching, scoping or reviewer error exits 1.
// A case with "expected" (and optional "acceptableExtras", "forbidden"; see eval-score.ts) is an answer key: the run is
// scored against it in code, the score is printed (and is "score" in the --json output), and a failed score exits 2.
// It also traces the run to Phoenix (PHOENIX_COLLECTOR_ENDPOINT, default http://localhost:6006; project reviewer-eval):
// one AGENT span named after the case id (its file name unless "id" is set), with an LLM span per model call. Its
// metadata: case, focus, headSha, model (REVIEW_MODEL), servedModels (the models that answered) and fellBack (whether
// any of them doesn't start with REVIEW_MODEL), and the run's calls, inputTokens, outputTokens and cost (what OpenRouter
// billed; Phoenix's own cost column is an estimate from its price list). A scored run also gets an "answer-key"
// annotation: label pass, fail or error, score 1 or 0 (none for error), what was missed or unreviewed, and model, calls
// and cost as its metadata. Without a Phoenix server the spans are dropped.
import { register, SemanticConventions as SC, SpanStatusCode, trace } from '@arizeai/phoenix-otel';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openSource } from '../src/git.ts';
import { openRouter } from '../src/openrouter.ts';
import type { ChatMessage, ModelPort } from '../src/ports.ts';
import { FOCUSES, meteredChat, runReviewer, type Chat, type Focus } from '../src/reviewer.ts';
import { reviewScope } from '../src/scope.ts';
import type { Finding, RecordedInvocation } from '../src/store.ts';
import { score, type AnswerKey, type Score } from './eval-score.ts';

// ponytail: mirrors app.ts's defaults (maxTurns, maxTokens, reviewTokenBudget); make them flags when evals vary them.
const MAX_TURNS = 20;
const MAX_TOKENS = 2_000_000;
const TOKEN_BUDGET = 50_000;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const casePath = args.find((a) => a !== '--json');
if (!casePath) throw new Error('usage: eval-reviewer.ts case.json [--json]');
const testCase = JSON.parse(readFileSync(casePath, 'utf8')) as {
  id?: string; url: string; baseSha: string; headSha: string; title: string; body: string; focus: Focus; exclude?: string[];
} & Partial<AnswerKey>;
const key: AnswerKey | undefined = testCase.expected && {
  expected: testCase.expected, acceptableExtras: testCase.acceptableExtras, forbidden: testCase.forbidden,
};
// The span name, so every run of a case groups under one name in Phoenix.
const caseId = testCase.id ?? basename(casePath, '.json');
if (!FOCUSES.includes(testCase.focus)) throw new Error(`focus must be one of ${FOCUSES.join(', ')}`);
const { OPENROUTER_API_KEY: apiKey, REVIEW_MODEL: model, GITHUB_TOKEN = '' } = process.env;
const fallbackModel = process.env.REVIEW_FALLBACK_MODEL || undefined;
if (!apiKey || !model) throw new Error('set OPENROUTER_API_KEY and REVIEW_MODEL');
// openSource sends the token to the url's host, so it only ever goes to GitHub; a local repository gets none.
const local = testCase.url.startsWith('file://');
if (!local && !testCase.url.startsWith('https://github.com/')) throw new Error('url must be file:// or https://github.com/…');
if (!local && !GITHUB_TOKEN) throw new Error('set GITHUB_TOKEN to fetch from GitHub');
const token = local ? '' : GITHUB_TOKEN;

const usage: RecordedInvocation = { agent: testCase.focus, models: [], inputTokens: 0, outputTokens: 0, cost: 0 };
// The model that served the last call, which is the fallback when OpenRouter fell back.
let served = model;
const router = openRouter(apiKey);
const port: ModelPort = {
  listModels: () => router.listModels(),
  chat: async (req) => {
    const res = await router.chat(req);
    served = res.model;
    return res;
  },
};
const metered = meteredChat(port, { model, fallbackModel, maxTokens: MAX_TOKENS }, `eval-${testCase.focus}`, usage);
// runTools passes the same growing array on every turn, so the last one seen is the whole conversation.
let transcript: ChatMessage[] = [];
let calls = 0;

const phoenix = (process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006').replace(/\/(v1\/traces\/?)?$/, '');
const phoenixKey = process.env.PHOENIX_API_KEY;
// Both the trace exporter and the annotation send PHOENIX_API_KEY to this endpoint, so never in the clear off this machine.
if (phoenixKey) {
  const { protocol, hostname } = new URL(phoenix);
  if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error('PHOENIX_COLLECTOR_ENDPOINT must be https when PHOENIX_API_KEY is set, unless it is this machine');
  }
}
const projectName = process.env.PHOENIX_PROJECT ?? 'reviewer-eval';
const provider = register({ projectName });
const tracer = trace.getTracer('reviewer-eval');
const json = (key: 'input' | 'output', value: unknown) => key === 'input'
  ? { [SC.INPUT_VALUE]: JSON.stringify(value), [SC.INPUT_MIME_TYPE]: 'application/json' }
  : { [SC.OUTPUT_VALUE]: JSON.stringify(value), [SC.OUTPUT_MIME_TYPE]: 'application/json' };

// Tool results show up in the next call's input messages, so there are no separate tool spans.
const chat: Chat = (messages, tools) => tracer.startActiveSpan('chat', async (span) => {
  transcript = messages;
  calls++;
  const before = { input: usage.inputTokens, output: usage.outputTokens, cost: usage.cost };
  span.setAttributes({ [SC.OPENINFERENCE_SPAN_KIND]: 'LLM', [SC.LLM_MODEL_NAME]: model, ...json('input', messages) });
  try {
    const reply = await metered(messages, tools);
    span.setAttributes({
      ...json('output', reply), [SC.LLM_MODEL_NAME]: served,
      [SC.LLM_TOKEN_COUNT_PROMPT]: usage.inputTokens - before.input,
      [SC.LLM_TOKEN_COUNT_COMPLETION]: usage.outputTokens - before.output,
      [SC.LLM_COST_TOTAL]: usage.cost - before.cost,
    });
    return reply;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
});

/** Why a run scored as it did, in one line: the summary's score line and the annotation's explanation. */
const explain = (s: Score) => [
  s.outcome,
  ...s.missed.map((id) => `missed ${id}`),
  ...Object.entries(s.matched).filter(([, m]) => !m.severityOk).map(([id, m]) => `${id} only ${m.severity}`),
  ...s.forbidden.map((t) => `forbidden "${t}"`),
  ...s.ambiguous.map((id) => `several findings on ${id}`),
  ...s.unreviewed.map((t) => `unreviewed "${t}"`),
].join('; ');

// The run span's id and score, for the annotation once the span has been exported.
let spanId = '';
let scored: Score | undefined;

await tracer.startActiveSpan(caseId, async (span) => {
  spanId = span.spanContext().spanId;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const report = (outcome: string, details: string[]) => {
    const served = usage.models.length ? `, served by ${usage.models.join(', ')}` : '';
    console.log(`${caseId}: ${outcome}, ${plural(calls, 'call')}, $${usage.cost.toFixed(4)}${served}`);
    for (const line of details) console.log(`  ${line}`);
    console.log(`trace ${span.spanContext().traceId} in Phoenix project ${projectName}`);
  };
  span.setAttributes({
    [SC.OPENINFERENCE_SPAN_KIND]: 'AGENT', [SC.AGENT_NAME]: testCase.focus, ...json('input', testCase),
  });
  // model stays one identifier to filter on; servedModels, fellBack and the usage totals are set once the calls are done.
  const metadata = (servedModels: string[]) => ({
    [SC.METADATA]: JSON.stringify({
      case: caseId, focus: testCase.focus, headSha: testCase.headSha, model, servedModels,
      // ponytail: prefix match, as OpenRouter may answer with a dated id; misses a fallback named after the primary.
      fellBack: servedModels.some((m) => !m.startsWith(model)),
      calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: usage.cost,
    }),
  });
  span.setAttributes(metadata([]));
  try {
    // A fixed directory, so repeat runs reuse the repository copy instead of cloning again; the pinned commits are still
    // fetched each run. It is named after the url's last two segments, which are owner/repo for a GitHub url.
    const source = await openSource({
      dataDir: join(tmpdir(), 'reviewer-eval'), repo: testCase.url.replace(/\.git$/, '').split('/').slice(-2).join('/'),
      url: testCase.url, token, headSha: testCase.headSha, baseSha: testCase.baseSha,
    });
    const { diff } = await reviewScope(source, { exclude: testCase.exclude ?? [], tokenBudget: TOKEN_BUDGET });
    const findings = await runReviewer({
      focus: testCase.focus, chat, maxTurns: MAX_TURNS, source, diff, title: testCase.title, body: testCase.body,
    });
    span.setAttributes(json('output', findings));
    scored = key && score(key, findings);
    if (asJson) console.log(JSON.stringify({ findings, score: scored, transcript, usage }, null, 2));
    else {
      const lines = findings.map((f) => `[${f.severity}] ${f.path}:${f.line} ${f.title}`);
      report(plural(findings.length, 'finding'), scored ? [...lines, `score: ${explain(scored)}`] : lines);
    }
    if (scored?.outcome === 'fail') process.exitCode = 2;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    const error = err instanceof Error ? err.message : String(err);
    scored = key && score(key, undefined);
    if (asJson) console.log(JSON.stringify({ error, score: scored, transcript, usage }, null, 2));
    else report('failed', [...error.trim().split('\n'), ...(scored ? [`score: ${explain(scored)}`] : [])]);
    process.exitCode = 1;
  } finally {
    span.setAttributes(metadata(usage.models));
    span.end();
  }
});
// Spans are batched, so flush them before the script exits.
await provider.shutdown();

// After the flush, so Phoenix has the span to annotate. A failure here only warns: the run and its spans are done.
if (scored) {
  const result = {
    label: scored.outcome, score: scored.outcome === 'error' ? null : Number(scored.outcome === 'pass'), explanation: explain(scored),
  };
  try {
    const res = await fetch(`${phoenix}/v1/span_annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(phoenixKey ? { authorization: `Bearer ${phoenixKey}` } : {}) },
      body: JSON.stringify({ data: [{
        span_id: spanId, name: 'answer-key', annotator_kind: 'CODE', result, metadata: { model, calls, cost: usage.cost },
      }] }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`could not annotate the run in Phoenix: ${err instanceof Error ? err.message : String(err)}`);
  }
}
