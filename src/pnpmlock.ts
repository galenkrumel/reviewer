// A reader for just the YAML pnpm writes to pnpm-lock.yaml, and just the sections the Dependency check reads.

/** A map, a scalar, null (no value, or a multi-line scalar the check never reads), or a flow collection unread. */
export type YamlNode = YamlMap | string | null | Flow;
export interface YamlMap { [key: string]: YamlNode }
/** A `{…}` or `[…]` value, kept as written: only `resolution` is read, by `flowMap`. */
export class Flow {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}

/** One YAML document of the lockfile, with each section entry's line (`packages` → key → 1-based line). */
export interface LockDoc { root: YamlMap; lines: Map<string, Map<string, number>> }

/** The top-level sections the check reads; any other section's body is skipped unread. */
const READ = new Set(['importers', 'packages', 'snapshots', 'dependencies', 'devDependencies', 'optionalDependencies']);
// Every pattern here matches in linear time: the text is the PR's, up to 32 MiB.
const QUOTE = `'((?:[^']|'')*)'|"((?:[^"\\\\]|\\\\.)*)"`;
const QUOTED_KEY = new RegExp(`^(?:${QUOTE})[ \\t]*:(?:[ \\t]+|$)`);
const QUOTED = new RegExp(`^(?:${QUOTE})[ \\t]*(?:#.*)?$`);

/**
 * `key: rest` with an optionally quoted key; rest is '' when the value is below. A plain key can't start with a YAML
 * indicator (a list item, anchor, alias, tag, complex key, flow, comment...) and ends at the first `: `.
 */
function keyValue(body: string): [string, string] | undefined {
  const q = QUOTED_KEY.exec(body);
  if (q) return [unquote(q[1], q[2]), body.slice(q[0].length).trim()];
  const end = body.search(/:(?:[ \t]|$)/);
  if (end <= 0 || /^[\s'"#&*!|>%@`{}[\],?:-]/.test(body)) return;
  return [body.slice(0, end).trimEnd(), body.slice(end + 1).trim()];
}
const unquote = (single: string | undefined, double: string | undefined) =>
  single !== undefined ? single.replace(/''/g, "'") : JSON.parse(`"${double}"`) as string;
const map = (): YamlMap => Object.create(null);

/**
 * The documents of a pnpm-lock.yaml (pnpm 10 writes an env lockfile ahead of the main one), or undefined for anything
 * outside what pnpm writes in the sections read: nested block maps, plain or quoted keys and scalars, single-line flow
 * collections. Anchors, aliases, tags, merge keys, duplicate keys, tabs and misaligned lines aren't understood there:
 * another YAML reader could take them another way. A block list or a multi-line (`|`, `>`) scalar reads as null.
 */
export function readPnpmLock(text: string): LockDoc[] | undefined {
  const docs: LockDoc[] = [];
  let doc: LockDoc | undefined;
  let frames: { indent: number; map: YamlMap }[] = [];
  /** A key with no value yet: a map if deeper lines follow, else null. */
  let open: { map: YamlMap; key: string; indent: number } | undefined;
  /** Lines deeper than this are skipped: a skipped section's body, or a multi-line scalar. */
  let skipBelow = Infinity;
  let section = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    if (line === '---') { doc = undefined; continue; }
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const indent = line.search(/[^ ]/);
    if (indent > skipBelow) continue;
    skipBelow = Infinity;
    if (!doc) {
      docs.push(doc = { root: map(), lines: new Map() });
      [frames, open] = [[{ indent: 0, map: doc.root }], undefined];
    }
    if (open) {
      const deeper = indent > open.indent;
      // A block list in an entry (`transitivePeerDependencies`, a runtime's `variants`): never read, so skipped. A
      // section or an entry that is a list is no lockfile.
      if (deeper && frames.length > 2 && /^-(?:[ \t]|$)/.test(line.slice(indent))) {
        [skipBelow, open] = [open.indent, undefined];
        continue;
      }
      if (deeper) frames.push({ indent, map: open.map[open.key] = map() });
      open = undefined;
    }
    while (frames.at(-1)!.indent > indent) frames.pop();
    const frame = frames.at(-1)!;
    const kv = keyValue(line.slice(indent));
    if (frame.indent !== indent || !kv) return;
    const [key, rest] = kv;
    if (key === '<<' || Object.hasOwn(frame.map, key)) return;
    if (frames.length === 1) {
      section = key;
      if (!READ.has(key)) {
        // Only the lockfile version is read outside the sections: anything else here is skipped.
        frame.map[key] = rest && !/^[|>]/.test(rest) ? value(rest) ?? null : null;
        skipBelow = 0;
        continue;
      }
    } else if (frames.length === 2) {
      const at = doc.lines.get(section) ?? new Map<string, number>();
      doc.lines.set(section, at.set(key, i + 1));
    }
    if (rest === '' || rest.startsWith('#')) {
      frame.map[key] = null;
      open = { map: frame.map, key, indent };
    } else if (/^[|>][-+0-9]*[ \t]*(?:#.*)?$/.test(rest)) {
      frame.map[key] = null;
      skipBelow = indent;
    } else {
      const v = value(rest);
      if (v === undefined) return;
      frame.map[key] = v;
    }
  }
  return docs;
}

/** An inline value: quoted, plain, or flow (`{}` is an empty map). Undefined when it isn't one pnpm would write. */
function value(s: string): YamlNode | undefined {
  const q = QUOTED.exec(s);
  if (q) return unquote(q[1], q[2]);
  if (/^\{\s*\}$/.test(s)) return map();
  if (/^\{.*\}$|^\[.*\]$/.test(s)) return new Flow(s);
  const v = s.replace(/[ \t]#.*$/, '').trim();
  if (/^['"&*!|>%@`{[\]},#]/.test(v) || /:(?:\s|$)/.test(v)) return;
  return v;
}

// A plain flow scalar never ends in whitespace or holds `: `, so it and the separators around it can't overlap.
const FLOW_SCALAR = `${QUOTE}|([^\\s'"{}[\\],:](?:[^\\s{}[\\],:]|:(?!\\s)|\\s+(?=[^\\s{}[\\],:]))*)`;
const FLOW_ITEM = new RegExp(`\\s*(?:${FLOW_SCALAR})\\s*:\\s+(?:${FLOW_SCALAR})\\s*(,|\\})`, 'y');

/** A one-level flow map of scalars (`{integrity: sha512-…, tarball: https://…}`), or undefined for anything else. */
export function flowMap(flow: Flow): Record<string, string> | undefined {
  const out: Record<string, string> = Object.create(null);
  const s = flow.text;
  if (!s.startsWith('{')) return;
  FLOW_ITEM.lastIndex = 1;
  for (let m; (m = FLOW_ITEM.exec(s));) {
    const key = m[3] ?? unquote(m[1], m[2]);
    if (Object.hasOwn(out, key)) return;
    out[key] = m[6] ?? unquote(m[4], m[5]);
    if (m[7] === '}') return FLOW_ITEM.lastIndex === s.length ? out : undefined;
  }
}
