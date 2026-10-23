// Source access through git objects only: a bare, blobless clone per repository,
// never a working tree. Nothing from the repository is ever executed.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Git env isolated from the host's config. The token travels as an HTTP header, never in argv, URLs or on disk. */
function gitEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Host attribute files must not sway exclusions or diffs.
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
    GIT_CONFIG_KEY_1: 'core.attributesFile',
    GIT_CONFIG_VALUE_1: '/dev/null',
  };
}

/** One changed file. Rename detection is on, so a pure rename or move has no added or deleted lines. */
export interface FileChange {
  path: string;
  /** Set when the file was renamed or moved. */
  oldPath?: string;
  added: number;
  deleted: number;
  /** Git saw binary content, so there are no line counts. */
  binary?: true;
}

/** A problem with tool input or repository content that is safe to report; any other failure is reported generically. */
export class ToolError extends Error {}

// Inputs are `unknown` because they come straight from model tool calls.
export interface Source {
  /** A file at head, optionally lines start..end (1-based, inclusive). */
  readFile(path: unknown, start?: unknown, end?: unknown): Promise<string>;
  /** git grep at head, optionally limited to a path glob. */
  grep(pattern: unknown, glob?: unknown): Promise<string>;
  /** A directory at head; the root when no path is given. */
  listDir(path?: unknown): Promise<string>;
  /** The PR diff, base...head, optionally for one path. */
  diff(path?: unknown): Promise<string>;
  /** The PR diff limited to the given paths: what the reviewers are given and what comments anchor against. */
  reviewDiff(paths: string[]): Promise<string>;
  /**
   * Like reviewDiff, but from an earlier head, reviewed against an earlier base, to this one. Files the base changed
   * since then are given whole, as in reviewDiff. Undefined if either can't be fetched, or that base isn't an ancestor
   * of this one: a retarget can bring in lines no review saw.
   */
  diffSince(sha: string, base: string, files: FileChange[]): Promise<string | undefined>;
  changedFiles(): Promise<FileChange[]>;
  /** The paths marked linguist-generated or linguist-vendored by .gitattributes at the base SHA. */
  markedAtBase(paths: string[]): Promise<Set<string>>;
  /** A regular file at the base SHA, or undefined if there is none. Throws ToolError for a symlink, directory or oversized file. */
  fileAtBase(path: string): Promise<string | undefined>;
  /**
   * A file's text on one side of the PR diff: `base` is the merge-base, `head` the head. Undefined where the file
   * doesn't exist. Throws ToolError for a symlink, directory or file over 32 MiB.
   */
  fileAtSide(side: 'base' | 'head', path: string): Promise<string | undefined>;
}

// ponytail: fixed cap on grep output lines; make it a budget when per-agent budgets land.
const MAX_GREP_LINES = 200;

const SYMLINK_MODE = '120000';
const MAX_BASE_FILE_BYTES = 64 * 1024;
const MAX_SIDE_BYTES = 32 * 1024 * 1024;

/** A repository-relative path: not absolute, no empty, "." or ".." segments. One trailing "/" is allowed, as list_dir prints. */
function checkPath(path: unknown): string {
  const p = typeof path === 'string' ? path.replace(/(.)\/$/, '$1') : undefined;
  if (p === undefined || !p.split('/').every((s) => s && s !== '.' && s !== '..')) {
    throw new ToolError('path must be repository-relative, without "." or ".." segments');
  }
  return p;
}

/** Models send null for omitted optional arguments. */
const omitted = (v: unknown): v is null | undefined => v === undefined || v === null;

function optionalLine(n: unknown): number | undefined {
  if (omitted(n)) return undefined;
  if (!(Number.isInteger(n) && (n as number) >= 1)) throw new ToolError('line numbers must be integers >= 1');
  return n as number;
}

/** Fetch exactly the head and base SHAs into the repository's bare clone and read at the pinned head. */
export async function openSource(opts: {
  dataDir: string; repo: string; url: string; token: string; headSha: string; baseSha: string;
}): Promise<Source> {
  const { headSha, baseSha } = opts;
  const dir = join(opts.dataDir, 'repos', opts.repo.replace('/', '__') + '.git');
  const env = gitEnv(opts.token);
  // Blobs are fetched lazily from the promisor remote, so reads need the same env.
  const gitWithInput = async (input: string | undefined, args: string[], extraEnv?: NodeJS.ProcessEnv) => {
    const p = run('git', ['-C', dir, ...args], { env: { ...env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
    if (input !== undefined) p.child.stdin!.end(input);
    return (await p).stdout;
  };
  const git = (...args: string[]) => gitWithInput(undefined, args);
  const range = `${baseSha}...${headSha}`;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    await git('init', '-q', '--bare');
    await git('config', 'remote.origin.promisor', 'true');
    await git('config', 'remote.origin.partialclonefilter', 'blob:none');
  }
  await git('config', 'remote.origin.url', opts.url);
  await git('fetch', '-q', '--filter=blob:none', 'origin', headSha, baseSha);

  /** The tree's entry at path (head by default), if any. Symlinks are never followed: a tree stores only the link target. */
  async function entry(path: string, sha = headSha) {
    const out = await git('--literal-pathspecs', 'ls-tree', '-z', sha, '--', path);
    const e = treeEntries(out)[0];
    return e?.name === path ? e : undefined;
  }

  /** A regular file at `sha`, or undefined if there is none. */
  async function fileAt(path: string, sha: string, maxBytes: number) {
    const e = await entry(path, sha);
    if (!e) return undefined;
    if (e.mode === SYMLINK_MODE) throw new ToolError(`${path} is a symlink`);
    if (e.type !== 'blob') throw new ToolError(`${path} is not a file`);
    const limit = maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MiB` : `${maxBytes / 1024} KiB`;
    if (Number(await git('cat-file', '-s', e.oid)) > maxBytes) throw new ToolError(`${path} is over ${limit}`);
    return git('cat-file', 'blob', e.oid);
  }
  let mergeBase: Promise<string> | undefined;

  const sides = (f: FileChange) => (f.oldPath ? [f.oldPath, f.path] : [f.path]);
  const diff = (revs: string[], paths: string[]) => git('--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '-M',
    '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ...revs, '--', ...paths);

  return {
    // ponytail: pathspecs ride in argv; tens of thousands of reviewed files would hit ARG_MAX.
    // quotePath off keeps non-ASCII paths unquoted, so addedLines can key on them. Literal pathspecs keep
    // names like `[id].ts` from acting as globs; callers pass both sides of a rename so -M still pairs them.
    reviewDiff: (paths) => diff([range], paths),

    async diffSince(sha, base, files) {
      for (const rev of [sha, base]) {
        try {
          await git('cat-file', '-e', `${rev}^{commit}`);
        } catch {
          // A force-push may have removed it from GitHub too; then the whole PR is reviewed again.
          try { await git('fetch', '-q', '--filter=blob:none', 'origin', rev); } catch { return undefined; }
        }
      }
      // Merging main in can put back the PR's old version of a line main changed: unchanged since that head, yet
      // never in a reviewed diff. So a file the base changed since that review is reviewed whole.
      let moved: Set<string>;
      try {
        await git('merge-base', '--is-ancestor', base, baseSha);
        const from = (await git('merge-base', base, sha)).trim();
        const to = (await git('merge-base', baseSha, headSha)).trim();
        moved = new Set((await git('--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '--name-only', '-z',
          '--no-renames', from, to, '--', ...files.flatMap(sides))).split('\0'));
      } catch { return undefined; }
      const whole = files.filter((f) => sides(f).some((p) => moved.has(p))).flatMap(sides);
      const rest = files.filter((f) => !sides(f).some((p) => moved.has(p))).flatMap(sides);
      return (whole.length ? await diff([range], whole) : '') + (rest.length ? await diff([sha, headSha], rest) : '');
    },

    async changedFiles() {
      // -z records: "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0old\0new\0". Binary files show "-".
      const fields = (await git('diff', '-M', '--numstat', '-z', '--no-ext-diff', '--no-textconv', range)).split('\0');
      const out: FileChange[] = [];
      for (let i = 0; i < fields.length - 1;) {
        // Paths may themselves contain tabs, so only the first two split.
        const [, added = '', deleted = '', path = ''] = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(fields[i++]!) ?? [];
        const change: FileChange = { path, added: Number(added) || 0, deleted: Number(deleted) || 0 };
        if (added === '-') change.binary = true;
        if (path === '') { change.oldPath = fields[i++]; change.path = fields[i++]!; }
        out.push(change);
      }
      return out;
    },

    async markedAtBase(paths) {
      // -z records: "path\0attribute\0value\0". Only set or true marks a path; false and unset do not.
      // The base tree goes into a throwaway index for check-attr --cached: --source needs git 2.40, newer than some
      // hosts ship (Render's native runtime among them).
      const tmp = mkdtempSync(join(tmpdir(), 'reviewer-attr-'));
      let out: string;
      try {
        const index = { GIT_INDEX_FILE: join(tmp, 'index') };
        await gitWithInput(undefined, ['read-tree', baseSha], index);
        out = await gitWithInput(paths.map((p) => p + '\0').join(''),
          ['check-attr', '--cached', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'], index);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      const fields = out.split('\0');
      const marked = new Set<string>();
      for (let i = 0; i + 2 < fields.length; i += 3) {
        if (fields[i + 2] === 'set' || fields[i + 2] === 'true') marked.add(fields[i]!);
      }
      return marked;
    },

    fileAtBase: (path) => fileAt(path, baseSha, MAX_BASE_FILE_BYTES),

    async fileAtSide(side, path) {
      if (side === 'head') return fileAt(path, headSha, MAX_SIDE_BYTES);
      // The PR diff is base...head, so its base side is the merge-base: main's later changes aren't the PR's.
      mergeBase ??= git('merge-base', baseSha, headSha).then((out) => out.trim());
      return fileAt(path, await mergeBase, MAX_SIDE_BYTES);
    },

    async readFile(path, start, end) {
      const e = await entry(checkPath(path));
      if (!e) throw new ToolError('no such file at head');
      if (e.mode === SYMLINK_MODE) throw new ToolError('path is a symlink');
      if (e.type !== 'blob') throw new ToolError('path is not a file');
      const [from = 1, to] = [optionalLine(start), optionalLine(end)];
      if (to !== undefined && to < from) throw new ToolError('end_line is before start_line');
      const lines = (await git('cat-file', 'blob', e.oid)).replace(/\n$/, '').split('\n');
      if (from > lines.length) throw new ToolError(`start_line is past the end of the file (${lines.length} lines)`);
      return lines.slice(from - 1, to).join('\n');
    },

    async grep(pattern, glob) {
      if (typeof pattern !== 'string' || !pattern) throw new ToolError('pattern must be a non-empty string');
      if (!omitted(glob) && (typeof glob !== 'string' || !glob)) throw new ToolError('glob must be a non-empty string');
      // Pathspec magic is parsed only at the start, so the glob text cannot add more.
      const pathspec = omitted(glob) ? [] : [`:(glob)${glob}`];
      let out: string;
      try {
        out = await git('grep', '-n', '-I', '-E', '--no-color', '-e', pattern, headSha, '--', ...pathspec);
      } catch (err: any) {
        if (err?.code === 1) return 'no matches';
        throw new ToolError('grep failed: invalid pattern, or a glob outside the repository');
      }
      // Lines come back as "<sha>:<path>:<line>:<text>".
      const lines = out.split('\n').filter(Boolean).map((l) => l.slice(headSha.length + 1));
      if (lines.length <= MAX_GREP_LINES) return lines.join('\n');
      return [...lines.slice(0, MAX_GREP_LINES), `... ${lines.length - MAX_GREP_LINES} more matches; narrow the pattern or glob`]
        .join('\n');
    },

    async listDir(path) {
      let tree = headSha;
      if (!omitted(path) && path !== '') {
        const e = await entry(checkPath(path));
        if (e?.type !== 'tree') throw new ToolError('no such directory at head');
        tree = e.oid;
      }
      return treeEntries(await git('ls-tree', '-z', tree))
        .map((e) => (e.type === 'tree' ? `${e.name}/` : e.name)).join('\n');
    },

    async diff(path) {
      const pathspec = omitted(path) ? [] : ['--', checkPath(path)];
      // quotePath off keeps non-ASCII paths unquoted, so addedLines can key on them.
      const out = await git('--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv',
        '--no-color', '--src-prefix=a/', '--dst-prefix=b/', `${baseSha}...${headSha}`, ...pathspec);
      if (!out && pathspec.length) throw new ToolError('no changes to that path between base and head');
      return out;
    },

  };
}

/** Parse `git ls-tree -z` output: "<mode> <type> <oid>\t<name>" entries. */
function treeEntries(out: string) {
  return out.split('\0').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    const [mode, type, oid] = l.slice(0, tab).split(' ') as [string, string, string];
    return { mode, type, oid, name: l.slice(tab + 1) };
  });
}

/** Lines added or modified on the head side of a unified diff, by path. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  let inHeader = false;
  let next = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { lines = undefined; inHeader = true; }
    else if (inHeader && l.startsWith('+++ ')) {
      // git appends a TAB after names containing spaces.
      if (l !== '+++ /dev/null') out.set(l.slice('+++ b/'.length).replace(/\t$/, ''), (lines = new Set()));
    } else if (l.startsWith('@@')) { inHeader = false; next = Number(/\+(\d+)/.exec(l)?.[1]); }
    else if (inHeader || !lines) continue;
    else if (l.startsWith('+')) lines.add(next++);
    else if (l.startsWith(' ')) next++;
  }
  return out;
}
