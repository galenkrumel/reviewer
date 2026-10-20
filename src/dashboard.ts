// The operator's read-only Dashboard of Runs: server-rendered HTML behind Basic auth, no client script.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isRedecision, type openStore, type PrState, type RunStatus } from './store.ts';

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
/** Pill colour per status; the rest are neutral. */
const TONE: Partial<Record<RunStatus, string>> = { queued: 'blue', running: 'amber live', published: 'green', failed: 'red' };
/** Statuses named for what happened on GitHub; the rest read as they are. */
const LABEL: Partial<Record<RunStatus, string>> = {
  published: 'review posted', nothing_to_publish: 'nothing posted', superseded: 'cancelled',
};
/** Runs that did nothing on GitHub, shown muted. */
const QUIET: RunStatus[] = ['nothing_to_publish', 'superseded', 'stale', 'skipped'];
const PR_STATES: PrState[] = ['open', 'draft', 'merged', 'closed'];
const PR_TONE: Record<PrState, string> = { open: 'green', draft: '', merged: 'purple', closed: 'red' };
/** What started a run, in plain words; re-decisions are tagged as such. */
const KIND: Record<string, string> = {
  'pull_request.opened': 'opened', 'pull_request.synchronize': 'push', 'pull_request.reopened': 'reopened',
  'pull_request.ready_for_review': 'ready for review', 'pull_request.edited': 'base changed',
  'pull_request.labeled': 're-review label', 'pull_request_review_thread.resolved': 'thread resolved',
  'pull_request_review_comment.created': '"Waive:" reply',
};

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

const usd = (n: number) => `$${n.toFixed(3)}`;
const label = (s: RunStatus) => LABEL[s] ?? s.replaceAll('_', ' ');
/** A pill for a status that wants attention; routine ones are plain muted text. */
const pill = (tone: string | undefined, text: unknown) =>
  tone ? html`<span class="pill ${tone}">${text}</span>` : html`<span class="muted">${text}</span>`;
const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;
const reviewUrl = (repo: string, pr: number, reviewId: number) => `${prUrl(repo, pr)}#pullrequestreview-${reviewId}`;
/** The Dashboard's page for a PR. Repo names are [A-Za-z0-9._-] and one slash, so they need no encoding. */
const prPath = (repo: string, pr: number) => `/admin/prs/${repo}/${pr}`;
/** The Verdict as a pill linking to its Review. */
const verdict = (repo: string, pr: number, reviewId: number | null, approved: boolean | null) =>
  reviewId === null || approved === null ? '—'
  : html`<a class="pill ${approved ? 'green' : ''}" href="${reviewUrl(repo, pr, reviewId)}">${approved ? 'approved' : 'commented'} ↗</a>`;
const kind = (event: string) => {
  const text = KIND[event] ?? event.replace(/^pull_request\./, '');
  return isRedecision(event) ? html`${text} <span class="tag">re-decision</span>` : text;
};
/** The PR state as a coloured dot and word; nothing for a PR whose state was never recorded. */
const prState = (state: PrState | null) =>
  state && html`<span class="state ${PR_TONE[state]}">${state[0]!.toUpperCase() + state.slice(1)}</span>`;
/** A PR as its title over a muted `repo #n` line; the owner is in the tooltip. */
const prCell = (r: { repo: string; pr: number; title: string; prState: PrState | null }) =>
  html`<a href="${prPath(r.repo, r.pr)}">${r.title}</a>
  <div class="sub"><span title="${r.repo}#${r.pr}">${r.repo.slice(r.repo.indexOf('/') + 1)} #${r.pr}</span>${prState(r.prState)}</div>`;
const quiet = (s: RunStatus) => QUIET.includes(s) && new Html(' class="quiet"');

function status(r: {
  status: RunStatus; event: string; repo: string; pr: number; reviewId: number | null; approved?: boolean | null;
  createdAt: string; updatedAt: string; ahead?: number | null;
}, now: Date) {
  if (r.status === 'published' && r.reviewId !== null) {
    const text = r.approved == null ? 'review posted' : `review posted · ${r.approved ? 'approved' : 'commented'}`;
    return html`<a class="muted" href="${reviewUrl(r.repo, r.pr, r.reviewId)}">${text} ↗</a>`;
  }
  // A re-decision that posts nothing kept the approval decision as it was.
  const p = pill(TONE[r.status], r.status === 'nothing_to_publish' && isRedecision(r.event) ? 'no change' : label(r.status));
  if (r.status === 'queued') return html`${p} <span class="muted">${r.ahead ? html`${r.ahead} ahead · ` : ''}${since(r.createdAt, now)}</span>`;
  // Claiming a run sets updated_at, so this is how long it has been running.
  if (r.status === 'running') return html`${p} <span class="muted">${since(r.updatedAt, now)}</span>`;
  return p;
}

// Pinned with its hash: the stylesheet is third-party, and the page must still work if it never loads.
const FONT = 'https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.2.8/';
const FONT_SRI = 'sha384-ZTIcl2CmY0wyM9ANOhomBco7rEUIlWztf6lGcLKCocKUrIgGCsfisuZyE+hadW8K';

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fafafa; --surface: #fff; --hover: #f4f4f5; --border: #e4e4e7; --text: #18181b; --muted: #71717a;
  --accent: #4f46e5; --on-accent: #fff; --green: #15803d; --red: #dc2626; --amber: #b45309; --blue: #2563eb; --purple: #8250df;
  font: 14px/1.5 'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-feature-settings: 'cv11', 'ss01';
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b; --surface: #121214; --hover: #1c1c1f; --border: #27272a; --text: #fafafa; --muted: #a1a1aa;
    --accent: #818cf8; --on-accent: #09090b; --green: #4ade80; --red: #f87171; --amber: #fbbf24; --blue: #60a5fa; --purple: #a371f7;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
a:hover { color: var(--accent); }
.wrap { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
.top { position: sticky; top: 0; z-index: 1; background: color-mix(in srgb, var(--surface) 85%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.top .wrap { display: flex; align-items: center; gap: 24px; height: 52px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -0.01em; }
.brand::before { content: ''; width: 18px; height: 18px; border-radius: 5px;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 40%, var(--blue))); }
nav { display: flex; gap: 4px; }
nav a { padding: 6px 10px; border-radius: 6px; color: var(--muted); font-weight: 500; }
nav a:hover { color: var(--text); background: var(--hover); }
nav a[aria-current] { color: var(--text); background: var(--hover); }
main.wrap { padding-block: 28px 64px; }
h1 { font-size: 22px; line-height: 1.3; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; }
h2 { font-size: 15px; font-weight: 600; margin: 32px 0 12px; }
.eyebrow { color: var(--muted); font-size: 13px; margin-bottom: 4px; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; color: var(--muted); margin: 8px 0 20px; }
.meta strong { color: var(--text); font-weight: 500; }
.muted { color: var(--muted); }
.ext { color: var(--accent); font-weight: 500; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 9px 12px; border-bottom: 1px solid var(--border); }
tr:last-child > td, tr:last-child > th { border-bottom: 0; }
thead th, .grid th { font-size: 12px; font-weight: 500; color: var(--muted); white-space: nowrap; background: var(--hover); }
.grid tr:hover > td { background: var(--hover); }
.kv th { width: 140px; color: var(--muted); font-weight: 500; white-space: nowrap; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.ref { font-weight: 500; white-space: nowrap; }
.sub { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 2px; font-size: 12px; color: var(--muted); }
.state { --tone: var(--muted); display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--tone); }
code, pre { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--hover); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; }
pre { white-space: pre-wrap; margin: 4px 0 0; color: var(--muted); }
details summary { cursor: pointer; color: var(--accent); margin-top: 6px; font-size: 13px; }
ul.card { list-style: none; padding: 0; margin: 0; }
ul.card li { padding: 9px 12px; border-bottom: 1px solid var(--border); }
ul.card li:last-child { border-bottom: 0; }
.pill { --tone: var(--muted); display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--tone);
  background: color-mix(in srgb, var(--tone) 12%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent); }
.green { --tone: var(--green); } .red { --tone: var(--red); } .amber { --tone: var(--amber); } .blue { --tone: var(--blue); }
.purple { --tone: var(--purple); }
a.pill:hover { color: var(--tone); background: color-mix(in srgb, var(--tone) 22%, transparent); }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.quiet > td { opacity: 0.55; }
.live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.4s infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .live::before { animation: none; } }
.err { color: var(--red); }
form { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 16px; padding: 12px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
form label { display: grid; gap: 4px; font-size: 12px; font-weight: 500; color: var(--muted); }
form label.check { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--text); height: 34px; }
input, select, button, .btn { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border);
  border-radius: 6px; height: 34px; padding: 0 10px; }
input[type=checkbox] { height: auto; accent-color: var(--accent); }
input:focus, select:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; }
button { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 500; cursor: pointer; }
button:hover { filter: brightness(1.1); }
.btn { display: inline-flex; align-items: center; font-weight: 500; }
.btn:hover { background: var(--hover); color: var(--text); }
.ghost { display: inline-flex; align-items: center; height: 34px; color: var(--muted); }
.more { margin-top: 16px; }
@media (max-width: 640px) {
  .top .wrap { gap: 12px; }
  main.wrap { padding-top: 20px; }
  form label:not(.check) { flex: 1 1 140px; }
  input:not([type=checkbox]), select { width: 100%; }
}
`;

/** `current` marks the nav item for the page's section. */
function page(title: string, current: 'prs' | 'runs' | undefined, body: Html, refresh: boolean) {
  const item = (key: typeof current, href: string, text: string) =>
    html`<a href="${href}"${key === current ? new Html(' aria-current="page"') : ''}>${text}</a>`;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh && new Html('<meta http-equiv="refresh" content="15">')}
<title>${title} · reviewer</title>
<link rel="stylesheet" href="${FONT}index.css" integrity="${FONT_SRI}" crossorigin="anonymous">
<style>${new Html(CSS)}</style></head><body>
<header class="top"><div class="wrap"><a class="brand" href="/admin">reviewer</a>
<nav>${item('prs', '/admin', 'PRs')}${item('runs', '/admin/runs', 'All runs')}</nav></div></header>
<main class="wrap">${body}</main></body></html>`.s;
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
  const option = (value: string, current: string | undefined, text = value) =>
    html`<option value="${value}"${value === (current ?? '') ? new Html(' selected') : ''}>${text}</option>`;
  return page('Runs', 'runs', html`
<h1>All runs</h1>
<div class="meta">Total cost of matching runs <strong>${usd(total)}</strong></div>
<form method="get" action="/admin/runs">
  <label>Repo <input name="repo" value="${f.repo}" placeholder="owner/repo"></label>
  <label>PR <input name="pr" type="number" min="1" value="${f.pr}"></label>
  <label>Status <select name="status">${option('', f.status, 'any')}${STATUSES.map((s) => option(s, f.status, label(s)))}</select></label>
  <label>Kind <select name="kind">${option('', f.kind, 'any')}${option('full', f.kind)}${option('redecision', f.kind, 're-decision')}</select></label>
  <button>Filter</button> <a class="ghost" href="/admin/runs">Clear</a>
</form>
${runTable(runs, now)}
${runs.length === PAGE && html`<p class="more"><a class="btn" href="/admin/runs?${older.toString()}">Older</a></p>`}`, true);
}

/** Runs as table rows; `withPr` false on a PR's own page, whose heading names it. */
function runTable(runs: ReturnType<Store['listRuns']>['runs'], now: Date, withPr = true) {
  return html`<div class="card"><table class="grid">
<tr><th>Run</th>${withPr && html`<th>PR</th>`}<th>Kind</th><th>Reviewers</th><th>Status</th><th>Head</th><th>Created</th><th class="num">Cost</th></tr>
${runs.map((r) => html`<tr${quiet(r.status)}>
  <td><a class="ref" href="/admin/runs/${r.id}">${r.id}</a></td>
  ${withPr && html`<td>${prCell(r)}</td>`}
  <td class="nowrap">${kind(r.event)}</td>
  <td>${r.focuses.length ? r.focuses.map((f, i) => html`${i > 0 && ', '}${f.status === 'failed' ? html`<span class="err">${f.focus} (failed)</span>` : f.focus}`) : '—'}</td>
  <td class="nowrap">${status(r, now)}</td>
  <td><code>${r.headSha.slice(0, 7)}</code></td>
  <td class="nowrap muted">${since(r.createdAt, now)} ago</td>
  <td class="num">${usd(r.cost)}</td>
</tr>`)}
</table></div>`;
}

/** The home page: PRs by their latest run. */
function prList(store: Store, q: URLSearchParams, now: Date) {
  const f = {
    repo: q.get('repo')?.trim() || undefined,
    active: q.get('active') === '1' || undefined,
    state: PR_STATES.find((s) => s === q.get('state')),
  };
  const prs = store.listPrs({ ...f, before: positiveInt(q.get('before')) }, PAGE);
  const option = (value: string, text: string) =>
    html`<option value="${value}"${value === (f.state ?? '') ? new Html(' selected') : ''}>${text}</option>`;
  const older = new URLSearchParams(Object.entries(f).flatMap(([k, v]) => (v === undefined ? [] : [[k, v === true ? '1' : v]])));
  older.set('before', String(prs.at(-1)?.id));
  return page('PRs', 'prs', html`
<h1>PRs</h1>
<div class="meta">Pull requests by their latest run</div>
<form method="get" action="/admin">
  <label>Repo <input name="repo" value="${f.repo}" placeholder="owner/repo"></label>
  <label>State <select name="state">${option('', 'any')}${PR_STATES.map((s) => option(s, s))}</select></label>
  <label class="check"><input type="checkbox" name="active" value="1"${f.active ? new Html(' checked') : ''}> Active only</label>
  <button>Filter</button> <a class="ghost" href="/admin">Clear</a>
</form>
<div class="card"><table class="grid">
<tr><th>PR</th><th>Latest run</th><th>Verdict</th><th>Last active</th><th class="num">Runs</th><th class="num">Cost</th></tr>
${prs.map((p) => html`<tr>
  <td>${prCell(p)}</td>
  <td class="nowrap"><a class="ref" href="/admin/runs/${p.id}">${p.id}</a> <span class="muted">${kind(p.event)} ·</span> ${status({ ...p, approved: null }, now)}</td>
  <td class="nowrap">${verdict(p.repo, p.pr, p.reviewId, p.approved)}</td>
  <td class="nowrap muted">${since(p.updatedAt, now)} ago</td>
  <td class="num">${p.runs}</td>
  <td class="num">${usd(p.cost)}</td>
</tr>`)}
</table></div>
${prs.length === PAGE && html`<p class="more"><a class="btn" href="/admin?${older.toString()}">Older</a></p>`}`, true);
}

/** One PR: its runs, newest first, and the waivers recorded on it so far. */
function prDetail(store: Store, repo: string, pr: number, q: URLSearchParams, now: Date) {
  const latest = store.listPrs({ repo, pr }, 1)[0];
  if (!latest) return;
  const { total, runs } = store.listRuns({ repo, pr, before: positiveInt(q.get('before')) }, PAGE);
  const waivers = store.waivers(latest.repo, pr);
  return page(`${latest.repo}#${pr}`, 'prs', html`
<div class="eyebrow"><a class="ext" href="${prUrl(latest.repo, pr)}">${latest.repo}#${pr} ↗</a></div>
<h1>${latest.title}</h1>
<div class="meta">${latest.prState && html`<span>${prState(latest.prState)} ${since(latest.prStateAt!, now)} ago</span>`}
<span>Verdict ${verdict(latest.repo, pr, latest.reviewId, latest.approved)}</span>
<span>Total cost <strong>${usd(total)}</strong></span></div>
${runTable(runs, now, false)}
${runs.length === PAGE && html`<p class="more"><a class="btn" href="${prPath(repo, pr)}?before=${runs.at(-1)!.id}">Older</a></p>`}
${waivers.length > 0 && html`<h2>Waived on this PR</h2>
<ul class="card">${waivers.map((w) => html`<li>${w.title} <code>${w.path}${w.line !== null ? `:${w.line}` : ''}</code> <span class="muted">waived by ${w.by}${w.reason ? `: ${w.reason}` : ''}</span></li>`)}</ul>`}`, true);
}

function detail(store: Store, id: number, now: Date) {
  const r = store.runDetail(id);
  if (!r) return;
  const cost = r.invocations.reduce((sum, i) => sum + i.cost, 0);
  const section = (title: string, items: unknown[], body: Html) => items.length > 0 && html`<h2>${title}</h2>${body}`;
  return page(`Run ${r.id}`, 'runs', html`
<div class="eyebrow"><a class="ref" href="${prPath(r.repo, r.pr)}">${r.repo}#${r.pr}</a> ${r.title}</div>
<h1>Run ${r.id}</h1>
<div class="card" style="margin-top: 20px"><table class="kv">
<tr><th>Status</th><td>${status(r, now)}</td></tr>
<tr><th>Event</th><td>${kind(r.event)} · delivery <code>${r.deliveryId}</code></td></tr>
<tr><th>Head</th><td><code>${r.headSha}</code></td></tr>
<tr><th>Base</th><td><code>${r.baseSha}</code></td></tr>
<tr><th>Created</th><td>${r.createdAt} <span class="muted">(${since(r.createdAt, now)} ago)</span></td></tr>
<tr><th>Updated</th><td>${r.updatedAt} <span class="muted">(${since(r.updatedAt, now)} ago)</span></td></tr>
<tr><th>Cost</th><td>${usd(cost)}</td></tr>
${r.error && html`<tr><th>Error</th><td class="err"><pre class="err">${r.error}</pre></td></tr>`}
${r.fallbackUsed && html`<tr><th>Orchestrator</th><td class="err">fallback selection used${r.orchestratorError && html`: ${r.orchestratorError}`}</td></tr>`}
${r.blockers && html`<tr><th>Blockers</th><td>${r.blockers.length ? r.blockers.join('; ') : 'none'}</td></tr>`}
</table></div>
${section('Focuses', r.focuses, html`<div class="card"><table class="grid"><tr><th>Focus</th><th>Status</th><th>Reason</th></tr>
${r.focuses.map((f) => html`<tr><td class="ref">${f.focus}</td><td${f.status === 'failed' ? new Html(' class="err"') : ''}>${f.status}${f.error && html`: ${f.error}`}</td><td>${f.reason}</td></tr>`)}</table></div>`)}
${section('Findings', r.findings, html`<div class="card"><table class="grid"><tr><th>Outcome</th><th>Severity</th><th>Confidence</th><th>Focus</th><th>Where</th><th>Finding</th></tr>
${r.findings.map((f) => html`<tr><td class="nowrap">${f.outcome}</td><td>${f.severity}</td><td>${f.confidence}</td><td>${(f.focuses ?? [f.focus]).join(', ')}</td>
<td><code>${f.path}:${f.start_line !== undefined ? `${f.start_line}-` : ''}${f.line}</code></td>
<td><strong>${f.title}</strong><pre>${f.evidence}</pre>${f.suggested_fix && html`<details><summary>Suggested fix</summary><pre>${f.suggested_fix}</pre></details>`}</td></tr>`)}</table></div>`)}
${section('Agents', r.invocations, html`<div class="card"><table class="grid"><tr><th>Agent</th><th>Models</th><th class="num">Input tokens</th><th class="num">Output tokens</th><th class="num">Cost</th></tr>
${r.invocations.map((i) => html`<tr><td class="ref">${i.agent}</td><td>${i.models.join(' → ')}</td><td class="num">${i.inputTokens}</td><td class="num">${i.outputTokens}</td><td class="num">${usd(i.cost)}</td></tr>`)}</table></div>`)}
${section('Config warnings', r.configWarnings, html`<ul class="card">${r.configWarnings.map((w) => html`<li>${w}</li>`)}</ul>`)}
${section('Skipped files (over the review budget)', r.skipped, html`<ul class="card">${r.skipped.map((p) => html`<li><code>${p}</code></li>`)}</ul>`)}`,
  r.status === 'queued' || r.status === 'running');
}

const HEADERS = {
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline' ${FONT}; font-src ${FONT}; frame-ancestors 'none'; form-action 'self'`,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Serves `/admin` (PRs), `/admin/prs/:owner/:repo/:pr`, `/admin/runs` and `/admin/runs/:id`, or undefined for any
 * other path. 404 while no password is set.
 */
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
    const q = url.searchParams;
    if (url.pathname === '/admin') return respond(200, prList(store, q, now()));
    if (url.pathname === '/admin/runs') return respond(200, list(store, q, now()));
    const run = /^\/admin\/runs\/([^/]+)$/.exec(url.pathname);
    const pr = /^\/admin\/prs\/([^/]+\/[^/]+)\/([^/]+)$/.exec(url.pathname);
    const id = positiveInt(run?.[1] ?? null);
    const number = positiveInt(pr?.[2] ?? null);
    const body = id ? detail(store, id, now()) : pr && number ? prDetail(store, pr[1]!, number, q, now()) : undefined;
    return body ? respond(200, body) : respond(404);
  };
}
