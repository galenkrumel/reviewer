// Source access through git objects only: a bare, blobless clone per repository,
// never a working tree. Nothing from the repository is ever executed.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
  };
}

/** A tool-input problem the reviewer may see; any other failure is reported generically. */
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
}

// ponytail: fixed cap on grep output lines; make it a budget when per-agent budgets land.
const MAX_GREP_LINES = 200;

/** A repository-relative path: not absolute, no empty, "." or ".." segments. */
function checkPath(path: unknown): string {
  if (typeof path !== 'string' || !path.split('/').every((s) => s && s !== '.' && s !== '..')) {
    throw new ToolError('path must be repository-relative, without "." or ".." segments');
  }
  return path;
}

function optionalLine(n: unknown): number | undefined {
  if (n !== undefined && !(Number.isInteger(n) && (n as number) >= 1)) throw new ToolError('line numbers must be integers >= 1');
  return n as number | undefined;
}

/** Fetch exactly the head and base SHAs into the repository's bare clone and read at the pinned head. */
export async function openSource(opts: {
  dataDir: string; repo: string; url: string; token: string; headSha: string; baseSha: string;
}): Promise<Source> {
  const { headSha, baseSha } = opts;
  const dir = join(opts.dataDir, 'repos', opts.repo.replace('/', '__') + '.git');
  const env = gitEnv(opts.token);
  // Blobs are fetched lazily from the promisor remote, so reads need the same env.
  const git = async (...args: string[]) =>
    (await run('git', ['-C', dir, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    await git('init', '-q', '--bare');
    await git('config', 'remote.origin.promisor', 'true');
    await git('config', 'remote.origin.partialclonefilter', 'blob:none');
  }
  await git('config', 'remote.origin.url', opts.url);
  // ponytail: no retry/backoff yet; a failed fetch fails the run.
  await git('fetch', '-q', '--filter=blob:none', 'origin', headSha, baseSha);

  /** The head tree's entry at path, if any. Symlinks are never followed: a tree stores only the link target. */
  async function entry(path: string) {
    const out = await git('--literal-pathspecs', 'ls-tree', '-z', headSha, '--', path);
    const [meta, name] = out.split('\0')[0]!.split('\t');
    if (name !== path) return undefined;
    const [mode, type, oid] = meta!.split(' ');
    return { mode: mode!, type: type!, oid: oid! };
  }

  return {
    async readFile(path, start, end) {
      const e = await entry(checkPath(path));
      if (!e) throw new ToolError('no such file at head');
      if (e.mode === '120000') throw new ToolError('path is a symlink');
      if (e.type !== 'blob') throw new ToolError('path is not a file');
      const [from, to] = [optionalLine(start), optionalLine(end)];
      const text = await git('cat-file', 'blob', e.oid);
      if (from === undefined && to === undefined) return text;
      return text.split('\n').slice((from ?? 1) - 1, to).join('\n');
    },

    async grep(pattern, glob) {
      if (typeof pattern !== 'string' || !pattern) throw new ToolError('pattern must be a non-empty string');
      if (glob !== undefined && (typeof glob !== 'string' || !glob)) throw new ToolError('glob must be a non-empty string');
      // Pathspec magic is parsed only at the start, so the glob text cannot add more.
      const pathspec = glob === undefined ? [] : [`:(glob)${glob}`];
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
      if (path !== undefined && path !== '') {
        const e = await entry(checkPath(path));
        if (e?.type !== 'tree') throw new ToolError('no such directory at head');
        tree = e.oid;
      }
      return (await git('ls-tree', '-z', tree)).split('\0').filter(Boolean).map((l) => {
        const [meta, name] = l.split('\t');
        return meta!.split(' ')[1] === 'tree' ? `${name}/` : name;
      }).join('\n');
    },

    // quotePath off keeps non-ASCII paths unquoted, so addedLines can key on them.
    diff: async (path) => git('--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv',
      '--no-color', '--src-prefix=a/', '--dst-prefix=b/', `${baseSha}...${headSha}`,
      ...(path === undefined ? [] : ['--', checkPath(path)])),
  };
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
