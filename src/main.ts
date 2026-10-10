// Entry point: deployment config from env, real adapters, HTTP webhook endpoint, in-process worker.
import { createServer } from 'node:http';
import { createApp, type OutsidePolicy } from './app.ts';
import { gitHubApp } from './github.ts';
import { openRouter } from './openrouter.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function outsidePolicy(): OutsidePolicy | undefined {
  const v = process.env.REVIEW_OUTSIDE_PRS;
  if (v === undefined || v === 'label' || v === 'always' || v === 'never') return v;
  throw new Error(`REVIEW_OUTSIDE_PRS must be label, always or never, not ${v}`);
}

function runCap(): number | undefined {
  const v = process.env.RUN_CAP;
  if (v === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`RUN_CAP must be a positive integer, not ${v}`);
  return Number(v);
}

const app = createApp({
  config: {
    webhookSecret: env('GITHUB_WEBHOOK_SECRET'),
    allowlist: env('REPO_ALLOWLIST').split(',').map((r) => r.trim()).filter(Boolean),
    model: env('REVIEW_MODEL'),
    dataDir: process.env.DATA_DIR ?? './data',
    reviewOutsidePrs: outsidePolicy(),
    reviewLabel: process.env.REVIEW_LABEL || undefined,
    runCap: runCap(),
    maxReviewableLines: Number(process.env.MAX_REVIEWABLE_LINES) || undefined,
    reviewTokenBudget: Number(process.env.REVIEW_TOKEN_BUDGET) || undefined,
  },
  // Env vars often carry PEM newlines escaped.
  github: gitHubApp(env('GITHUB_APP_ID'), env('GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n')),
  model: openRouter(env('OPENROUTER_API_KEY')),
  clock: { now: () => new Date() },
});

const kick = () => app.drain().catch((err) => console.error('worker error', err));

// GitHub caps webhook payloads at 25 MB; anything bigger is not GitHub.
const MAX_BODY = 25 * 1024 * 1024;

createServer((req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { Connection: 'close' }).end();
      req.destroy();
    } else chunks.push(c);
  });
  req.on('end', async () => {
    try {
      const { status, ignored } = await app.receive({ headers: req.headers, body: Buffer.concat(chunks) });
      if (ignored) console.log(`ignored delivery ${req.headers['x-github-delivery']}: ${ignored}`);
      res.writeHead(status).end();
      kick();
    } catch (err) {
      console.error('webhook error', err);
      res.writeHead(500).end();
    }
  });
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`listening on ${process.env.PORT ?? 3000}`));

kick();
