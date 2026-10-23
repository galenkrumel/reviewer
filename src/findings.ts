// Deterministic finding validation and comment formatting. Nothing here trusts the model.
import type { ReviewComment, ReviewThread } from './ports.ts';
import type { Finding, RecordedFinding, Waiver } from './store.ts';

/** Maintainers: the GitHub author_associations whose PRs are always reviewed and who can waive a finding. */
export const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export type Severity = Finding['severity'];
/** Severities, lowest first; the rank of each is its index + 1. */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const satisfies Severity[];
const rank = (s: Severity) => SEVERITIES.indexOf(s) + 1;
const MERGE_WINDOW = 3;
/** How far, in lines, a finding may miss an added line and still be moved onto it. */
const ANCHOR_TOLERANCE = 2;

interface Thresholds {
  minSeverity: Severity;
  minConfidence: number;
  maxComments: number;
}

const score = (f: Finding) => rank(f.severity) * f.confidence;
const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Give every reported finding exactly one outcome, in reporting order: threshold, waived, anchor (snapping a miss of one
 * or two lines onto the nearest added line), cross-reviewer merge, cross-push dedup against `posted` (findings published
 * at earlier heads), then cap.
 * A published finding names every focus merged into it.
 */
export function validate(
  reported: { focus: string; finding: Finding }[], changed: Map<string, Set<number>>,
  posted: Pick<RecordedFinding, 'path' | 'title' | 'line' | 'fileLevel'>[], limits: Thresholds,
  threads: ReviewThread[] | undefined, waivers: Waiver[],
): RecordedFinding[] {
  const isWaived = waivedBy(threads, waivers);
  const out: RecordedFinding[] = reported.map(({ focus, finding }) => {
    const added = changed.get(finding.path);
    const f: RecordedFinding = { ...finding, focus, outcome: 'published' };
    // Threshold first: every other outcome then means a finding worth posting, which approval relies on.
    if (rank(f.severity) < rank(limits.minSeverity) || f.confidence < limits.minConfidence) f.outcome = 'below_threshold';
    else if (isWaived(f)) f.outcome = 'waived';
    else if (!added?.has(f.line)) {
      // Models often miss by a line or two (the blank line above an edit), so snap to the nearest added line, following on a tie.
      const near = Array.from({ length: ANCHOR_TOLERANCE }, (_, i) => [f.line + i + 1, f.line - i - 1]).flat()
        .find((l) => added?.has(l));
      // Still a thread someone can fix, disprove or waive: posted on the file, if the file is in the diff.
      if (near === undefined) {
        if (added) f.fileLevel = true;
        else f.outcome = 'unanchorable';
      } else {
        if (f.start_line !== undefined) f.start_line = Math.max(1, f.start_line + near - f.line);
        f.line = near;
        // The fix was written for the lines the reviewer named, so it is no longer an exact replacement.
        f.fix_replaces_anchor = false;
      }
    }
    return f;
  });

  const ranked = out.filter((f) => f.outcome === 'published').sort((a, b) => score(b) - score(a));
  const kept: RecordedFinding[] = [];
  // Doc drift is a different problem from a bug on the same line, so documentation findings never merge with other focuses.
  // A file-level finding never merges with an anchored one either: the merged comment would post on one and lose the other's
  // place (its line, or its thread on the file).
  const isDoc = (x: RecordedFinding) => x.focus === 'documentation';
  for (const f of ranked) {
    const into = kept.find((k) => k.path === f.path && Math.abs(k.line - f.line) <= MERGE_WINDOW && !k.focuses!.includes(f.focus)
      && isDoc(k) === isDoc(f) && !k.fileLevel === !f.fileLevel);
    if (into) { f.outcome = 'merged'; into.focuses!.push(f.focus); continue; }
    f.focuses = [f.focus];
    kept.push(f);
  }

  // An earlier comment still counts while its line is in the current diff; once that line is gone, the finding is new again.
  // A file-level comment counts while its file is in the diff.
  // ponytail: same title on the same path is the identity, and the old line number isn't mapped to the new head.
  const seen = new Set(posted.filter((p) => (p.fileLevel ? changed.has(p.path) : changed.get(p.path)?.has(p.line)))
    .map((p) => `${p.path}\0${normalizeTitle(p.title)}`));
  let published = 0;
  for (const f of kept) {
    if (seen.has(`${f.path}\0${normalizeTitle(f.title)}`)) f.outcome = 'duplicate';
    else if (published++ >= limits.maxComments) f.outcome = 'over_cap';
  }
  return out;
}

/**
 * Whether a waiver absorbs a finding: it raises a waived thread and no other of `threads` (this app's, as read).
 * ponytail: a genuinely new problem at a waived finding's place is absorbed too, if `raises` matches it.
 */
export function waivedBy(threads: ReviewThread[] | undefined, waivers: Waiver[]) {
  threads ??= [];
  const waivedIds = new Set(waivers.map((w) => w.thread));
  // A live thread's line follows the code; the stored one is the fallback when the thread wasn't read.
  const waived = waivers.map((w) => threads.find((t) => t.id === w.thread) ?? w);
  const others = threads.filter((t) => !waivedIds.has(t.id));
  return (f: Pick<Finding, 'path' | 'line' | 'title'>) => waived.some((t) => raises(t, f)) && !others.some((t) => raises(t, f));
}

/**
 * Whether a finding this run reported again (a duplicate of an earlier comment) is the one a thread raised:
 * same path, and a nearby line or the same title. Such a thread must stay open.
 */
export function stillReported(thread: ReviewThread, findings: RecordedFinding[]): boolean {
  return findings.some((f) => f.outcome === 'duplicate' && raises(thread, f));
}

/** Whether this run absorbed a re-report of the thread's finding into its waiver. */
export function absorbed(thread: ReviewThread, findings: RecordedFinding[]): boolean {
  return findings.some((f) => f.outcome === 'waived' && raises(thread, f));
}

/** The title of the finding a thread raised: the first line of the app's own first comment, unbolded. */
export const threadTitle = (t: ReviewThread) => (t.comments[0]?.body.split('\n')[0] ?? '').replace(/^\*\*(.*)\*\*$/, '$1');

/** Whether a thread (or a waiver's record of one) is about this finding: same path, and a nearby line or the same title. */
function raises(thread: ReviewThread | Waiver, f: Pick<Finding, 'path' | 'line' | 'title'>): boolean {
  const title = 'comments' in thread ? threadTitle(thread) : thread.title;
  return f.path === thread.path
    && ((thread.line !== null && Math.abs(thread.line - f.line) <= MERGE_WINDOW) || normalizeTitle(title) === normalizeTitle(f.title));
}

/**
 * The comment for a published finding: inline, or on the file, naming the line, when no added line was near it.
 * A multi-line range anchors only if every line in it was added. The title stays the first line: a file-level thread has
 * no line, so only its title matches it to a re-report or a waiver.
 */
export function toComment(f: RecordedFinding, changed: Map<string, Set<number>>, repo: string): ReviewComment {
  const added = changed.get(f.path)!;
  const rangeAnchored = !f.fileLevel && f.start_line !== undefined && f.start_line < f.line
    && Array.from({ length: f.line - f.start_line + 1 }, (_, i) => f.start_line! + i).every((l) => added.has(l));
  const clean = (s: string) => sanitize(s, repo);
  const where = f.fileLevel ? ` · ${f.start_line !== undefined && f.start_line < f.line ? `lines ${f.start_line}-` : 'line '}${
    f.line}, outside the changed lines` : '';
  let body = `**${clean(f.title.replace(/\s+/g, ' '))}**\n\n\`${f.severity}\` · ${(f.focuses ?? [f.focus]).join(' · ')}${where}\n\n${
    clean(f.evidence)}`;
  if (f.suggested_fix) {
    // The fix is code for exactly the anchored lines only when the reviewer says so and its range was kept.
    if (!f.fileLevel && f.fix_replaces_anchor && (rangeAnchored || f.start_line === undefined || f.start_line === f.line)) {
      // Inside a fence nothing renders as a mention or link; a longer fence keeps the fix from closing it.
      const fence = '`'.repeat(Math.max(3, ...(f.suggested_fix.match(/`+/g) ?? []).map((m) => m.length + 1)));
      body += `\n\n${fence}suggestion\n${f.suggested_fix.replace(/\n$/, '')}\n${fence}`;
    } else {
      body += `\n\n**Suggested fix:**\n\n${clean(f.suggested_fix)}`;
    }
  }
  if (f.fileLevel) return { path: f.path, subject_type: 'file', body };
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
