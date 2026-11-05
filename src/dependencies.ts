// The Dependency check: code, never a model, compares a PR's lockfiles at base and head (ADR 0002).
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ToolError, type FileChange, type Source } from './git.ts';
import { FetchError, type Advisory } from './ports.ts';
import { Flow, flowMap, readPnpmLock, type YamlMap, type YamlNode } from './pnpmlock.ts';
import { LOCKFILES } from './scope.ts';
import type { Finding } from './store.ts';

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
  /** Where the version it moved from resolved, at base; unset for an added or removed package. */
  fromResolved?: string;
  /** Its integrity, from the same install as `fromResolved`. */
  fromIntegrity?: string;
  /**
   * For a bundled package (`inBundle`, no source of its own, nested in a package), at head: where the nearest enclosing
   * package that isn't bundled itself resolves from (unset if it records none) and the bundled one's folder in its
   * tarball. Its install scripts are compared with that package's.
   */
  bundledIn?: BundledAt;
  /** The same for the install it moved from, at base, when that was bundled. */
  fromBundledIn?: BundledAt;
  /** For a package that bundles others, the folders (lowercased) of those inspected as changes of their own, at head. */
  bundles?: string[];
  /** Its `"version"` line at head; unset for a removed package. */
  line?: number;
  /** The Advisories open against either side, once looked up; unset when none are. */
  advisories?: ClassifiedAdvisory[];
  /** Install scripts its fetched tarball has that the version it moved from didn't (any, when added), by name. */
  installScripts?: Record<string, string>;
  /** What depends on it by name, from the same side as `resolved`: other packages, the root project or workspaces. */
  pulledBy?: string[];
  /** Set when that side's lockfile had more dependency edges than the check records, so `pulledBy` may miss some. */
  pulledByPartial?: true;
}

/** Where a bundled package is: its bundler's source (unset if that records none) and its folder in that tarball. */
export interface BundledAt { resolved?: string; integrity?: string; folder: string }

/** A package change whose code the check couldn't fetch and read, so nothing vouches for it. */
export interface NotInspected { path: string; name: string; version: string; reason: string }

/**
 * An Advisory relative to the PR: introduced (open against the version it moves to or adds, not the one it replaced),
 * still open (both), or fixed (only the one replaced or removed).
 */
export type ClassifiedAdvisory = Omit<Advisory, 'withdrawn'> & { status: 'introduced' | 'still open' | 'fixed' };

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
  /** Why the Advisories couldn't be looked up, when they couldn't. It blocks approval. */
  advisoryError?: string;
  /** Package changes whose tarballs weren't fetched or read. They block approval. Unset on runs before tarball fetches. */
  notInspected?: NotInspected[];
}

const SUPPORTED = new Set(['package-lock.json', 'pnpm-lock.yaml']);
/** npm's default registry: anything else a package resolves from is off-registry. */
const REGISTRY = 'https://registry.npmjs.org/';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether a registry URL is exactly this package's tarball at this version, as fetched: a semver version, no escapes
 * in the name, and a URL the parser leaves as written (no `..`, query or fragment). Names keep their case: old
 * packages (`JSONStream`) have capitals.
 */
function isTarballOf(resolved: string, name: string, version: string): boolean {
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return false;
  }
  return SEMVER.test(version) && !name.includes('%') && url.href === resolved && !url.search && !url.hash
    && resolved === `${REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`;
}
const MAX_ENTRIES = 50_000;
// A PR can change any number of lockfiles: past these totals for the run, the rest are unreadable rather than read.
const MAX_RUN_TEXT = 128 * 1024 * 1024;
const MAX_RUN_CHANGES = 100_000;
const MAX_RUN_LOCKFILES = 200;

/** One installed package as a lockfile records it. */
interface Entry {
  name: string; version: string; resolved?: string; integrity?: string; key: string;
  /** For a bundled package, where it is: in the tarball of the nearest enclosing package that isn't bundled. */
  bundledBy?: BundledAt & { bundler: string };
}
/** A lockfile's installed packages, and what depends on each name. */
interface Lock {
  list: Entry[]; pulledBy: Map<string, Set<string>>; partial: boolean;
  /** Each entry's anchor line by key, when the reader records them (pnpm's key lines); npm's are found after. */
  lines?: Map<string, number>;
}
// Dependency edges recorded per lockfile, about ten times a big monorepo's: past it a crafted lockfile can't grow the map.
const MAX_EDGES = 500_000;
const DEPENDENCY_MAPS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

/**
 * A package-lock.json's installed packages (lockfile versions 2 and 3), or undefined when it isn't one. Workspace
 * folders and links are the repo's own code; bundled packages count, though they have no source of their own.
 */
function entries(text: string | undefined): Lock | undefined {
  const pulledBy = new Map<string, Set<string>>();
  if (text === undefined) return { list: [], pulledBy, partial: false };
  let lock: any;
  try {
    lock = JSON.parse(text);
  } catch {
    return;
  }
  const packages = lock?.packages;
  if (![2, 3].includes(lock?.lockfileVersion) || typeof packages !== 'object' || packages === null || Array.isArray(packages)) return;
  // Far past any real lockfile (big monorepos have about 10,000): a PR can't make the comparison hold more than this.
  let count = 0;
  for (const _ in packages) if (++count > MAX_ENTRIES) return;
  const out: Entry[] = [];
  let [edges, partial] = [0, false];
  for (const key in packages) {
    const e = packages[key];
    if (typeof e !== 'object' || e === null) return;
    const at = key.lastIndexOf('node_modules/');
    // ponytail: by name, not by the version node would resolve from where it sits; good enough for the security
    // focus's context, resolve nested node_modules if it misleads.
    const by = typeof e.name === 'string' ? e.name : at < 0 ? key || '(root)' : key.slice(at + 'node_modules/'.length);
    for (const map of DEPENDENCY_MAPS) {
      const deps = e[map];
      if (partial || typeof deps !== 'object' || deps === null) continue;
      for (const d in deps) {
        if (++edges > MAX_EDGES) { partial = true; break; }
        const set = pulledBy.get(d) ?? new Set();
        set.add(by);
        pulledBy.set(d, set);
      }
    }
    if (at < 0 || e.link) continue;
    // An installed package always records its version: one without is not a lockfile the check understands.
    if (typeof e.version !== 'string') return;
    // An `npm:` alias is installed under its alias and records the real name.
    const name = typeof e.name === 'string' ? e.name : key.slice(at + 'node_modules/'.length);
    // npm installs what `resolved` names, and advisories are looked up by name and version: a registry tarball of
    // another package or version is not a lockfile the check understands. The name and version must be plain ones
    // too, or the URL could still say something else once fetched (`a/../evil`, `1.0.0#`).
    const resolved = str(e.resolved);
    if (resolved?.startsWith(REGISTRY) && !isTarballOf(resolved, name, e.version)) return;
    // Bundled as npm installs it: `inBundle` and nested in a package, whatever source it records.
    let bundledBy: Entry['bundledBy'];
    if (e.inBundle === true && at > 0) {
      const up = (k: string) => k.slice(0, k.lastIndexOf('/node_modules/'));
      let root = up(key);
      while (packages[root]?.inBundle === true && root.lastIndexOf('/node_modules/') > 0) root = up(root);
      const [by, sum] = [str(packages[root]?.resolved), str(packages[root]?.integrity)];
      bundledBy = { ...(by !== undefined && { resolved: by }), ...(sum !== undefined && { integrity: sum }), folder: key.slice(root.length + 1), bundler: root };
    }
    out.push({ name, version: e.version, resolved, integrity: str(e.integrity), key, ...(bundledBy && { bundledBy }) });
  }
  // Dependents name what they install (an alias); changes are by the real name, so an alias's dependents count there too.
  for (const e of out) {
    const installed = e.key.slice(e.key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const via = installed === e.name ? undefined : pulledBy.get(installed);
    if (via) pulledBy.set(e.name, new Set([...(pulledBy.get(e.name) ?? []), ...via]));
  }
  return { list: out, pulledBy, partial };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const isMap = (v: YamlNode | undefined): v is YamlMap => typeof v === 'object' && v !== null && !(v instanceof Flow);

/** `name@ref` without its `(peer@1.0.0)` or `(patch_hash=…)` suffixes: the name ends at the `@` after a scope's. */
function splitKey(key: string): [string | undefined, string | undefined] {
  const at = key.indexOf('@', 1);
  return at < 0 ? [undefined, undefined] : [key.slice(0, at), key.slice(at + 1).split('(')[0]];
}

/** The real name an aliased dependency installs (`string-width@4.2.3`, `/string-width@4.2.3` in v6), if it is one. */
const aliasOf = (ref: string) => /^\/?((?:@[^@/():]+\/)?[^@/():]+)@[^(]/.exec(ref)?.[1];

/**
 * A pnpm-lock.yaml's installed packages (lockfile versions 6 and 9, from every document: pnpm 10 puts an env lockfile
 * ahead of the main one), or undefined when it isn't one. Peer variants of one version are that one package; directory
 * packages are the repo's own code. A resolution with only an integrity is a tarball on the default registry, as pnpm
 * fetches it. ponytail: pnpm doesn't record a registry set in `.npmrc`, so a package from one reads as from npm's.
 */
function pnpmEntries(text: string | undefined): Lock | undefined {
  const pulledBy = new Map<string, Set<string>>();
  const lines = new Map<string, number>();
  if (text === undefined) return { list: [], pulledBy, partial: false, lines };
  const docs = readPnpmLock(text);
  if (!docs?.length) return;
  const out: Entry[] = [];
  let [edges, partial, count] = [0, false, 0];
  const edge = (by: string, holder: YamlNode | undefined) => {
    if (!isMap(holder)) return;
    for (const map of DEPENDENCY_MAPS) {
      const deps = holder[map];
      if (partial || !isMap(deps)) continue;
      for (const d in deps) {
        const v = deps[d];
        // Importers record `{specifier, version}`; packages and snapshots the version alone.
        const ref = typeof v === 'string' ? v : isMap(v) ? str(v.version) : undefined;
        if (ref?.startsWith('link:')) continue;
        if (++edges > MAX_EDGES) { partial = true; break; }
        const name = (ref && aliasOf(ref)) ?? d;
        pulledBy.set(name, (pulledBy.get(name) ?? new Set()).add(by));
      }
    }
  };
  for (const [i, { root, lines: at }] of docs.entries()) {
    const version = str(root.lockfileVersion);
    if (version !== '6.0' && version !== '9.0') return;
    const v6 = version.startsWith('6');
    const sections = [root.packages, root.snapshots, root.importers].map((s) => s ?? {});
    if (!sections.every(isMap)) return;
    const [packages, snapshots, importers] = sections as YamlMap[];
    for (const key in packages) {
      if (++count > MAX_ENTRIES) return;
      const e = packages[key];
      if (!isMap(e)) return;
      // v6 keys a registry package `/name@version`; its others, keyed by where they come from, record name and version.
      const [keyName, ref] = v6 && !key.startsWith('/') ? [undefined, undefined] : splitKey(v6 ? key.slice(1) : key);
      const r = e.resolution instanceof Flow ? flowMap(e.resolution) : isMap(e.resolution) ? e.resolution : undefined;
      // A field read that isn't one plain string (a multi-line scalar reads as null) could say something else to pnpm.
      const plain = (m: YamlMap | Record<string, string>, fields: string[]) => fields.every((f) => !Object.hasOwn(m, f) || typeof m[f] === 'string');
      if (!r || !plain(e, ['name', 'version']) || !plain(r, ['type', 'tarball', 'integrity', 'repo', 'commit', 'directory'])) return;
      const name = str(e.name) ?? keyName;
      if (name) edge(name, e);
      // ponytail: a runtime pnpm downloads (`node@runtime:22.0.0`, its binaries per platform) isn't an npm package and
      // isn't compared, so a changed download URL goes unflagged; compare its variants if runtimes need checking.
      if (r.type === 'directory' || (ref?.startsWith('runtime:') && (r.type === 'variations' || r.type === 'binary'))) continue;
      const v = str(e.version) ?? ref;
      // A key and fields that disagree could install one package and be looked up as another.
      if (!name || !v || (keyName !== undefined && name !== keyName) || (ref !== undefined && SEMVER.test(ref) && v !== ref)) return;
      const resolved = r.type === undefined
        ? str(r.tarball) ?? (typeof r.integrity === 'string' ? `${REGISTRY}${name}/-/${name.split('/').pop()}-${v}.tgz` : undefined)
        : r.type === 'git' && typeof r.repo === 'string' && typeof r.commit === 'string' ? `git+${r.repo}#${r.commit}` : undefined;
      // As for npm: a registry tarball must be this package at this version, so what installs is what is looked up.
      if (resolved === undefined || (resolved.startsWith(REGISTRY) && !isTarballOf(resolved, name, v))) return;
      const k = `${i}/${key}`;
      const line = at.get('packages')?.get(key);
      if (line !== undefined) lines.set(k, line);
      out.push({ name, version: v, resolved, integrity: str(r.integrity), key: k });
    }
    for (const key in snapshots) edge(splitKey(key)[0] ?? key, snapshots[key]);
    for (const key in importers) edge(key === '.' ? '(root)' : key, importers[key]);
    // A v6 lockfile of a single project lists its dependencies at the top.
    edge('(root)', root);
  }
  return { list: out, pulledBy, partial, lines };
}

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

const source = (e: Entry) => `${e.resolved} ${e.integrity}${e.bundledBy ? ` in ${e.bundledBy.resolved} ${e.bundledBy.integrity} at ${e.bundledBy.folder}` : ''}`;

/**
 * The line of each package key's first `"version"`, as npm writes lockfiles: one key per line, version before any
 * nested map. ponytail: line-based; a minified lockfile has no version lines, so the check's Findings fall back to
 * line 1. Track JSON positions if one turns up.
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
 * A lockfile too big or odd to read (a symlink), or past the run's budget, is as unreadable as one that doesn't parse.
 */
export async function checkDependencies(
  files: FileChange[], excluded: ReadonlySet<string>, read: Source['fileAtSide'],
): Promise<DependencyCheck> {
  const check: DependencyCheck = { lockfiles: [], unreadable: [], unchecked: [] };
  let [text, kept] = [0, 0];
  // A rename that changes the file's name (package-lock.json to yarn.lock, or to some other file) is a deletion and an
  // addition, so each side is checked as the kind of file it is. A move that keeps the name compares like an edit.
  const sides = files.flatMap((f): FileChange[] => f.oldPath && posix.basename(f.oldPath) !== posix.basename(f.path)
    ? [{ path: f.oldPath, added: 0, deleted: 0 }, { path: f.path, added: 0, deleted: 0 }] : [f]);
  for (const f of sides) {
    const name = posix.basename(f.path);
    // Each side counts only where it isn't excluded: moved out of an excluded path, every package is new; moved into
    // one, every package left. An excluded side is never read.
    const old = f.oldPath ?? f.path;
    const [useBase, useHead] = [!excluded.has(old), !excluded.has(f.path)];
    if (!LOCKFILES.has(name) || (!useBase && !useHead)) continue;
    const path = useHead ? f.path : old;
    if (!SUPPORTED.has(name)) { check.unchecked.push(path); continue; }
    let changes: PackageChange[] | undefined;
    const tried = check.lockfiles.length + check.unreadable.length;
    if (text <= MAX_RUN_TEXT && kept <= MAX_RUN_CHANGES && tried < MAX_RUN_LOCKFILES) try {
      // Each side counts once read, so a failed read of the other side doesn't hide it.
      let base: string | undefined, head: string | undefined;
      const size = (t: string | undefined) => (t === undefined ? 0 : Buffer.byteLength(t));
      if (useBase) text += size(base = await read('base', old));
      if (useHead && text <= MAX_RUN_TEXT) text += size(head = await read('head', f.path));
      if (text <= MAX_RUN_TEXT) changes = compareLockfile(base, head, name);
      if (changes && (kept += changes.length) > MAX_RUN_CHANGES) changes = undefined;
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
    }
    if (changes) check.lockfiles.push({ path, changes });
    else check.unreadable.push(path);
  }
  return check;
}

// ponytail: numeric string order, so a prerelease sorts after its release; pairing several moves of one name, and the
// first patched version an Advisory names (src/github.ts), depend on it. Compare by semver if either goes wrong.
export const byVersion = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * The packages a lockfile change added, removed or moved, by name then version, or undefined when either side isn't
 * a lockfile the check understands. Undefined text is a side where the lockfile doesn't exist. A name's removed and
 * added versions pair up in version order as moves; the rest are added or removed. A version on both sides that some
 * install now resolves from elsewhere, or with another integrity, is a change from that version to itself.
 */
export function compareLockfile(base: string | undefined, head: string | undefined, file = 'package-lock.json'): PackageChange[] | undefined {
  const read = file === 'pnpm-lock.yaml' ? pnpmEntries : entries;
  const [baseLock, headLock] = [read(base), read(head)];
  if (!baseLock || !headLock) return;
  const [before, after] = [baseLock.list, headLock.list];
  const [old, now] = [byName(before), byName(after)];
  const atKey = new Map(before.map((e) => [e.key, e]));
  // Each bundler's bundled installs that a change below inspects on its own; any other copy in its tarball (another
  // install of a version already counted, an unchanged one, one the lockfile doesn't list) is compared with it.
  const listed = new Map<string, string[]>();
  const bundlers = new Map<string, PackageChange>();
  const at = (b: Entry['bundledBy']): BundledAt | undefined => b && {
    ...(b.resolved !== undefined && { resolved: b.resolved }), ...(b.integrity !== undefined && { integrity: b.integrity }), folder: b.folder,
  };
  // At most 20 dependents each: context for the security focus, not an inventory.
  const dependents = (name: string, removed: boolean) => [...((removed ? baseLock : headLock).pulledBy.get(name) ?? [])].sort().slice(0, 20);
  const lines = headLock.lines ?? (head === undefined ? new Map<string, number>() : versionLines(head));
  const changes: PackageChange[] = [];
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const was = old.get(name) ?? new Map<string, Entry[]>();
    const is = now.get(name) ?? new Map<string, Entry[]>();
    // `baseInstall` is the install a move or swap replaced, for where the old version resolved.
    const push = (e: Entry, from?: string, to?: string, baseInstall?: Entry) => {
      const pulledBy = dependents(name, to === undefined);
      if (to !== undefined && e.bundledBy) {
        const folders = listed.get(e.bundledBy.bundler) ?? [];
        folders.push(e.bundledBy.folder.toLowerCase());
        listed.set(e.bundledBy.bundler, folders);
      }
      changes.push({
        name, ...(from !== undefined && { from }), ...(to !== undefined && { to }),
        ...(e.resolved !== undefined && { resolved: e.resolved }), ...(e.integrity !== undefined && { integrity: e.integrity }),
        ...(to !== undefined && baseInstall?.resolved !== undefined && { fromResolved: baseInstall.resolved }),
        ...(to !== undefined && baseInstall?.integrity !== undefined && { fromIntegrity: baseInstall.integrity }),
        ...(to !== undefined && e.bundledBy && { bundledIn: at(e.bundledBy) }),
        ...(to !== undefined && baseInstall?.bundledBy && { fromBundledIn: at(baseInstall.bundledBy) }),
        ...(to !== undefined && lines.has(e.key) && { line: lines.get(e.key) }),
        ...(pulledBy.length && { pulledBy }),
        ...((to === undefined ? baseLock : headLock).partial && { pulledByPartial: true as const }),
      });
      if (to !== undefined && !e.bundledBy) bundlers.set(e.key, changes.at(-1)!);
    };
    const removed = [...was.keys()].filter((v) => !is.has(v)).sort(byVersion);
    const added = [...is.keys()].filter((v) => !was.has(v)).sort(byVersion);
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const [from, to] = [removed[i], added[i]];
      push(to !== undefined ? is.get(to)![0]! : was.get(from!)![0]!, from, to, from === undefined ? undefined : was.get(from)![0]);
    }
    // The same version from somewhere new, in any place it is installed: a swapped tarball is not "unmoved". An install
    // is held to the base's install at the same place when that was this package at this version (an alias can change
    // what a place holds), else to every base install of it; a
    // version the base didn't have is held to its own first install, which the move above reported.
    for (const [v, installs] of is) {
      const known = new Set(was.get(v)?.map(source) ?? [source(installs[0]!)]);
      const here = (e: Entry) => {
        const there = atKey.get(e.key);
        return there?.name === name && there.version === v ? there : undefined;
      };
      const swapped = installs.find((e) => {
        const there = here(e);
        return there ? source(there) !== source(e) : !known.has(source(e));
      });
      if (swapped) push(swapped, v, v, here(swapped) ?? was.get(v)?.[0]);
    }
  }
  for (const [key, c] of bundlers) if (listed.has(key)) c.bundles = listed.get(key);
  return changes;
}

// ponytail: past this a run looks nothing up and blocks; batch by name (`affects` takes many) and match ranges in code
// if big bumps hit it.
const MAX_LOOKUPS = 1000;
const LOOKUPS_AT_ONCE = 8;

/**
 * Look up the Advisories against both sides of every package change, once per name and version, and classify them on
 * each change. Withdrawn ones don't count. Any failed lookup, or more lookups than a run makes, fails them all.
 */
export async function lookUpAdvisories(check: DependencyCheck, lookup: (name: string, version: string) => Promise<Advisory[]>) {
  const changes = check.lockfiles.flatMap((l) => l.changes);
  const key = (name: string, version: string) => `${name}@${version}`;
  const wanted = new Map<string, [string, string]>();
  for (const c of changes) for (const v of [c.from, c.to]) if (v !== undefined) wanted.set(key(c.name, v), [c.name, v]);
  if (wanted.size > MAX_LOOKUPS) {
    check.advisoryError = `${wanted.size} package versions to look up, over the run's ${MAX_LOOKUPS}`;
    return;
  }
  const found = new Map<string, Advisory[]>();
  const queue = [...wanted];
  try {
    await Promise.all(Array.from({ length: LOOKUPS_AT_ONCE }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [k, [name, version]] = next;
        // The first failure empties the queue, so the other lookups stop too.
        found.set(k, (await lookup(name, version).catch((err) => { queue.length = 0; throw err; })).filter((a) => !a.withdrawn));
      }
    }));
  } catch (err) {
    check.advisoryError = err instanceof Error ? err.message : String(err);
    return;
  }
  const strip = ({ withdrawn: _, ...a }: Advisory) => a;
  for (const c of changes) {
    const [before, after] = [c.from, c.to].map((v) => (v === undefined ? [] : found.get(key(c.name, v))!)) as [Advisory[], Advisory[]];
    const [was, is] = [new Set(before.map((a) => a.id)), new Set(after.map((a) => a.id))];
    const advisories: ClassifiedAdvisory[] = [
      ...after.map((a) => ({ ...strip(a), status: was.has(a.id) ? 'still open' as const : 'introduced' as const })),
      ...before.filter((a) => !is.has(a.id)).map((a) => ({ ...strip(a), status: 'fixed' as const })),
    ];
    if (advisories.length) c.advisories = advisories;
  }
}

/** Whether a URL is on npm's default registry, the only host the check fetches tarballs from. */
export const onRegistry = (url: string) => url.startsWith(REGISTRY);

/**
 * A tar archive's regular files by path below its top folder (`package/` in an npm tarball, though some use another
 * name), as npm extracts them (node-tar, stripping that folder): a pax `path` or GNU long name replaces the next entry's
 * own name (and a pax `size` its size), a path with a `..` segment or an absolute one is dropped, and a later entry for
 * a path replaces an earlier one. Anything a reader might take another way than node-tar throws instead, so the package
 * is not inspected: truncated input, a header whose checksum is wrong or whose magic is neither POSIX ustar, GNU nor
 * none, anything but zero blocks after the first zero block, a malformed pax record or one holding a newline, meta
 * headers chained, any entry type but a file or directory, a path with an empty, `.` or backslashed segment or any
 * character but printable ASCII, and two paths that a case-insensitive filesystem (macOS, Windows) would take for one.
 */
export function untar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const malformed = () => new Error('malformed tar archive');
  const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  const field = (h: Buffer, at: number, len: number) => text(h.subarray(at, at + len));
  let next: { path?: string; size?: number } | undefined;
  /** Each path as a case-insensitive filesystem sees it, to the path stored. */
  const folded = new Map<string, string>();
  for (let at = 0; at + 512 <= archive.length;) {
    const h = archive.subarray(at, at + 512);
    if (h.every((b) => b === 0)) {
      if (archive.subarray(at).some((b) => b !== 0)) throw malformed();
      break;
    }
    // node-tar skips a header whose checksum isn't the unsigned sum: refused rather than read.
    const stored = parseInt(field(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (stored !== sum) throw malformed();
    // node-tar reads the prefix field only under POSIX ustar's magic; GNU's puts other fields there.
    const magic = h.subarray(257, 265).toString('latin1');
    const posixUstar = magic === 'ustar\x0000';
    if (!posixUstar && magic !== 'ustar  \x00' && !/^\x00*$/.test(magic)) throw malformed();
    const size = next?.size ?? parseInt(field(h, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > archive.length) throw malformed();
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    const type = field(h, 156, 1);
    if (type === 'x' || type === 'L') {
      if (next) throw malformed();
      next = type === 'L' ? { path: text(data) } : paxRecords(data);
      continue;
    }
    const prefix = posixUstar ? field(h, 345, 155) : '';
    const raw = next?.path ?? (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    next = undefined;
    // Directories hold no code; a link can replace a file when extracted, so it and any other type (devices, GNU or
    // Solaris extensions, unknown) are refused.
    if (type === '5') continue;
    if (!['0', '', '7'].includes(type)) throw malformed();
    const segments = raw.split('/');
    if (raw.startsWith('/') || segments.includes('..')) continue;
    // Windows takes `package.json.`, `package.json ` and `package.json::$DATA` for `package.json`: refused, like `.`.
    if (raw.includes('\\') || raw.includes(':') || segments.some((x) => x === '' || x === '.' || /[. ]$/.test(x))) throw malformed();
    if (segments.length < 2) continue;
    const path = segments.slice(1).join('/');
    // Filesystems fold non-ASCII case and normalization their own ways: such a path is refused, so ASCII case is all.
    if (/[^\x20-\x7e]/.test(path)) throw malformed();
    const fold = path.toLowerCase();
    if ((folded.get(fold) ?? path) !== path) throw malformed();
    folded.set(fold, path);
    files.set(path, data);
  }
  return files;
}

/** A pax header's `path` and `size`, read record by record by each one's byte length, as node-tar reads them. */
function paxRecords(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const len = Number(data.subarray(at, space).toString('latin1'));
    const record = data.subarray(at, at + len).toString('utf8');
    const eq = record.indexOf('=');
    if (space < 0 || !/^[1-9]\d*$/.test(data.subarray(at, space).toString('latin1')) || at + len > data.length
      || !record.endsWith('\n') || eq < 0) throw new Error('malformed tar archive');
    const [key, value] = [record.slice(space - at + 1, eq), record.slice(eq + 1, -1)];
    // node-tar splits records on newlines: one holding another, in its key or value, would be read two ways.
    // So does invalid UTF-8, which node-tar decodes to replacement characters and then measures again.
    if (record.slice(0, -1).includes('\n') || !/^[\w.-]+$/.test(key) || Buffer.byteLength(record) !== len) {
      throw new Error('malformed tar archive');
    }
    if (key === 'path') out.path = value;
    if (key === 'size') {
      if (!/^\d+$/.test(value)) throw new Error('malformed tar archive');
      out.size = Number(value);
    }
    at += len;
  }
  return out;
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** The hash algorithms npm (ssri) knows, weakest first. */
const ALGORITHMS = ['sha1', 'sha256', 'sha384', 'sha512'];

/**
 * Whether a tarball matches a lockfile integrity (Subresource Integrity: one or more `algo-base64` hashes), as npm
 * checks before installing: by the strongest algorithm it knows among them, any hash of that one. One with none it
 * knows matches nothing.
 */
function matchesIntegrity(body: Buffer, integrity: string): boolean {
  const hashes = integrity.trim().split(/\s+/).flatMap((h) => {
    const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(h);
    return m ? [{ algorithm: m[1]!, digest: m[2]! }] : [];
  });
  const strongest = ALGORITHMS.findLast((a) => hashes.some((h) => h.algorithm === a));
  if (strongest === undefined) return false;
  const digest = createHash(strongest).update(body).digest('base64');
  return hashes.some((h) => h.algorithm === strongest && h.digest === digest);
}
// ponytail: unpacked bytes per run are capped at this multiple of the fetch byte cap, against a gzip bomb. Raise it if
// ordinary packages hit it.
const UNPACKED_PER_FETCHED = 8;

/** A bundled package's manifest in a (lowercased) tarball path, at any depth. */
const BUNDLED = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+)package\.json$/;

/**
 * The install scripts of every bundled package in a tarball that isn't in `listed` (the lockfile's own bundled entries,
 * inspected on their own): npm installs whatever the tarball bundles. Keyed by folder and name.
 */
function unlistedScripts(lower: Map<string, Buffer>, listed: readonly string[]): Record<string, string> {
  const skip = new Set(listed);
  const found: Record<string, string> = {};
  for (const path of lower.keys()) {
    const folder = BUNDLED.exec(path)?.[1]?.slice(0, -1);
    if (folder === undefined || skip.has(folder)) continue;
    for (const [k, v] of Object.entries(installScripts(lower, folder))) found[`${folder} ${k}`] = v;
  }
  return found;
}

/**
 * The install scripts of the package in `folder` of a tarball (its own when empty), found in any case as a
 * case-insensitive filesystem would (`lower` maps each lowercased path to its file; the tarball has no two such), by
 * name. Its manifest must record `version` when given. As npm (`@npmcli/run-script`) runs them: an empty one runs nothing,
 * and with neither `install` nor `preinstall` set, a `binding.gyp` runs `node-gyp rebuild` unless `gypfile` is false.
 */
function installScripts(lower: Map<string, Buffer>, folder: string, version?: string): Record<string, string> {
  const dir = folder && `${folder}/`.toLowerCase();
  const manifest = lower.get(`${dir}package.json`);
  if (manifest === undefined) throw new Error(folder ? `not in its bundler's tarball at ${folder}` : 'no package.json');
  const pkg = JSON.parse(manifest.toString('utf8'));
  if (version !== undefined && pkg?.version !== version) throw new Error(`not in its bundler's tarball at ${folder} ${version}`);
  const scripts = pkg?.scripts;
  const found: Record<string, string> = Object.fromEntries(INSTALL_SCRIPTS.filter((k) => typeof scripts?.[k] === 'string' && scripts[k])
    .map((k) => [k, scripts[k]]));
  if (lower.has(`${dir}binding.gyp`) && !found.install && !found.preinstall && pkg?.gypfile !== false) found.install = 'node-gyp rebuild';
  return found;
}

/**
 * Fetch the tarball of every package change the PR moves to or adds, and of the version it moved from, and record each
 * install script the new one adds. Packages go in order of risk (added, then major bumps, then the rest), at most
 * `caps.packages` (by name and version, across lockfiles) and `caps.bytes` downloaded per run; one tarball is fetched
 * once. A bundled package is read from its bundler's tarball, at its folder and the version the lockfile records, on
 * each side (a bundled install whose bundler changed is a change, though its version didn't move). An install script is
 * new when its name or its command is.
 * A package past either cap, or whose code (old or new) couldn't be fetched and read, isn't on the registry or isn't
 * recorded, is not inspected. A failed fetch still spends the bytes it received.
 * Between fetches, once `stopped` says so, it returns at once, leaving the check incomplete: the run is superseded.
 * `fetched` hears each fetch, or why it failed.
 */
export async function inspectPackages(check: DependencyCheck, opts: {
  fetch: (url: string, maxBytes: number) => Promise<Buffer>; caps: { packages: number; bytes: number };
  stopped: () => boolean; fetched: (url: string, result: { bytes: number } | { error: string }) => void;
}) {
  const { caps } = opts;
  const major = (v: string) => v.split('.')[0];
  const risk = (c: PackageChange) => (c.from === undefined ? 0 : major(c.from) !== major(c.to!) ? 1 : 2);
  const wanted = check.lockfiles.flatMap(({ path, changes }) => changes.filter((c) => c.to !== undefined)
    .map((c) => ({ path, c }))).sort((a, b) => risk(a.c) - risk(b.c));
  const allowed = new Set([...new Set(wanted.map(({ c }) => `${c.name}@${c.to}`))].slice(0, caps.packages));
  /** Each tarball's files by lowercased path and its body (for integrity), or why it couldn't be read. */
  const byUrl = new Map<string, { files: Map<string, Buffer>; body: Buffer } | Error>();
  const parsed = new Map<string, Record<string, string>>();
  let [bytes, unpacked, tarballs] = [0, 0, 0];
  // Old versions are fetched too, and a failed fetch spends only the bytes it received: the tarballs a run asks for are
  // capped as well.
  const maxTarballs = caps.packages * 2;
  /** A tarball's files, fetched once per run; undefined once the run is superseded. */
  const filesAt = async (url: string | undefined, integrity: string | undefined) => {
    if (url === undefined) throw new Error('no source recorded');
    if (!onRegistry(url)) throw new Error('not on the npm registry');
    if (!byUrl.has(url)) {
      if (opts.stopped()) return;
      try {
        if (bytes >= caps.bytes) throw new Error(`over the run's cap of ${caps.bytes} bytes fetched`);
        if (++tarballs > maxTarballs) throw new Error(`over the run's cap of ${maxTarballs} tarballs fetched`);
        const body = await opts.fetch(url, caps.bytes - bytes);
        bytes += body.length;
        opts.fetched(url, { bytes: body.length });
        let tar: Buffer;
        try {
          tar = gunzipSync(body, { maxOutputLength: Math.max(1, caps.bytes * UNPACKED_PER_FETCHED - unpacked) });
        } catch (err) {
          // A failed unpack may have produced any amount before failing (past the limit, a bad trailer): the rest of the
          // allowance is spent, so no later tarball can unpack that much again.
          unpacked = caps.bytes * UNPACKED_PER_FETCHED;
          throw err;
        }
        unpacked += tar.length;
        byUrl.set(url, { files: new Map([...untar(tar)].map(([k, v]) => [k.toLowerCase(), v])), body });
      } catch (err) {
        if (err instanceof FetchError) bytes += err.received;
        const error = err instanceof Error ? err : new Error(String(err));
        opts.fetched(url, { error: error.message });
        byUrl.set(url, error);
      }
    }
    const result = byUrl.get(url)!;
    if (result instanceof Error) throw result;
    if (integrity !== undefined && !matchesIntegrity(result.body, integrity)) {
      throw new Error("the registry's tarball doesn't match the lockfile's integrity");
    }
    return result.files;
  };
  /**
   * One side's install scripts: its own tarball's, or its bundler's at its folder (and version). A package's own come
   * with those of the bundled packages in its tarball the lockfile doesn't list (at base, all of them).
   */
  const scripts = async (
    resolved: string | undefined, integrity: string | undefined, bundled: BundledAt | undefined, version: string, listed: readonly string[],
  ) => {
    const url = bundled ? bundled.resolved : resolved;
    const files = await filesAt(url, bundled ? bundled.integrity : integrity);
    if (!files) return;
    const key = `${url}\0${bundled?.folder ?? ''}\0${bundled ? version : listed.join('\0')}`;
    if (!parsed.has(key)) {
      parsed.set(key, bundled ? installScripts(files, bundled.folder, version) : { ...installScripts(files, ''), ...unlistedScripts(files, listed) });
    }
    return parsed.get(key)!;
  };
  const notInspected: NotInspected[] = [];
  for (const { path, c } of wanted) {
    const skip = (reason: string) => notInspected.push({ path, name: c.name, version: c.to!, reason });
    if (!allowed.has(`${c.name}@${c.to}`)) { skip(`over the run's cap of ${caps.packages} packages`); continue; }
    try {
      const now = await scripts(c.resolved, c.integrity, c.bundledIn, c.to!, c.bundles ?? []);
      const before = c.from === undefined ? {} : await scripts(c.fromResolved, c.fromIntegrity, c.fromBundledIn, c.from, []);
      if (!now || !before) return;
      const added = Object.entries(now).filter(([k, v]) => before[k] !== v);
      if (added.length) c.installScripts = Object.fromEntries(added);
    } catch (err) {
      skip((err as Error).message);
    }
  }
  if (notInspected.length) check.notInspected = notInspected.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

/**
 * Where an off-registry package resolves from, in words; undefined for the registry, or none recorded (bundled).
 * ponytail: the kind is a guess from the URL's shape, for the comment's wording only; every kind is a Finding alike.
 */
function offRegistry(resolved: string | undefined): string | undefined {
  if (resolved === undefined || resolved.startsWith(REGISTRY)) return;
  let host: string | undefined;
  try {
    host = new URL(resolved.replace(/^git\+/, '')).hostname || undefined;
  } catch { /* not a URL: a git shorthand or a local path */ }
  const kind = /^(?:git[+:]|github:|gitlab:|bitbucket:)/.test(resolved) || /\.git(?:#|$)/.test(resolved) ? 'a git repository'
    : resolved.startsWith('file:') ? 'a local path'
      : /^https?:/.test(resolved) ? (resolved.includes('/-/') ? 'another registry' : 'a plain URL') : 'an unrecognised source';
  return host ? `${kind} on \`${host}\`` : kind;
}

/**
 * The Findings the check makes, attributed to the security focus: each introduced Advisory, at its own severity, and
 * each package the PR moves to or adds that resolves from outside the registry, at medium. Confidence 1.0: no model
 * judged them. Titles name the package and the kind (and Advisory ID), never the version, so a later push that still
 * has the problem matches its Thread. A change with no version line (a minified lockfile) anchors on line 1.
 */
/**
 * A package name for a title, which is the Finding's identity once sanitized for posting. A plain name survives that
 * unchanged but for a mark after a scope's `@`. Any other (a link, a zero-width space, markdown, anything odd) keeps
 * only plain characters, the rest shown as `?`, plus a hash of the whole name that sanitizing can't reach (hex, after a
 * space, in parentheses), so two names that would look alike once posted stay two Findings.
 */
function titleName(name: string): string {
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) && !/www\./i.test(name) ? name
    : `${name.replace(/[^\w.@/-]/g, '?')} (name ${createHash('sha256').update(name).digest('hex').slice(0, 32)})`;
}

export function dependencyFindings(check: DependencyCheck): Finding[] {
  return check.lockfiles.flatMap(({ path, changes }) => changes.filter((c) => c.to !== undefined).flatMap((c) => {
    const at = { path, line: c.line ?? 1, confidence: 1, check: true as const };
    const move = `${c.name} ${describeMove(c)}`;
    const where = offRegistry(c.resolved);
    return [
      ...(c.advisories ?? []).filter((a) => a.status === 'introduced').map((a): Finding => ({
        ...at, title: `Advisory ${a.id} in ${titleName(c.name)}`, severity: a.severity,
        evidence: `${a.id} (\`${a.severity}\`): ${a.summary}\n\nIt affects ${move}${c.from === undefined || c.from === c.to ? ''
          : ', and not the version it replaced'}. ${a.firstPatched ? `First patched in ${a.firstPatched}.` : 'No patched version is published yet.'}`,
      })),
      ...(c.installScripts ? [{
        ...at, title: `${titleName(c.name)} adds an install script`, severity: 'high' as const,
        evidence: `${move} ${c.from === undefined ? 'is new and runs' : 'now runs'} code when it is installed:\n\n${
          Object.entries(c.installScripts).map(([k, v]) => `- \`${k}\`: \`${v.replace(/[`\s]+/g, ' ').slice(0, 200)}\``).join('\n')}`,
      }] : []),
      ...(where ? [{
        ...at, title: `${titleName(c.name)} resolves from outside the npm registry`, severity: 'medium' as const,
        evidence: `${move} resolves from ${where}, not registry.npmjs.org: what installs is not what the registry publishes, `
          + 'and its advisories may not cover it.',
      }] : []),
    ];
  }));
}

// ponytail: past this many package changes the rest are only counted; page through them with a tool if big bumps need it.
const MAX_DESCRIBED = 300;
// Each PR-controlled field is clipped on its own, so the check's notes after it always fit within the line's cap.
const MAX_FIELD = 200;
const MAX_LINE = 8000;
const clip = (s: string, max = MAX_FIELD) => (s.length > max ? `${s.slice(0, max)}…` : s);
const major = (v: string) => v.split('.')[0];

/**
 * A source without what could be a credential: URL userinfo (`user:token@`) and the query string. A git URL's `#commit`
 * stays: it says what installs.
 */
function redact(resolved: string): string {
  try {
    const url = new URL(resolved);
    url.username = url.password = url.search = '';
    return url.href;
  } catch {
    return resolved.replace(/^([^/?#]*\/\/)[^/?#@]*@/, '$1').replace(/\?[^#]*/, '');
  }
}

/**
 * The check's output as the security focus reads it, inside an untrusted-data block: package names, versions, sources
 * and advisory summaries all come from the PR or the advisory database.
 */
export function describeCheck(check: DependencyCheck): string {
  let room = MAX_DESCRIBED;
  const lines: string[] = [];
  // Names, paths and sources are the PR's: one line each, so none can forge another (a fake "fixed" Advisory), and no
  // `<`, so none even looks like a tag that closes the block. No package name or version has one.
  const line = (l: string) => void lines.push(l.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/</g, '\u2039').slice(0, MAX_LINE));
  for (const { path, changes } of check.lockfiles) {
    line(`${clip(path)}:`);
    if (!changes.length) line('- no packages moved');
    for (const c of changes.slice(0, Math.max(0, room))) {
      const notes = [
        c.from !== undefined && c.to !== undefined && c.from !== c.to && major(c.from) !== major(c.to) && 'major version bump',
        c.line !== undefined && `line ${c.line}`,
        c.resolved !== undefined && !c.resolved.startsWith(REGISTRY) && `resolved from ${clip(redact(c.resolved))}`,
        c.pulledBy && `pulled in by ${c.pulledBy.map((d) => clip(d, 100)).join(', ')}`,
        c.pulledByPartial && 'dependents only partly recorded (the lockfile has more dependency entries than the check reads)',
        c.installScripts && `new install scripts: ${Object.entries(c.installScripts).map(([k, v]) => `${clip(k, 100)}: ${clip(v, 200)}`).join(', ')}`,
      ].filter(Boolean);
      const move = describeMove({ ...c, from: c.from && clip(c.from), to: c.to && clip(c.to) });
      line(`- ${clip(c.name)} ${move}${notes.length ? `, ${notes.join('; ')}` : ''}`);
      for (const a of c.advisories ?? []) {
        line(`  - ${a.status}: ${a.id} (${a.severity}): ${clip(a.summary, 1000)}${a.firstPatched ? `. First patched in ${a.firstPatched}` : ''}`);
      }
    }
    if (changes.length > room) line(`- …and ${changes.length - Math.max(0, room)} more package changes, not listed`);
    room -= changes.length;
  }
  if (check.advisoryError !== undefined) line("Advisories couldn't be looked up: none are listed.");
  if (check.unreadable.length) line(`Lockfiles the check couldn't understand: ${check.unreadable.slice(0, 20).map((p) => clip(p)).join(', ')}`);
  if (check.notInspected?.length) {
    line(`Packages whose published code the check couldn't fetch and read (not inspected): ${
      check.notInspected.slice(0, 20).map((n) => `${clip(n.name)} ${clip(n.version)}`).join(', ')}${check.notInspected.length > 20 ? ', …' : ''}`);
  }
  return lines.join('\n');
}
