// Entry point: deployment config from env, real adapters, HTTP webhook endpoint, in-process worker.
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { gitHubApp } from './github.ts';
import { openRouter } from './openrouter.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const app = createApp({
  config: {
    webhookSecret: env('GITHUB_WEBHOOK_SECRET'),
    allowlist: env('REPO_ALLOWLIST').split(',').map((r) => r.trim()).filter(Boolean),
    model: env('REVIEW_MODEL'),
    dataDir: process.env.DATA_DIR ?? './data',
  },
  // Env vars often carry PEM newlines escaped.
  github: gitHubApp(env('GITHUB_APP_ID'), env('GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n')),
  model: openRouter(env('OPENROUTER_API_KEY')),
  clock: { now: () => new Date() },
});

const kick = () => app.drain().catch((err) => console.error('worker error', err));

createServer((req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    try {
      const { status } = await app.receive({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status).end();
      kick();
    } catch (err) {
      console.error('webhook error', err);
      res.writeHead(500).end();
    }
  });
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`listening on ${process.env.PORT ?? 3000}`));

kick();
