// Runs one reviewer focus on one pinned PR, outside the App, and prints what it found and how it got there (#88).
// For every case at once, as a Phoenix experiment, see eval-experiment.ts.
// Usage: OPENROUTER_API_KEY=… REVIEW_MODEL=… GITHUB_TOKEN="$(gh auth token)" node scripts/eval-reviewer.ts case.json [--json]
// case.json: { "id"?, "url", "baseSha", "headSha", "title", "body", "focus", "exclude"?: [globs] }. url is file:// or
// https://github.com/…; GITHUB_TOKEN is only needed for the latter. REVIEW_FALLBACK_MODEL is optional, as in the App.
// A missing argument or a bad case or environment throws before the run (see eval-run.ts), as does a PHOENIX_API_KEY
// with a Phoenix endpoint that is plain http to anywhere but this machine.
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPhoenixEndpoint, explain, fellBack, loadCase, reviewModel, runCase, spanJson as json, type RunResult } from './eval-run.ts';
import { score, type Score } from './eval-score.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const casePath = args.find((a) => a !== '--json');
if (!casePath) throw new Error('usage: eval-reviewer.ts case.json [--json]');
const { caseId, testCase, key } = loadCase(casePath);
const model = reviewModel();

const phoenix = (process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006').replace(/\/(v1\/traces\/?)?$/, '');
const phoenixKey = process.env.PHOENIX_API_KEY;
// Both the trace exporter and the annotation send PHOENIX_API_KEY to this endpoint.
checkPhoenixEndpoint(phoenix);
const projectName = process.env.PHOENIX_PROJECT ?? 'reviewer-eval';
const provider = register({ projectName });
const tracer = trace.getTracer('reviewer-eval');

// The run span's id, the run and its score, for the annotation once the span has been exported.
let spanId = '';
let run: RunResult | undefined;
let scored: Score | undefined;

await tracer.startActiveSpan(caseId, async (span) => {
  spanId = span.spanContext().spanId;
  span.setAttributes({
    [SC.OPENINFERENCE_SPAN_KIND]: 'AGENT', [SC.AGENT_NAME]: testCase.focus, ...json('input', testCase),
  });
  // model stays one identifier to filter on; servedModels, fellBack and the usage totals are set once the calls are done.
  const metadata = (r?: RunResult) => ({
    [SC.METADATA]: JSON.stringify({
      case: caseId, focus: testCase.focus, headSha: testCase.headSha, model, servedModels: r?.usage.models ?? [],
      fellBack: fellBack(model, r?.usage.models ?? []), calls: r?.calls ?? 0, inputTokens: r?.usage.inputTokens ?? 0,
      outputTokens: r?.usage.outputTokens ?? 0, cost: r?.usage.cost ?? 0,
    }),
  });
  span.setAttributes(metadata());
  // A fixed directory, so repeat runs reuse the repository copy instead of cloning again.
  const r = run = await runCase(testCase, join(tmpdir(), 'reviewer-eval'));
  scored = key && score(key, r.findings);
  if (r.findings) span.setAttributes(json('output', r.findings));
  else {
    span.recordException(new Error(r.error));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.setAttributes(metadata(r));
  span.end();

  if (asJson) {
    const result = r.findings ? { findings: r.findings } : { error: r.error };
    console.log(JSON.stringify({ ...result, score: scored, transcript: r.transcript, usage: r.usage }, null, 2));
  } else {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const servedBy = r.usage.models.length ? `, served by ${r.usage.models.join(', ')}` : '';
    const outcome = r.findings ? plural(r.findings.length, 'finding') : 'failed';
    console.log(`${caseId}: ${outcome}, ${plural(r.calls, 'call')}, $${r.usage.cost.toFixed(4)}${servedBy}`);
    const lines = r.findings?.map((f) => `[${f.severity}] ${f.path}:${f.line} ${f.title}`) ?? r.error!.trim().split('\n');
    for (const line of [...lines, ...(scored ? [`score: ${explain(scored)}`] : [])]) console.log(`  ${line}`);
    console.log(`trace ${span.spanContext().traceId} in Phoenix project ${projectName}`);
  }
  process.exitCode = r.error ? 1 : scored?.outcome === 'fail' ? 2 : 0;
});
// Spans are batched, so flush them before the script exits.
await provider.shutdown();

// After the flush, so Phoenix has the span to annotate. A failure here only warns: the run and its spans are done.
if (scored && run) {
  const result = {
    label: scored.outcome, score: scored.outcome === 'error' ? null : Number(scored.outcome === 'pass'), explanation: explain(scored),
  };
  try {
    const res = await fetch(`${phoenix}/v1/span_annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(phoenixKey ? { authorization: `Bearer ${phoenixKey}` } : {}) },
      body: JSON.stringify({ data: [{
        span_id: spanId, name: 'answer-key', annotator_kind: 'CODE', result,
        metadata: { model, calls: run.calls, cost: run.usage.cost },
      }] }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`could not annotate the run in Phoenix: ${err instanceof Error ? err.message : String(err)}`);
  }
}
