// Deterministic finding validation and comment formatting. Nothing here trusts the model.
import type { ReviewComment, ReviewThread } from './ports.ts';
import type { Finding, RecordedFinding } from './store.ts';

export type Severity = Finding['severity'];
/** Severities, lowest first; the rank of each is its index + 1. */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const satisfies Severity[];
const rank = (s: Severity) => SEVERITIES.indexOf(s) + 1;
const MERGE_WINDOW = 3;

interface Thresholds {
  minSeverity: Severity;
  minConfidence: number;
  maxComments: number;
}

const score = (f: Finding) => rank(f.severity) * f.confidence;
const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Give every reported finding exactly one outcome, in reporting order: anchor, threshold, cross-reviewer
 * merge, cross-push dedup against `posted` (findings published at earlier heads), then cap.
 * A published finding names every focus merged into it.
 */
export function validate(
  reported: { focus: string; finding: Finding }[], changed: Map<string, Set<number>>,
  posted: Pick<Finding, 'path' | 'title' | 'line'>[], limits: Thresholds,
  /** Lines added since the last reviewed head; only these may be commented on. */
  fresh?: Map<string, Set<number>>,
): RecordedFinding[] {
  const out: RecordedFinding[] = reported.map(({ focus, finding }) => {
    const added = changed.get(finding.path);
    const f: RecordedFinding = { ...finding, focus, outcome: 'published' };
    // Threshold first: every other outcome then means a finding worth posting, which approval relies on.
    if (rank(f.severity) < rank(limits.minSeverity) || f.confidence < limits.minConfidence) f.outcome = 'below_threshold';
    else if (!added?.has(f.line)) f.outcome = 'unanchorable';
    else if (fresh && !fresh.get(f.path)?.has(f.line)) f.outcome = 'already_reviewed';
    return f;
  });

  const ranked = out.filter((f) => f.outcome === 'published').sort((a, b) => score(b) - score(a));
  const kept: RecordedFinding[] = [];
  for (const f of ranked) {
    const into = kept.find((k) => k.path === f.path && Math.abs(k.line - f.line) <= MERGE_WINDOW && !k.focuses!.includes(f.focus));
    if (into) { f.outcome = 'merged'; into.focuses!.push(f.focus); continue; }
    f.focuses = [f.focus];
    kept.push(f);
  }

  // An earlier comment still counts while its line is in the current diff; once that line is gone, the finding is new again.
  // ponytail: same title on the same path is the identity, and the old line number isn't mapped to the new head.
  const seen = new Set(posted.filter((p) => changed.get(p.path)?.has(p.line))
    .map((p) => `${p.path}\0${normalizeTitle(p.title)}`));
  let published = 0;
  for (const f of kept) {
    if (seen.has(`${f.path}\0${normalizeTitle(f.title)}`)) f.outcome = 'duplicate';
    else if (published++ >= limits.maxComments) f.outcome = 'over_cap';
  }
  return out;
}

/**
 * Whether a finding this run reported again (held back as already reviewed, or a duplicate of an earlier comment)
 * is the one a thread raised: same path, and a nearby line or the same title. Such a thread must stay open.
 */
export function stillReported(thread: ReviewThread, findings: RecordedFinding[]): boolean {
  const opening = normalizeTitle(thread.comments[0]?.body.split('\n')[0] ?? '');
  return findings.some((f) => (f.outcome === 'already_reviewed' || f.outcome === 'duplicate') && f.path === thread.path
    && ((thread.line !== null && Math.abs(thread.line - f.line) <= MERGE_WINDOW) || opening === normalizeTitle(f.title)));
}

/** The inline comment for a published finding. A multi-line range anchors only if every line in it was added. */
export function toComment(f: RecordedFinding, changed: Map<string, Set<number>>, repo: string): ReviewComment {
  const added = changed.get(f.path)!;
  const rangeAnchored = f.start_line !== undefined && f.start_line < f.line
    && Array.from({ length: f.line - f.start_line + 1 }, (_, i) => f.start_line! + i).every((l) => added.has(l));
  const clean = (s: string) => sanitize(s, repo);
  let body = `**${clean(f.title.replace(/\s+/g, ' '))}**\n\n\`${f.severity}\` · ${(f.focuses ?? [f.focus]).join(' · ')}\n\n${clean(f.evidence)}`;
  if (f.suggested_fix) {
    // The fix is code for exactly the anchored lines only when the reviewer says so and its range was kept.
    if (f.fix_replaces_anchor && (rangeAnchored || f.start_line === undefined || f.start_line === f.line)) {
      // Inside a fence nothing renders as a mention or link; a longer fence keeps the fix from closing it.
      const fence = '`'.repeat(Math.max(3, ...(f.suggested_fix.match(/`+/g) ?? []).map((m) => m.length + 1)));
      body += `\n\n${fence}suggestion\n${f.suggested_fix.replace(/\n$/, '')}\n${fence}`;
    } else {
      body += `\n\n**Suggested fix:**\n\n${clean(f.suggested_fix)}`;
    }
  }
  return { path: f.path, line: f.line, side: 'RIGHT', ...(rangeAnchored && { start_line: f.start_line, start_side: 'RIGHT' as const }), body };
}

/**
 * Neutralize @-mentions, HTML tags and entities, and drop links that don't point into the reviewed repo on github.com.
 * ponytail: code spans in prose get the zero-width spaces too; parsing code like GitHub does is the upgrade.
 */
export function sanitize(text: string, repo: string): string {
  const prefix = `https://github.com/${repo}`.toLowerCase();
  const allowed = (url: string) => {
    const u = url.toLowerCase();
    return u.startsWith(prefix) && /^(?:[/?#]|$)/.test(u.slice(prefix.length)) && !/\.\.|\\|%2e|%2f|%5c/.test(u);
  };
  // Removing a link can join its neighbours into new markup (`&[](x)#64;` becomes `&#64;`), so repeat to a fixed point.
  // Each pass only removes text or adds idempotent zero-width spaces, so this ends.
  for (let prev = ''; prev !== text;) {
    prev = text;
    text = text
      // An entity could spell `@` or `..` past the checks below; a zero-width space leaves it as literal text.
      .replace(/&(?=#|[a-z][a-z0-9]*;)/gi, '&​')
      // Reference definitions, whose destination may sit on the next line.
      .replace(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]*)>?.*$/gm, (m, url: string) => (allowed(url) ? m : ''))
      // Markdown links and images keep their text (alt text) when the target isn't allowed.
      .replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g, (m, label: string, url: string) => (allowed(url) ? m : label))
      // Bare URLs GitHub would autolink.
      .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()[\]"'`]*/gi, (url) => (allowed(url) ? url : '(link removed)'))
      // Protocol-relative and javascript: targets left in any other link syntax.
      .replace(/(?<=^|[\s(<])\/\/[\w-]+\.[^\s<>()[\]"'`]*|\bjavascript:/gim, '(link removed)')
      // A zero-width space stops @user and @org/team from mentioning, and <tag from being HTML.
      .replace(/@(?=[\w-])/g, '@​')
      .replace(/<(?=[a-z/!?])/gi, '<​');
  }
  return text;
}
