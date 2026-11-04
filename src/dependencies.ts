// The Dependency check: code, never a model, compares a PR's lockfiles at base and head (ADR 0002).
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ToolError, type FileChange, type Source } from './git.ts';
import type { Advisory } from './ports.ts';
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
  /** The name of the package whose tarball it is installed from (`inBundle`), at head (at base for a removal). */
  bundledIn?: string;
  /** Its `"version"` line at head; unset for a removed package. */
  line?: number;
  /** The Advisories open against either side, once looked up; unset when none are. */
  advisories?: ClassifiedAdvisory[];
  /** Install scripts its fetched tarball has that the version it moved from didn't (any, when added), by name. */
  installScripts?: Record<string, string>;
}

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

const SUPPORTED = new Set(['package-lock.json']);
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
interface Entry { name: string; version: string; resolved?: string; integrity?: string; key: string; bundledBy?: string }

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
  // Far past any real lockfile (big monorepos have about 10,000): a PR can't make the comparison hold more than this.
  let count = 0;
  for (const _ in packages) if (++count > MAX_ENTRIES) return;
  const out: Entry[] = [];
  for (const key in packages) {
    const e = packages[key];
    if (typeof e !== 'object' || e === null) return;
    const at = key.lastIndexOf('node_modules/');
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
    // Bundled only as npm writes it: `inBundle`, no source of its own, nested in the package that bundles it.
    const bundledBy = e.inBundle === true && resolved === undefined && at > 0 ? key.slice(0, at - 1) : undefined;
    out.push({ name, version: e.version, resolved, integrity: str(e.integrity), key, ...(bundledBy !== undefined && { bundledBy }) });
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
      if (text <= MAX_RUN_TEXT) changes = compareLockfile(base, head);
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
export function compareLockfile(base: string | undefined, head: string | undefined): PackageChange[] | undefined {
  const [before, after] = [entries(base), entries(head)];
  if (!before || !after) return;
  const [old, now] = [byName(before), byName(after)];
  const atKey = new Map(before.map((e) => [e.key, e]));
  const lines = head === undefined ? new Map<string, number>() : versionLines(head);
  const atHead = new Map(after.map((e) => [e.key, e]));
  const changes: PackageChange[] = [];
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const was = old.get(name) ?? new Map<string, Entry[]>();
    const is = now.get(name) ?? new Map<string, Entry[]>();
    // `baseInstall` is the install a move or swap replaced, for where the old version resolved.
    const push = (e: Entry, from?: string, to?: string, baseInstall?: Entry) => changes.push({
      name, ...(from !== undefined && { from }), ...(to !== undefined && { to }),
      ...(e.resolved !== undefined && { resolved: e.resolved }), ...(e.integrity !== undefined && { integrity: e.integrity }),
      ...(to !== undefined && baseInstall?.resolved !== undefined && { fromResolved: baseInstall.resolved }),
      ...(e.bundledBy !== undefined && { bundledIn: (to !== undefined ? atHead : atKey).get(e.bundledBy)?.name ?? e.bundledBy }),
      ...(to !== undefined && lines.has(e.key) && { line: lines.get(e.key) }),
    });
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
 * is not inspected: truncated input, a malformed pax record, meta headers chained or global, a path with an empty, `.`
 * or backslashed segment.
 */
export function untar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const malformed = () => new Error('malformed tar archive');
  const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  const field = (h: Buffer, at: number, len: number) => text(h.subarray(at, at + len));
  let next: { path?: string; size?: number } | undefined;
  for (let at = 0; at + 512 <= archive.length;) {
    const h = archive.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = next?.size ?? parseInt(field(h, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > archive.length) throw malformed();
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    const type = field(h, 156, 1);
    if (type === 'g') throw malformed();
    if (type === 'x' || type === 'L') {
      if (next) throw malformed();
      next = type === 'L' ? { path: text(data) } : paxRecords(data);
      continue;
    }
    const prefix = field(h, 257, 6) === 'ustar' ? field(h, 345, 155) : '';
    const raw = next?.path ?? (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    next = undefined;
    if (!['0', '', '7'].includes(type)) continue;
    const segments = raw.split('/');
    if (raw.startsWith('/') || segments.includes('..')) continue;
    if (raw.includes('\\') || segments.some((x) => x === '' || x === '.')) throw malformed();
    if (segments.length > 1) files.set(segments.slice(1).join('/'), data);
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
// ponytail: unpacked bytes per run are capped at this multiple of the fetch byte cap, against a gzip bomb. Raise it if
// ordinary packages hit it.
const UNPACKED_PER_FETCHED = 8;

/** A package's install scripts, from its tarball's files: npm runs `node-gyp rebuild` for a `binding.gyp` with neither `install` nor `preinstall`. */
function installScripts(files: Map<string, Buffer>): Record<string, string> {
  const manifest = files.get('package.json');
  if (manifest === undefined) throw new Error('no package.json');
  const scripts = JSON.parse(manifest.toString('utf8'))?.scripts;
  const found: Record<string, string> = Object.fromEntries(INSTALL_SCRIPTS.filter((k) => typeof scripts?.[k] === 'string').map((k) => [k, scripts[k]]));
  if (files.has('binding.gyp') && !found.install && !found.preinstall) found.install = 'node-gyp rebuild';
  return found;
}

/**
 * Fetch the tarball of every package change the PR moves to or adds, and of the version it moved from, and record each
 * install script the new one adds. Packages go in order of risk (added, then major bumps, then the rest), at most
 * `caps.packages` (by name and version, across lockfiles) and `caps.bytes` downloaded per run; one tarball is fetched
 * once. A package past either cap, or whose tarball (old or new) couldn't be fetched or read, isn't on the registry or
 * isn't recorded, is not inspected. A bundled one isn't fetched: its code is in its bundling package's tarball, so it is
 * inspected only when that package is.
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
  const wanted = check.lockfiles.flatMap(({ path, changes }) => changes.filter((c) => c.to !== undefined && c.bundledIn === undefined)
    .map((c) => ({ path, c }))).sort((a, b) => risk(a.c) - risk(b.c));
  const allowed = new Set([...new Set(wanted.map(({ c }) => `${c.name}@${c.to}`))].slice(0, caps.packages));
  const byUrl = new Map<string, Record<string, string> | Error>();
  let [bytes, unpacked] = [0, 0];
  /** A tarball's install scripts, fetched once per run; undefined once the run is superseded. */
  const scriptsAt = async (url: string | undefined) => {
    if (url === undefined) throw new Error('no source recorded');
    if (!onRegistry(url)) throw new Error('not on the npm registry');
    if (!byUrl.has(url)) {
      if (opts.stopped()) return;
      try {
        if (bytes >= caps.bytes) throw new Error(`over the run's cap of ${caps.bytes} bytes fetched`);
        const body = await opts.fetch(url, caps.bytes - bytes);
        bytes += body.length;
        opts.fetched(url, { bytes: body.length });
        const tar = gunzipSync(body, { maxOutputLength: Math.max(1, caps.bytes * UNPACKED_PER_FETCHED - unpacked) });
        unpacked += tar.length;
        byUrl.set(url, installScripts(untar(tar)));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        opts.fetched(url, { error: error.message });
        byUrl.set(url, error);
      }
    }
    const result = byUrl.get(url)!;
    if (result instanceof Error) throw result;
    return result;
  };
  const notInspected: NotInspected[] = [];
  for (const { path, c } of wanted) {
    const skip = (reason: string) => notInspected.push({ path, name: c.name, version: c.to!, reason });
    if (!allowed.has(`${c.name}@${c.to}`)) { skip(`over the run's cap of ${caps.packages} packages`); continue; }
    try {
      const now = await scriptsAt(c.resolved);
      const before = c.from === undefined ? {} : await scriptsAt(c.fromResolved);
      if (!now || !before) return;
      const added = Object.entries(now).filter(([k]) => !(k in before));
      if (added.length) c.installScripts = Object.fromEntries(added);
    } catch (err) {
      skip((err as Error).message);
    }
  }
  // A bundled package's code is its bundling package's: inspected along with it, when that moved too and was inspected.
  for (const { path, changes } of check.lockfiles) for (const c of changes) {
    if (c.to === undefined || c.bundledIn === undefined) continue;
    const parent = wanted.some((w) => w.path === path && w.c.name === c.bundledIn)
      && !notInspected.some((n) => n.path === path && n.name === c.bundledIn);
    if (!parent) notInspected.push({ path, name: c.name, version: c.to, reason: `bundled in ${c.bundledIn}, which wasn't inspected` });
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
