// Runs one reviewer focus on one pinned PR, outside the App, and prints what it found and how it got there (#88).
// Usage: OPENROUTER_API_KEY=… REVIEW_MODEL=… GITHUB_TOKEN="$(gh auth token)" node scripts/eval-reviewer.ts case.json
// case.json: { "url", "baseSha", "headSha", "title", "body", "focus", "exclude"?: [globs] }. url is file:// or
// https://github.com/…; GITHUB_TOKEN is only needed for the latter. REVIEW_FALLBACK_MODEL is optional, as in the App.
// A bad argument, case or environment variable throws before anything runs. After that, prints
// { findings | error, transcript, usage } as JSON, exiting 1 when fetching, scoping or the reviewer fails.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSource } from '../src/git.ts';
import { openRouter } from '../src/openrouter.ts';
import type { ChatMessage } from '../src/ports.ts';
import { FOCUSES, meteredChat, runReviewer, type Chat, type Focus } from '../src/reviewer.ts';
import { reviewScope } from '../src/scope.ts';
import type { RecordedInvocation } from '../src/store.ts';

// ponytail: mirrors app.ts's defaults (maxTurns, maxTokens, reviewTokenBudget); make them flags when evals vary them.
const MAX_TURNS = 20;
const MAX_TOKENS = 2_000_000;
const TOKEN_BUDGET = 50_000;

const [casePath] = process.argv.slice(2);
if (!casePath) throw new Error('usage: eval-reviewer.ts case.json');
const testCase = JSON.parse(readFileSync(casePath, 'utf8')) as {
  url: string; baseSha: string; headSha: string; title: string; body: string; focus: Focus; exclude?: string[];
};
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
const metered = meteredChat(
  openRouter(apiKey), { model, fallbackModel, maxTokens: MAX_TOKENS }, `eval-${testCase.focus}`, usage,
);
// runTools passes the same growing array on every turn, so the last one seen is the whole conversation.
let transcript: ChatMessage[] = [];
const chat: Chat = (messages, tools) => { transcript = messages; return metered(messages, tools); };

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
  console.log(JSON.stringify({ findings, transcript, usage }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err), transcript, usage }, null, 2));
  process.exitCode = 1;
}
