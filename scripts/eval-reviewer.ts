// Runs one reviewer focus on one pinned PR, outside the App, and prints what it found and how it got there (#88).
// Usage: OPENROUTER_API_KEY=… REVIEW_MODEL=… GITHUB_TOKEN="$(gh auth token)" node scripts/eval-reviewer.ts case.json
// case.json: { "url", "baseSha", "headSha", "title", "body", "focus", "exclude"?: [globs] }. GITHUB_TOKEN is only
// needed for a remote url. Prints { findings | error, transcript, usage } as JSON; exits 1 when the reviewer fails.
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
const c = JSON.parse(readFileSync(casePath, 'utf8')) as {
  url: string; baseSha: string; headSha: string; title: string; body: string; focus: Focus; exclude?: string[];
};
if (!FOCUSES.includes(c.focus)) throw new Error(`focus must be one of ${FOCUSES.join(', ')}`);
const { OPENROUTER_API_KEY: apiKey, REVIEW_MODEL: model, GITHUB_TOKEN: token = '' } = process.env;
if (!apiKey || !model) throw new Error('set OPENROUTER_API_KEY and REVIEW_MODEL');
if (!token && !c.url.startsWith('file://')) throw new Error('set GITHUB_TOKEN to fetch a remote url');

// A fixed directory, so repeat runs reuse the repository copy and only fetch missing commits.
const source = await openSource({
  dataDir: join(tmpdir(), 'reviewer-eval'), repo: c.url.replace(/\.git$/, '').split('/').slice(-2).join('/'),
  url: c.url, token, headSha: c.headSha, baseSha: c.baseSha,
});
const { diff } = await reviewScope(source, { exclude: c.exclude ?? [], tokenBudget: TOKEN_BUDGET });

const usage: RecordedInvocation = { agent: c.focus, models: [], inputTokens: 0, outputTokens: 0, cost: 0 };
const metered = meteredChat(openRouter(apiKey), { model, maxTokens: MAX_TOKENS }, `eval-${c.focus}`, usage);
// runTools passes the same growing array on every turn, so the last one seen is the whole conversation.
let transcript: ChatMessage[] = [];
const chat: Chat = (messages, tools) => { transcript = messages; return metered(messages, tools); };

try {
  const findings = await runReviewer({
    focus: c.focus, chat, maxTurns: MAX_TURNS, source, diff, title: c.title, body: c.body,
  });
  console.log(JSON.stringify({ findings, transcript, usage }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err), transcript, usage }, null, 2));
  process.exitCode = 1;
}
