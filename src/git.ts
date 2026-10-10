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

/** One changed file. Rename detection is on, so a pure rename or move has no added or deleted lines. */
export interface FileChange {
  path: string;
  /** Set when the file was renamed or moved. */
  oldPath?: string;
  added: number;
  deleted: number;
}

export interface Source {
  readFile(path: string): Promise<string>;
  /** The PR diff, base...head, optionally limited to the given paths. */
  diff(paths?: string[]): Promise<string>;
  changedFiles(): Promise<FileChange[]>;
  /** The paths marked linguist-generated or linguist-vendored by .gitattributes at the base SHA. */
  markedAtBase(paths: string[]): Promise<Set<string>>;
}

/** Fetch exactly the head and base SHAs into the repository's bare clone and read at the pinned head. */
export async function openSource(opts: {
  dataDir: string; repo: string; url: string; token: string; headSha: string; baseSha: string;
}): Promise<Source> {
  const { headSha, baseSha } = opts;
  const dir = join(opts.dataDir, 'repos', opts.repo.replace('/', '__') + '.git');
  const env = gitEnv(opts.token);
  // Blobs are fetched lazily from the promisor remote, so reads need the same env.
  const gitWithInput = async (input: string | undefined, args: string[]) => {
    const p = run('git', ['-C', dir, ...args], { env, maxBuffer: 64 * 1024 * 1024 });
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
  // ponytail: no retry/backoff yet; a failed fetch fails the run.
  await git('fetch', '-q', '--filter=blob:none', 'origin', headSha, baseSha);

  return {
    readFile: (path) => git('cat-file', 'blob', `${headSha}:${path}`),
    // quotePath off keeps non-ASCII paths unquoted, so addedLines can key on them. Literal pathspecs keep
    // names like `[id].ts` from acting as globs; callers pass both sides of a rename so -M still pairs them.
    diff: (paths) => git('--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '-M', '--no-ext-diff', '--no-textconv',
      '--no-color', '--src-prefix=a/', '--dst-prefix=b/', range, ...(paths ? ['--', ...paths] : [])),

    async changedFiles() {
      // -z records: "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0old\0new\0". Binary files show "-".
      const fields = (await git('diff', '-M', '--numstat', '-z', '--no-ext-diff', '--no-textconv', range)).split('\0');
      const out: FileChange[] = [];
      for (let i = 0; i < fields.length - 1;) {
        const [added = '', deleted = '', path = ''] = fields[i++]!.split('\t');
        const change: FileChange = { path, added: Number(added) || 0, deleted: Number(deleted) || 0 };
        if (path === '') { change.oldPath = fields[i++]; change.path = fields[i++]!; }
        out.push(change);
      }
      return out;
    },

    async markedAtBase(paths) {
      // -z records: "path\0attribute\0value\0". Only set or true marks a path; false and unset do not.
      // ponytail: --source needs git >= 2.40; older hosts fail the run here.
      const out = await gitWithInput(paths.map((p) => p + '\0').join(''),
        ['check-attr', `--source=${baseSha}`, '-z', '--stdin', 'linguist-generated', 'linguist-vendored']);
      const fields = out.split('\0');
      const marked = new Set<string>();
      for (let i = 0; i + 2 < fields.length; i += 3) {
        if (fields[i + 2] === 'set' || fields[i + 2] === 'true') marked.add(fields[i]!);
      }
      return marked;
    },
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
