// The Dependency check: code, never a model, compares a PR's lockfiles at base and head (ADR 0002).
import { posix } from 'node:path';
import { ToolError, type FileChange, type Source } from './git.ts';
import { LOCKFILES } from './scope.ts';

/**
 * One package the PR added, removed, or moved from one version to another (or to the same version from a new source
 * or integrity: `from` equals `to`), counted once per lockfile.
 */
export interface PackageChange {
  name: string;
  /** The version the PR replaced or removed; unset for an added package. */
  from?: string;
  /** The version the PR moves to or adds; unset for a removed package. */
  to?: string;
  /** Where it resolved from, at head (at base for a removed package). Unset for a bundled package. */
  resolved?: string;
  /** Its lockfile integrity hash, from the same side as `resolved`. */
  integrity?: string;
  /** Its `"version"` line at head; unset for a removed package. */
  line?: number;
}

/** "3.4.11 → 3.4.17", "2.0.0 (added)" or "1.0.0 (removed)". */
export const describeMove = (c: PackageChange) => c.from === undefined ? `${c.to} (added)`
  : c.to === undefined ? `${c.from} (removed)` : c.from === c.to ? `${c.to} (source or integrity changed)` : `${c.from} → ${c.to}`;

/** What the Dependency check found on one Run. */
export interface DependencyCheck {
  /** Each supported lockfile compared, with its package changes (none for a reformat). */
  lockfiles: { path: string; changes: PackageChange[] }[];
  /** Supported lockfiles the check couldn't understand. They block approval. */
  unreadable: string[];
  /** Changed lockfiles in formats the check doesn't support yet. */
  unchecked: string[];
}

const SUPPORTED = new Set(['package-lock.json']);

/** One installed package as a lockfile records it. */
interface Entry { name: string; version: string; resolved?: string; integrity?: string; key: string }

/**
 * A package-lock.json's installed packages (lockfile versions 2 and 3), or undefined when it isn't one. Workspace
 * folders and links are the repo's own code; bundled packages count, though they have no source of their own.
 */
function entries(text: string | undefined): Entry[] | undefined {
  if (text === undefined) return [];
  let lock: any;
  try {
    lock = JSON.parse(text);
  } catch {
    return;
  }
  const packages = lock?.packages;
  if (![2, 3].includes(lock?.lockfileVersion) || typeof packages !== 'object' || packages === null || Array.isArray(packages)) return;
  const out: Entry[] = [];
  for (const [key, e] of Object.entries<any>(packages)) {
    if (typeof e !== 'object' || e === null) return;
    const at = key.lastIndexOf('node_modules/');
    if (at < 0 || e.link) continue;
    // An installed package always records its version: one without is not a lockfile the check understands.
    if (typeof e.version !== 'string') return;
    // An `npm:` alias is installed under its alias and records the real name.
    const name = typeof e.name === 'string' ? e.name : key.slice(at + 'node_modules/'.length);
    out.push({ name, version: e.version, resolved: str(e.resolved), integrity: str(e.integrity), key });
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Each name's versions, with every entry installing each version. */
function byName(list: Entry[]): Map<string, Map<string, Entry[]>> {
  const out = new Map<string, Map<string, Entry[]>>();
  for (const e of list) {
    const versions = out.get(e.name) ?? new Map<string, Entry[]>();
    const installs = versions.get(e.version) ?? [];
    installs.push(e);
    versions.set(e.version, installs);
    out.set(e.name, versions);
  }
  return out;
}

const source = (e: Entry) => `${e.resolved} ${e.integrity}`;

/**
 * The line of each package key's first `"version"`, as npm writes lockfiles: one key per line, version before any
 * nested map. ponytail: line-based; a minified lockfile anchors nothing. Track JSON positions if one turns up.
 */
function versionLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let key: string | undefined;
  // Matched in place rather than split into lines: a lockfile can be 32 MiB.
  let line = 1;
  let at = 0;
  for (const m of text.matchAll(/^[ \t]*("(?:[^"\\\n]|\\.)*")[ \t]*:/gm)) {
    for (; at < m.index; at++) if (text.charCodeAt(at) === 10) line++;
    const k: string = JSON.parse(m[1]!);
    if (k.includes('node_modules/')) key = k;
    else if (k === 'version' && key !== undefined) {
      if (!out.has(key)) out.set(key, line);
      key = undefined;
    }
  }
  return out;
}

/**
 * Compare every changed lockfile that per-repo `exclude` globs and `.gitattributes` marks (`excluded`, holding old and
 * new paths) leave in, on the side or sides they leave in.
 * A lockfile too big or odd to read (a symlink) is as unreadable as one that doesn't parse.
 */
export async function checkDependencies(
  files: FileChange[], excluded: ReadonlySet<string>, read: Source['bothSides'],
): Promise<DependencyCheck> {
  const check: DependencyCheck = { lockfiles: [], unreadable: [], unchecked: [] };
  // A rename that changes the file's name (package-lock.json to yarn.lock, or to some other file) is a deletion and an
  // addition, so each side is checked as the kind of file it is. A move that keeps the name compares like an edit.
  const sides = files.flatMap((f): FileChange[] => f.oldPath && posix.basename(f.oldPath) !== posix.basename(f.path)
    ? [{ path: f.oldPath, added: 0, deleted: 0 }, { path: f.path, added: 0, deleted: 0 }] : [f]);
  for (const f of sides) {
    const name = posix.basename(f.path);
    // Each side counts only where it isn't excluded: moved out of an excluded path, every package is new; moved into
    // one, every package left. An excluded side is never parsed.
    const old = f.oldPath ?? f.path;
    const [useBase, useHead] = [!excluded.has(old), !excluded.has(f.path)];
    if (!LOCKFILES.has(name) || (!useBase && !useHead)) continue;
    const path = useHead ? f.path : old;
    if (!SUPPORTED.has(name)) { check.unchecked.push(path); continue; }
    let changes: PackageChange[] | undefined;
    try {
      const { base, head } = await read(f);
      changes = compareLockfile(useBase ? base : undefined, useHead ? head : undefined);
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
    }
    if (changes) check.lockfiles.push({ path, changes });
    else check.unreadable.push(path);
  }
  return check;
}

// ponytail: numeric string order, so a prerelease sorts after its release; only pairing of several moves of one name
// depends on it. Compare by semver if mispaired moves show up.
const byVersion = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * The packages a lockfile change added, removed or moved, by name then version, or undefined when either side isn't
 * a lockfile the check understands. Undefined text is a side where the lockfile doesn't exist. A name's removed and
 * added versions pair up in version order as moves; the rest are added or removed. A version on both sides that some
 * install now resolves from elsewhere, or with another integrity, is a change from that version to itself.
 */
export function compareLockfile(base: string | undefined, head: string | undefined): PackageChange[] | undefined {
  const [before, after] = [entries(base), entries(head)];
  if (!before || !after) return;
  const [old, now] = [byName(before), byName(after)];
  const atKey = new Map(before.map((e) => [e.key, e]));
  const lines = head === undefined ? new Map<string, number>() : versionLines(head);
  const changes: PackageChange[] = [];
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const was = old.get(name) ?? new Map<string, Entry[]>();
    const is = now.get(name) ?? new Map<string, Entry[]>();
    const push = (e: Entry, from?: string, to?: string) => changes.push({
      name, ...(from !== undefined && { from }), ...(to !== undefined && { to }),
      ...(e.resolved !== undefined && { resolved: e.resolved }), ...(e.integrity !== undefined && { integrity: e.integrity }),
      ...(to !== undefined && lines.has(e.key) && { line: lines.get(e.key) }),
    });
    const removed = [...was.keys()].filter((v) => !is.has(v)).sort(byVersion);
    const added = [...is.keys()].filter((v) => !was.has(v)).sort(byVersion);
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const [from, to] = [removed[i], added[i]];
      push(to !== undefined ? is.get(to)![0]! : was.get(from!)![0]!, from, to);
    }
    // The same version from somewhere new, in any place it is installed: a swapped tarball is not "unmoved". An install
    // is held to the base's install at the same place when that was this package at this version (an alias can change
    // what a place holds), else to every base install of it; a
    // version the base didn't have is held to its own first install, which the move above reported.
    for (const [v, installs] of is) {
      const known = new Set(was.get(v)?.map(source) ?? [source(installs[0]!)]);
      const swapped = installs.find((e) => {
        const there = atKey.get(e.key);
        return there?.name === name && there.version === v ? source(there) !== source(e) : !known.has(source(e));
      });
      if (swapped) push(swapped, v, v);
    }
  }
  return changes;
}
