// The operator's read-only Dashboard of Runs: server-rendered HTML behind Basic auth, no client script.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isRedecision, type openStore, type RunStatus } from './store.ts';

type Store = ReturnType<typeof openStore>;

export interface DashboardRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface DashboardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const PAGE = 100;
const STATUSES: RunStatus[] = [
  'queued', 'running', 'published', 'nothing_to_publish', 'failed', 'superseded', 'stale', 'skipped',
];

/** Markup whose interpolations are already escaped. */
class Html {
  readonly s: string;
  constructor(s: string) { this.s = s; }
  toString() { return this.s; }
}

const escape = (v: unknown): string => v instanceof Html ? v.s
  : Array.isArray(v) ? v.map(escape).join('')
  : v === undefined || v === null || v === false ? ''
  : String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Escapes every interpolation: titles, evidence, paths, reasons and errors all come from PRs or models. */
const html = (strings: TemplateStringsArray, ...values: unknown[]) =>
  new Html(strings.reduce((out, s, i) => out + escape(values[i - 1]) + s));

const sha256 = (s: string) => createHash('sha256').update(s).digest();

function authorized(header: string | string[] | undefined, password: string): boolean {
  const m = typeof header === 'string' ? /^Basic\s+(\S+)$/i.exec(header) : null;
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString();
  const colon = decoded.indexOf(':');
  // Hashed first: timingSafeEqual needs equal lengths.
  return colon >= 0 && timingSafeEqual(sha256(decoded.slice(colon + 1)), sha256(password));
}

const positiveInt = (v: string | null) => (v && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : undefined);

/** "45s", "3m", "2h", "4d" since `iso`. */
function since(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;
const reviewLink = (repo: string, pr: number, reviewId: number | null) =>
  reviewId !== null && html`<a href="${prUrl(repo, pr)}#pullrequestreview-${reviewId}">review</a>`;
const kind = (event: string) => (isRedecision(event) ? html`re-decision · ${event}` : event.replace(/^pull_request\./, ''));

function status(r: { status: RunStatus; createdAt: string; updatedAt: string; ahead?: number | null }, now: Date) {
  if (r.status === 'queued') return html`queued${r.ahead ? html` · ${r.ahead} ahead` : ''} · ${since(r.createdAt, now)}`;
  // Claiming a run sets updated_at, so this is how long it has been running.
  if (r.status === 'running') return html`running · ${since(r.updatedAt, now)}`;
  return r.status;
}

function page(title: string, body: Html, refresh: boolean) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh && new Html('<meta http-equiv="refresh" content="15">')}
<title>${title}</title>
<style>
:root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
body { margin: 16px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 4px 8px; border-bottom: 1px solid #8884; }
code, pre { font: 12px ui-monospace, monospace; }
pre { white-space: pre-wrap; margin: 0; }
form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 12px; }
.err { color: #d33; }
</style></head><body>${body}</body></html>`.s;
}

function list(store: Store, q: URLSearchParams, now: Date) {
  const kindParam = q.get('kind');
  const f = {
    repo: q.get('repo')?.trim() || undefined,
    pr: positiveInt(q.get('pr')),
    status: STATUSES.find((s) => s === q.get('status')),
    kind: kindParam === 'full' || kindParam === 'redecision' ? kindParam : undefined,
  } as const;
  const { total, runs } = store.listRuns({ ...f, before: positiveInt(q.get('before')) }, PAGE);
  const older = new URLSearchParams(Object.entries(f).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
  older.set('before', String(runs.at(-1)?.id));
  const option = (value: string, current: string | undefined, label = value) =>
    html`<option value="${value}"${value === (current ?? '') ? new Html(' selected') : ''}>${label}</option>`;
  return page('Runs', html`
<h1>Runs</h1>
<form method="get" action="/admin">
  <label>Repo <input name="repo" value="${f.repo}" placeholder="owner/repo"></label>
  <label>PR <input name="pr" type="number" min="1" value="${f.pr}"></label>
  <label>Status <select name="status">${option('', f.status, 'any')}${STATUSES.map((s) => option(s, f.status))}</select></label>
  <label>Kind <select name="kind">${option('', f.kind, 'any')}${option('full', f.kind)}${option('redecision', f.kind, 're-decision')}</select></label>
  <button>Filter</button> <a href="/admin">Clear</a>
</form>
<p>Total cost of matching runs: ${usd(total)}</p>
<table>
<tr><th>Run</th><th>PR</th><th>Kind</th><th>Status</th><th>Head</th><th>Created</th><th>Cost</th><th></th></tr>
${runs.map((r) => html`<tr>
  <td><a href="/admin/runs/${r.id}">${r.id}</a></td>
  <td><a href="${prUrl(r.repo, r.pr)}">${r.repo}#${r.pr}</a> ${r.title}</td>
  <td>${kind(r.event)}</td>
  <td>${status(r, now)}</td>
  <td><code>${r.headSha.slice(0, 7)}</code></td>
  <td>${since(r.createdAt, now)} ago</td>
  <td>${usd(r.cost)}</td>
  <td>${reviewLink(r.repo, r.pr, r.reviewId)}</td>
</tr>`)}
</table>
${runs.length === PAGE && html`<p><a href="/admin?${older.toString()}">Older</a></p>`}`, true);
}

function detail(store: Store, id: number, now: Date) {
  const r = store.runDetail(id);
  if (!r) return;
  const cost = r.invocations.reduce((sum, i) => sum + i.cost, 0);
  const section = (title: string, items: unknown[], body: Html) => items.length > 0 && html`<h2>${title}</h2>${body}`;
  return page(`Run ${r.id}`, html`
<p><a href="/admin">← Runs</a></p>
<h1>Run ${r.id}: <a href="${prUrl(r.repo, r.pr)}">${r.repo}#${r.pr}</a> ${r.title}</h1>
<table>
<tr><th>Status</th><td>${status(r, now)} ${reviewLink(r.repo, r.pr, r.reviewId)}</td></tr>
<tr><th>Event</th><td>${kind(r.event)} · delivery <code>${r.deliveryId}</code></td></tr>
<tr><th>Head</th><td><code>${r.headSha}</code></td></tr>
<tr><th>Base</th><td><code>${r.baseSha}</code></td></tr>
<tr><th>Created</th><td>${r.createdAt} (${since(r.createdAt, now)} ago)</td></tr>
<tr><th>Updated</th><td>${r.updatedAt} (${since(r.updatedAt, now)} ago)</td></tr>
<tr><th>Cost</th><td>${usd(cost)}</td></tr>
${r.error && html`<tr><th>Error</th><td class="err"><pre>${r.error}</pre></td></tr>`}
${r.fallbackUsed && html`<tr><th>Orchestrator</th><td class="err">fallback selection used${r.orchestratorError && html`: ${r.orchestratorError}`}</td></tr>`}
${r.blockers && html`<tr><th>Blockers</th><td>${r.blockers.length ? r.blockers.join('; ') : 'none'}</td></tr>`}
</table>
${section('Focuses', r.focuses, html`<table><tr><th>Focus</th><th>Status</th><th>Reason</th></tr>
${r.focuses.map((f) => html`<tr><td>${f.focus}</td><td${f.status === 'failed' ? new Html(' class="err"') : ''}>${f.status}${f.error && html`: ${f.error}`}</td><td>${f.reason}</td></tr>`)}</table>`)}
${section('Findings', r.findings, html`<table><tr><th>Outcome</th><th>Severity</th><th>Confidence</th><th>Focus</th><th>Where</th><th>Finding</th></tr>
${r.findings.map((f) => html`<tr><td>${f.outcome}</td><td>${f.severity}</td><td>${f.confidence}</td><td>${(f.focuses ?? [f.focus]).join(', ')}</td>
<td><code>${f.path}:${f.start_line !== undefined ? `${f.start_line}-` : ''}${f.line}</code></td>
<td><strong>${f.title}</strong><pre>${f.evidence}</pre>${f.suggested_fix && html`<details><summary>Suggested fix</summary><pre>${f.suggested_fix}</pre></details>`}</td></tr>`)}</table>`)}
${section('Agents', r.invocations, html`<table><tr><th>Agent</th><th>Models</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr>
${r.invocations.map((i) => html`<tr><td>${i.agent}</td><td>${i.models.join(' → ')}</td><td>${i.inputTokens}</td><td>${i.outputTokens}</td><td>${usd(i.cost)}</td></tr>`)}</table>`)}
${section('Config warnings', r.configWarnings, html`<ul>${r.configWarnings.map((w) => html`<li>${w}</li>`)}</ul>`)}
${section('Skipped files (over the review budget)', r.skipped, html`<ul>${r.skipped.map((p) => html`<li><code>${p}</code></li>`)}</ul>`)}
${section('Waived on this PR so far', r.waivers, html`<ul>${r.waivers.map((w) => html`<li>${w.title} (<code>${w.path}${w.line !== null ? `:${w.line}` : ''}</code>), waived by ${w.by}</li>`)}</ul>`)}`,
  r.status === 'queued' || r.status === 'running');
}

const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Serves `/admin` (the Run list) and `/admin/runs/:id`, or undefined for any other path. 404 while no password is set. */
export function createDashboard(store: Store, password: string | undefined, now: () => Date) {
  return (req: DashboardRequest): DashboardResponse | undefined => {
    // A malformed request-target is not the Dashboard's; new URL would throw on it.
    if (!URL.canParse(req.url ?? '/', 'http://localhost')) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return;
    const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
      ({ status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', ...headers }, body });
    if (!password) return respond(404);
    if (!authorized(req.headers.authorization, password)) {
      return respond(401, '', { 'WWW-Authenticate': 'Basic realm="reviewer", charset="UTF-8"' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(405, '', { Allow: 'GET, HEAD' });
    if (url.pathname === '/admin') return respond(200, list(store, url.searchParams, now()));
    const id = positiveInt(/^\/admin\/runs\/([^/]+)$/.exec(url.pathname)?.[1] ?? null);
    const body = id && detail(store, id, now());
    return body ? respond(200, body) : respond(404);
  };
}
