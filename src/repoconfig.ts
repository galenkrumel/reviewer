// Per-repo config (.github/ai-review.yml, read at the base SHA): maintainers may only tighten the deployment's settings.
import { FOCUSES, type Focus } from './reviewer.ts';

export const REPO_CONFIG_PATH = '.github/ai-review.yml';

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
const ALWAYS_ON: readonly Focus[] = ['correctness', 'security'];
const MAX_HINTS = 20;

/** The deployment's values: the loosest a repo can have. */
export interface Limits {
  minSeverity: Severity;
  minConfidence: number;
  maxReviewers: number;
  maxComments: number;
  maxReviewableLines: number;
}

export interface RepoSettings extends Limits {
  disabledFocuses: Set<Focus>;
  /** Globs over full repository paths, added to the built-in exclusions. */
  exclude: string[];
  /** [glob, hint] pairs. Untrusted: they reach the orchestrator only inside a data block. */
  pathHints: [string, string][];
}

/** Effective settings plus a warning for everything ignored. Only the deployment defaults apply when text is malformed. */
export function parseRepoConfig(text: string | undefined, limits: Limits): { settings: RepoSettings; warnings: string[] } {
  const settings: RepoSettings = { ...limits, disabledFocuses: new Set(), exclude: [], pathHints: [] };
  const warnings: string[] = [];
  if (text === undefined) return { settings, warnings };
  let doc: Record<string, Value>;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { settings, warnings: [`${REPO_CONFIG_PATH} is malformed and was ignored: ${(err as Error).message}`] };
  }
  const warn = (key: string, why: string) => void warnings.push(`${key}: ${why}; ignored`);
  const list = (key: string, v: Value) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : warn(key, 'expected a list'));
  /** A positive integer that is no higher than the deployment's. */
  const cap = (key: string, v: Value, deployed: number, min = 1) => {
    if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < min) return warn(key, `expected an integer >= ${min}`);
    if (Number(v) > deployed) return warn(key, `can only lower the deployment's ${deployed}`);
    return Number(v);
  };

  for (const [key, v] of Object.entries(doc)) {
    switch (key) {
      case 'disable_focuses':
        for (const f of list(key, v) ?? []) {
          if (!FOCUSES.includes(f as Focus)) warn(key, `unknown focus "${f.slice(0, 50)}"`);
          else if (ALWAYS_ON.includes(f as Focus)) warn(key, `${f} cannot be disabled`);
          else settings.disabledFocuses.add(f as Focus);
        }
        break;
      case 'exclude':
        settings.exclude.push(...(list(key, v) ?? []).filter(Boolean));
        break;
      case 'path_hints': {
        if (typeof v !== 'object' || Array.isArray(v)) { warn(key, 'expected a map of glob: hint'); break; }
        const hints = Object.entries(v);
        if (hints.length > MAX_HINTS) warn(key, `only the first ${MAX_HINTS} hints are used`);
        settings.pathHints = hints.slice(0, MAX_HINTS).map(([glob, hint]) => [glob, hint.slice(0, 200)]);
        break;
      }
      case 'thresholds':
        if (typeof v !== 'object' || Array.isArray(v)) { warn(key, 'expected a map'); break; }
        for (const [sub, value] of Object.entries(v)) {
          const k = `thresholds.${sub.slice(0, 50)}`;
          if (sub === 'severity') {
            const rank = SEVERITIES.indexOf(value as Severity);
            if (rank < 0) warn(k, `expected one of ${SEVERITIES.join(', ')}`);
            else if (rank < SEVERITIES.indexOf(limits.minSeverity)) warn(k, `can only raise the deployment's ${limits.minSeverity}`);
            else settings.minSeverity = value as Severity;
          } else if (sub === 'confidence') {
            const n = /^\d*\.?\d+$/.test(value) ? Number(value) : NaN;
            if (!(n <= 1)) warn(k, 'expected a number from 0 to 1');
            else if (n < limits.minConfidence) warn(k, `can only raise the deployment's ${limits.minConfidence}`);
            else settings.minConfidence = n;
          } else warn(k, 'unknown threshold');
        }
        break;
      // Below 2 the always-on security reviewer would be dropped.
      case 'max_reviewers': settings.maxReviewers = cap(key, v, limits.maxReviewers, 2) ?? limits.maxReviewers; break;
      case 'max_comments': settings.maxComments = cap(key, v, limits.maxComments) ?? limits.maxComments; break;
      case 'max_reviewable_lines': settings.maxReviewableLines = cap(key, v, limits.maxReviewableLines) ?? limits.maxReviewableLines; break;
      // Models, budgets, credentials, author gating and everything else belong to the deployment.
      default: warnings.push(`"${key.slice(0, 50)}" is not a per-repo setting; ignored`);
    }
  }
  return { settings, warnings };
}

type Value = string | string[] | Record<string, string>;

/**
 * A strict YAML subset: top-level `key: scalar`, `key: [a, b]`, or `key:` over an indented block list (`- a`) or a
 * one-level map (`a: b`). Scalars may be quoted; `#` starts a comment. Anything else throws.
 * ponytail: hand-rolled to stay dependency-free; flow lists split on every comma. Swap in the `yaml` package if
 * maintainers need more of YAML.
 */
function parseYaml(text: string): Record<string, Value> {
  // Null-prototype objects, so a `__proto__` key is just a key.
  const out: Record<string, Value> = Object.create(null);
  let block: { key: string; indent?: number; items: string[] | Record<string, string> } | undefined;
  const set = (obj: Record<string, unknown>, key: string, v: unknown, n: number) => {
    if (Object.hasOwn(obj, key)) throw new Error(`line ${n}: duplicate key "${key.slice(0, 50)}"`);
    obj[key] = v;
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(#.*)?$/.test(line) || (n === 1 && /^---\s*$/.test(line))) return;
    const indent = /^ */.exec(line)![0].length;
    if (line[indent] === '\t') throw new Error(`line ${n}: tab indentation`);
    const body = line.slice(indent);
    if (indent === 0) {
      block = undefined;
      const [key, rest] = keyValue(body, n);
      if (rest === '') return void set(out, key, (block = { key, items: [] }).items, n);
      set(out, key, rest.startsWith('[') ? flowList(rest, n) : scalar(rest, n), n);
      return;
    }
    if (!block || (block.indent ?? indent) !== indent) throw new Error(`line ${n}: unexpected indentation`);
    block.indent = indent;
    if (/^-(\s|$)/.test(body)) {
      if (!Array.isArray(block.items)) throw new Error(`line ${n}: list item inside a map`);
      block.items.push(scalar(body.slice(1).trim(), n));
    } else {
      if (Array.isArray(block.items)) {
        if (block.items.length) throw new Error(`line ${n}: map entry inside a list`);
        out[block.key] = block.items = Object.create(null);
      }
      const [key, rest] = keyValue(body, n);
      set(block.items as Record<string, string>, key, scalar(rest, n), n);
    }
  });
  return out;
}

const QUOTED = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')\s*(?:#.*)?$/;

function scalar(s: string, n: number): string {
  const q = QUOTED.exec(s);
  if (q) return q[1] !== undefined ? JSON.parse(`"${q[1]}"`) : q[2]!.replace(/''/g, "'");
  const v = s.replace(/(^|\s)#.*$/, '').trim();
  if (!v || /^[[\]{}&!|>%@`"',]/.test(v) || /:(\s|$)/.test(v)) throw new Error(`line ${n}: unsupported value`);
  return v;
}

function flowList(s: string, n: number): string[] {
  const m = /^\[(.*)\]\s*(?:#.*)?$/.exec(s);
  if (!m) throw new Error(`line ${n}: unsupported list`);
  return m[1]!.trim() ? m[1]!.split(',').map((item) => scalar(item.trim(), n)) : [];
}

/** `key: rest` with an optionally quoted key; rest is '' when the value is a block below. */
function keyValue(s: string, n: number): [string, string] {
  const m = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s"'#\-[{][^:#]*?))\s*:(?:\s+(.*))?$/.exec(s);
  if (!m) throw new Error(`line ${n}: expected "key: value"`);
  const key = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]?.replace(/''/g, "'") ?? m[3]!;
  const rest = (m[4] ?? '').trim();
  return [key, rest.startsWith('#') ? '' : rest];
}
