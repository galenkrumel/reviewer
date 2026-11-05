// One eval run, shared by eval-reviewer.ts (one case) and eval-experiment.ts (every case as a Phoenix experiment): fetch a
// case's pinned commits, scope them and run the reviewer, with an LLM span per model call under whatever span is active.
// A malformed case, an unknown focus, an unsupported url or a missing required environment variable (OPENROUTER_API_KEY
// and REVIEW_MODEL always, GITHUB_TOKEN for a GitHub url) throws from loadCase, before any run.
import { SemanticConventions as SC, SpanStatusCode, trace } from '@arizeai/phoenix-otel';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openSource } from '../src/git.ts';
import { openRouter } from '../src/openrouter.ts';
import type { ChatMessage, ModelPort } from '../src/ports.ts';
import { FOCUSES, meteredChat, runReviewer, type Chat, type Focus } from '../src/reviewer.ts';
import { reviewScope } from '../src/scope.ts';
import type { Finding, RecordedInvocation } from '../src/store.ts';
import type { AnswerKey, Score } from './eval-score.ts';

// ponytail: mirrors app.ts's defaults (maxTurns, maxTokens, reviewTokenBudget); make them flags when evals vary them.
const MAX_TURNS = 20;
const MAX_TOKENS = 2_000_000;
const TOKEN_BUDGET = 50_000;

export type EvalCase = {
  id?: string; url: string; baseSha: string; headSha: string; title: string; body: string; focus: Focus; exclude?: string[];
} & Partial<AnswerKey>;

const env = () => {
  const { OPENROUTER_API_KEY: apiKey, REVIEW_MODEL: model, GITHUB_TOKEN = '' } = process.env;
  if (!apiKey || !model) throw new Error('set OPENROUTER_API_KEY and REVIEW_MODEL');
  return { apiKey, model, fallbackModel: process.env.REVIEW_FALLBACK_MODEL || undefined, githubToken: GITHUB_TOKEN };
};
/** The model runs are asked for, which is what experiments and spans are filtered by. */
export const reviewModel = () => env().model;

/** Reads and checks a case file. Its id names its runs: the file name unless "id" is set. */
export function loadCase(path: string) {
  const testCase = JSON.parse(readFileSync(path, 'utf8')) as EvalCase;
  if (!FOCUSES.includes(testCase.focus)) throw new Error(`${path}: focus must be one of ${FOCUSES.join(', ')}`);
  const local = testCase.url.startsWith('file://');
  if (!local && !testCase.url.startsWith('https://github.com/')) throw new Error(`${path}: url must be file:// or https://github.com/…`);
  if (!local && !env().githubToken) throw new Error('set GITHUB_TOKEN to fetch from GitHub');
  const key: AnswerKey | undefined = testCase.expected && {
    expected: testCase.expected, acceptableExtras: testCase.acceptableExtras, forbidden: testCase.forbidden,
  };
  return { caseId: testCase.id ?? basename(path, '.json'), testCase, key };
}

export interface RunResult {
  /** Undefined when the run failed; error says why. */
  findings?: Finding[];
  error?: string;
  transcript: ChatMessage[];
  usage: RecordedInvocation;
  calls: number;
}

const json = (key: 'input' | 'output', value: unknown) => key === 'input'
  ? { [SC.INPUT_VALUE]: JSON.stringify(value), [SC.INPUT_MIME_TYPE]: 'application/json' }
  : { [SC.OUTPUT_VALUE]: JSON.stringify(value), [SC.OUTPUT_MIME_TYPE]: 'application/json' };
export { json as spanJson };

/** Runs the reviewer on one case. Never throws: a fetching, scoping or reviewer error comes back as `error`. */
export async function runCase(testCase: EvalCase, dataDir: string): Promise<RunResult> {
  const { apiKey, model, fallbackModel, githubToken } = env();
  // openSource sends the token to the url's host, so it only ever goes to GitHub; a local repository gets none.
  const token = testCase.url.startsWith('file://') ? '' : githubToken;
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
  // Looked up per run, so it uses whichever provider the caller registered (register() or runExperiment).
  const tracer = trace.getTracer('reviewer-eval');

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

  const result = () => ({ transcript, usage, calls });
  try {
    // dataDir is reused across runs, so repeat runs reuse the repository copy instead of cloning again; the pinned
    // commits are still fetched each run. It is named after the url's last two segments, owner/repo for a GitHub url.
    const source = await openSource({
      dataDir, repo: testCase.url.replace(/\.git$/, '').split('/').slice(-2).join('/'),
      url: testCase.url, token, headSha: testCase.headSha, baseSha: testCase.baseSha,
    });
    const { diff } = await reviewScope(source, { exclude: testCase.exclude ?? [], tokenBudget: TOKEN_BUDGET });
    const findings = await runReviewer({
      focus: testCase.focus, chat, maxTurns: MAX_TURNS, source, diff, title: testCase.title, body: testCase.body,
    });
    return { findings, ...result() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ...result() };
  }
}

/**
 * Whether any served model differs from REVIEW_MODEL.
 * ponytail: prefix match, as OpenRouter may answer with a dated id; misses a fallback named after the primary.
 */
export const fellBack = (model: string, servedModels: string[]) => servedModels.some((m) => !m.startsWith(model));

/** Why a run scored as it did, in one line. */
export const explain = (s: Score) => [
  s.outcome,
  ...s.missed.map((id) => `missed ${id}`),
  ...Object.entries(s.matched).filter(([, m]) => !m.severityOk).map(([id, m]) => `${id} only ${m.severity}`),
  ...s.forbidden.map((t) => `forbidden "${t}"`),
  ...s.ambiguous.map((id) => `several findings on ${id}`),
  ...s.unreviewed.map((t) => `unreviewed "${t}"`),
].join('; ');

/** Throws when PHOENIX_API_KEY would go in the clear to a Phoenix endpoint other than this machine. */
export function checkPhoenixEndpoint(endpoint: string) {
  if (!process.env.PHOENIX_API_KEY) return;
  const { protocol, hostname } = new URL(endpoint);
  if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error(`Phoenix endpoint ${endpoint} must be https when PHOENIX_API_KEY is set, unless it is this machine`);
  }
}
