// Runs every case in cases/ as one Phoenix experiment, so a model or prompt change is one row on the dataset's
// Experiments tab, with a column per evaluator, and two experiments compare side by side case by case.
// Usage: OPENROUTER_API_KEY=… REVIEW_MODEL=… GITHUB_TOKEN="$(gh auth token)" node scripts/eval-experiment.ts [name]
// name defaults to REVIEW_MODEL. Phoenix is PHOENIX_COLLECTOR_ENDPOINT (or the phoenix-client's other variables),
// default http://localhost:6006, and must be running.
// First the cases are uploaded as the dataset "reviewer-cases", one example per case with its id: input is the case,
// expected output its answer key. Phoenix versions the dataset, so an edited case is a new version, not a new dataset.
// Then each case runs as in eval-reviewer.ts (see eval-run.ts), five at a time, and is scored by code-only evaluators:
//   passes      1 or 0: every expected defect found at its minimum severity, and nothing forbidden (eval-score.ts)
//   recall      the share of expected defects found at their minimum severity; none on a case expecting nothing
//   unreviewed  how many findings match neither a defect nor a ruled extra, so a human still has to look at them
//   cost        what OpenRouter billed, in USD, with the calls and served models in its metadata
// A run whose fetching, scoping or reviewer failed shows as failed in Phoenix, with its error, calls and cost, unscored.
import { getMergedOptions } from '@arizeai/phoenix-client';
import { createDataset } from '@arizeai/phoenix-client/datasets';
import { asExperimentEvaluator, runExperiment } from '@arizeai/phoenix-client/experiments';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '../src/store.ts';
import { checkPhoenixEndpoint, explain, fellBack, loadCase, reviewModel, runCase, type EvalCase } from './eval-run.ts';
import { score, type AnswerKey } from './eval-score.ts';

const DATASET = 'reviewer-cases';
const CASES = join(import.meta.dirname, '..', 'cases');

const model = reviewModel();
const experimentName = process.argv[2] ?? model;
// The client sends PHOENIX_API_KEY to its base url, which it resolves from several variables; check what it resolved.
checkPhoenixEndpoint(getMergedOptions().baseUrl!);

const cases = readdirSync(CASES).filter((f) => f.endsWith('.json')).sort().map((f) => loadCase(join(CASES, f)));
const { datasetId } = await createDataset({
  name: DATASET,
  description: 'Pinned PRs with answer keys for the reviewer, from cases/ in galenkrumel/reviewer',
  examples: cases.map(({ caseId, testCase, key }) => {
    const { expected, acceptableExtras, forbidden, ...input } = testCase;
    return { id: caseId, input: { case: caseId, ...input }, output: key ? { ...key } : null, metadata: { case: caseId, focus: testCase.focus } };
  }),
});

interface Output { findings: Finding[]; calls: number; cost: number; servedModels: string[]; fellBack: boolean }

type Result = { score: number | null; label?: string; explanation?: string; metadata?: Record<string, unknown> };
/** Phoenix runs evaluators on failed runs too, with no output; those get no score. */
const evaluator = (name: string, evaluate: (out: Output, key?: AnswerKey) => Result) => asExperimentEvaluator({
  name, kind: 'CODE',
  evaluate: ({ output, expected }) => output
    ? evaluate(output as unknown as Output, expected ? expected as unknown as AnswerKey : undefined)
    : { score: null, label: 'run failed' },
});
/** An evaluator that needs the run's score against the answer key; a case without one isn't scored. */
const keyed = (name: string, evaluate: (key: AnswerKey, out: Output) => Result) =>
  evaluator(name, (out, key) => key ? evaluate(key, out) : { score: null, label: 'no answer key' });

await runExperiment({
  dataset: { datasetId },
  experimentName,
  experimentMetadata: { model, fallbackModel: process.env.REVIEW_FALLBACK_MODEL || null },
  concurrency: 5,
  task: async (example) => {
    const { case: caseId, ...testCase } = example.input as EvalCase & { case: string };
    // A directory per case: runs go five at a time, and concurrent fetches into one repository copy would collide.
    const run = await runCase(testCase, join(tmpdir(), 'reviewer-eval', caseId));
    // Thrown, so Phoenix shows the run as failed; what it cost so far is only in the error and the trace.
    if (!run.findings) throw new Error(`${run.error} (after ${run.calls} calls, $${run.usage.cost.toFixed(4)})`);
    const servedModels = run.usage.models;
    return {
      findings: run.findings, calls: run.calls, cost: run.usage.cost, servedModels, fellBack: fellBack(model, servedModels),
    } satisfies Output;
  },
  evaluators: [
    keyed('passes', (key, out) => {
      const s = score(key, out.findings);
      return { score: Number(s.outcome === 'pass'), label: s.outcome, explanation: explain(s) };
    }),
    keyed('recall', (key, out) => {
      if (!key.expected.length) return { score: null, label: 'nothing expected' };
      const s = score(key, out.findings);
      const found = Object.values(s.matched).filter((m) => m.severityOk).length;
      return { score: found / key.expected.length, label: `${found}/${key.expected.length}`, explanation: explain(s) };
    }),
    keyed('unreviewed', (key, out) => {
      const { unreviewed } = score(key, out.findings);
      return { score: unreviewed.length, explanation: unreviewed.join('; ') };
    }),
    evaluator('cost', (out) => ({
      score: out.cost, label: `${out.calls} calls`,
      metadata: { calls: out.calls, servedModels: out.servedModels, fellBack: out.fellBack },
    })),
  ],
});
