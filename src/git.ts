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

export interface Source {
  readFile(path: string): Promise<string>;
  /** The PR diff, base...head. */
  diff(): Promise<string>;
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

  return {
    readFile: (path) => git('cat-file', 'blob', `${headSha}:${path}`),
    diff: () => git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
      `${baseSha}...${headSha}`),
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
      if (l !== '+++ /dev/null') out.set(l.slice('+++ b/'.length), (lines = new Set()));
    } else if (l.startsWith('@@')) { inHeader = false; next = Number(/\+(\d+)/.exec(l)?.[1]); }
    else if (inHeader || !lines) continue;
    else if (l.startsWith('+')) lines.add(next++);
    else if (l.startsWith(' ')) next++;
  }
  return out;
}
