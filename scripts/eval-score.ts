// Scores one eval run against its case's answer key, in code alone (#102). A finding counts as an expected defect when
// it lands on the defect's path and line window; extras a human has ruled on are acceptable or forbidden, and the rest
// wait in the unreviewed queue. An LLM matcher is only needed where several findings sit on one defect's anchor.
import { SEVERITIES } from '../src/findings.ts';
import type { Finding } from '../src/store.ts';

type Severity = Finding['severity'];
/** Where a finding must land: a path and an inclusive line window in the head revision. */
export interface Anchor { path: string; lines: [number, number] }
/** A defect the reviewer must report; `defect` is what an LLM matcher would compare a finding against. */
export interface Expected extends Anchor { id: string; minSeverity: Severity; defect: string }
/** An extra finding a human has already ruled on, so later runs don't need a human again. */
export interface Ruled extends Anchor { title: string }
export interface AnswerKey { expected: Expected[]; acceptableExtras?: Ruled[]; forbidden?: Ruled[] }

export interface Score {
  /** error: the run itself failed (fetching, scoping, the model), so it says nothing about the reviewer. */
  outcome: 'pass' | 'fail' | 'error';
  /** Expected defect id → the finding that matched it, and whether its severity reached minSeverity. */
  matched: Record<string, { title: string; severity: Severity; severityOk: boolean }>;
  missed: string[];
  /** Expected defect ids with more than one finding on their anchor; the most severe one was taken. */
  ambiguous: string[];
  forbidden: string[];
  acceptable: string[];
  /** Titles of extras no one has ruled on yet. */
  unreviewed: string[];
}

const on = (f: Finding, a: Anchor) =>
  f.path === a.path && (f.start_line ?? f.line) <= a.lines[1] && f.line >= a.lines[0];
const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** `findings` is undefined when the run failed before reporting. */
export function score(key: AnswerKey, findings: Finding[] | undefined): Score {
  const s: Score = { outcome: 'error', matched: {}, missed: [], ambiguous: [], forbidden: [], acceptable: [], unreviewed: [] };
  if (!findings) return s;
  const used = new Set<Finding>();
  for (const e of key.expected) {
    const candidates = findings.filter((f) => on(f, e)).sort((a, b) => rank(b.severity) - rank(a.severity));
    const f = candidates[0];
    if (!f) {
      s.missed.push(e.id);
      continue;
    }
    // ponytail: takes the most severe candidate; an LLM matcher should decide when there is more than one.
    if (candidates.length > 1) s.ambiguous.push(e.id);
    used.add(f);
    s.matched[e.id] = { title: f.title, severity: f.severity, severityOk: rank(f.severity) >= rank(e.minSeverity) };
  }
  for (const f of findings) {
    if (used.has(f)) continue;
    if (key.forbidden?.some((r) => on(f, r))) s.forbidden.push(f.title);
    else if (key.acceptableExtras?.some((r) => on(f, r))) s.acceptable.push(f.title);
    else s.unreviewed.push(f.title);
  }
  const ok = !s.missed.length && !s.forbidden.length && Object.values(s.matched).every((m) => m.severityOk);
  s.outcome = ok ? 'pass' : 'fail';
  return s;
}
