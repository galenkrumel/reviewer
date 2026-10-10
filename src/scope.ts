// Which changed files the reviewers see: exclusions, the review token budget, and the oversized-PR note.
import { posix } from 'node:path';
import type { FileChange } from './git.ts';

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'deno.lock',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'composer.lock', 'go.sum',
  'mix.lock', 'pubspec.lock', 'Podfile.lock', 'packages.lock.json', 'flake.lock', 'gradle.lockfile',
]);
const VENDORED = /(^|\/)(vendor|vendors|third_party|third-party|node_modules|bower_components)\//;
const GENERATED = /\.min\.(js|css|mjs)$|\.(js|css)\.map$|\.pb\.go$|_pb2(_grpc)?\.pyi?$|\.g\.dart$|[._]generated\.[^/]+$|(^|\/)__generated__\//;
// Binary formats nobody reviews as text. Other binary-looking changes are surfaced, since a stray NUL byte
// would otherwise hide a source file from review.
const BINARY_ASSET = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|pdf|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|zip|gz|tgz|jar|wasm)$/i;
// ponytail: path-name heuristic for "security-sensitive"; a content signal can replace it if ranking misfires.
const SENSITIVE = /auth|login|passw|secret|token|session|crypt|permission|oauth|jwt|acl|credential|security|\.env/i;
// ponytail: tokens estimated from changed lines; measure the per-file diff if the estimate proves too coarse.
const TOKENS_PER_LINE = 10;

export interface Scope {
  /** Files that fit the budget, most important first. Pure renames and other zero-line changes are left out. */
  reviewed: FileChange[];
  /** Reviewable files that did not fit the budget. */
  skipped: string[];
  /** Non-excluded files git sees as binary, which reviewers cannot read. */
  binary: string[];
  /** Changed lines across every non-excluded file. */
  reviewableLines: number;
  /** Directories holding those lines. */
  directories: string[];
}

function isExcluded(path: string, excludedAtBase: Set<string>): boolean {
  return LOCKFILES.has(posix.basename(path)) || VENDORED.test(path) || GENERATED.test(path) || excludedAtBase.has(path);
}

/** excludedAtBase: paths the base SHA excludes on top of the built-ins (.gitattributes marks, repo config globs). */
export function selectFiles(files: FileChange[], excludedAtBase: Set<string>, tokenBudget: number): Scope {
  const churn = (f: FileChange) => f.added + f.deleted;
  const kept = files.filter((f) => !isExcluded(f.path, excludedAtBase));
  const reviewable = kept.filter((f) => churn(f) > 0);
  const ranked = reviewable.toSorted((a, b) =>
    Number(SENSITIVE.test(b.path)) - Number(SENSITIVE.test(a.path)) || churn(b) - churn(a));

  const reviewed: FileChange[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const f of ranked) {
    const cost = churn(f) * TOKENS_PER_LINE;
    if (used + cost <= tokenBudget) { reviewed.push(f); used += cost; } else skipped.push(f.path);
  }
  return {
    reviewed,
    skipped,
    binary: kept.filter((f) => f.binary && !BINARY_ASSET.test(f.path)).map((f) => f.path),
    reviewableLines: reviewable.reduce((n, f) => n + churn(f), 0),
    directories: [...new Set(reviewable.map((f) => posix.dirname(f.path)))].sort(),
  };
}
