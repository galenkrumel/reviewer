// SQLite (WAL) holds both the job queue and the run records: a run row is the job.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from './ports.ts';

export type RunStatus =
  | 'queued' | 'running' | 'published' | 'nothing_to_publish' | 'failed'
  /** A newer job for the PR, or converted_to_draft/closed, replaced this one. */
  | 'superseded'
  /** The pre-publish check found the PR closed, a draft, or at other SHAs. */
  | 'stale'
  /** Over the per-PR run cap: recorded, never claimed. */
  | 'skipped';
export type FindingOutcome = 'published' | 'unanchorable';

export interface Finding {
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  path: string;
  line: number;
  start_line?: number;
  evidence: string;
  suggested_fix?: string;
}

export interface RecordedFinding extends Finding {
  focus: string;
  outcome: FindingOutcome;
}

export interface Job {
  id: number;
  deliveryId: string;
  event: string;
  repo: string;
  pr: number;
  installationId: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
}

export interface RunRecord extends Omit<Job, 'installationId' | 'title' | 'body'> {
  status: RunStatus;
  reviewId: number | null;
  error: string | null;
  findings: RecordedFinding[];
}

export function openStore(dataDir: string, clock: Clock) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'reviewer.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      event TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr INTEGER NOT NULL,
      installation_id INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      review_id INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS findings (
      run_id INTEGER NOT NULL REFERENCES runs(id),
      focus TEXT NOT NULL,
      outcome TEXT NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const now = () => clock.now().toISOString();
  // Restart safety: whatever was running died with the last process. The marker check prevents double-posting.
  db.prepare(`UPDATE runs SET status = 'queued', updated_at = ? WHERE status = 'running'`).run(now());
  const toJob = (r: any): Job => ({
    id: r.id, deliveryId: r.delivery_id, event: r.event, repo: r.repo, pr: r.pr,
    installationId: r.installation_id, headSha: r.head_sha, baseSha: r.base_sha, title: r.title, body: r.body,
  });

  return {
    // ponytail: no transaction; DatabaseSync calls can't interleave in one process. Wrap in BEGIN IMMEDIATE if a second process ever writes.
    /**
     * No-op for a duplicate (repo, PR, head, base); otherwise supersedes the PR's in-flight jobs at other SHAs.
     * A label re-review is never a duplicate. A `skipped` job is only recorded.
     */
    enqueue(job: Omit<Job, 'id'>, status: 'queued' | 'skipped' = 'queued') {
      if (status === 'queued') {
        const dup = job.event !== 'pull_request.labeled' && db.prepare(`SELECT 1 FROM runs
          WHERE repo = ? AND pr = ? AND head_sha = ? AND base_sha = ?
          AND status IN ('queued', 'running', 'published', 'nothing_to_publish')`)
          .get(job.repo, job.pr, job.headSha, job.baseSha);
        if (dup) return;
        db.prepare(`UPDATE runs SET status = 'superseded', updated_at = ? WHERE repo = ? AND pr = ?
          AND status IN ('queued', 'running') AND (head_sha != ? OR base_sha != ?)`)
          .run(now(), job.repo, job.pr, job.headSha, job.baseSha);
      }
      db.prepare(`INSERT INTO runs (delivery_id, event, repo, pr, installation_id, head_sha, base_sha, title, body,
        status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(job.deliveryId, job.event, job.repo, job.pr, job.installationId, job.headSha, job.baseSha,
          job.title, job.body, status, now(), now());
    },

    /** Runs for a PR created after `since`, not counting skipped ones. */
    countRuns(repo: string, pr: number, since: Date): number {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM runs
        WHERE repo = ? AND pr = ? AND status != 'skipped' AND created_at > ?`).get(repo, pr, since.toISOString()) as any;
      return row.n;
    },

    /** Mark every queued or running job for the PR superseded. */
    supersede(repo: string, pr: number) {
      db.prepare(`UPDATE runs SET status = 'superseded', updated_at = ? WHERE repo = ? AND pr = ?
        AND status IN ('queued', 'running')`).run(now(), repo, pr);
    },

    superseded(id: number): boolean {
      return (db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as any)?.status === 'superseded';
    },

    claimNext(): Job | undefined {
      const row = db.prepare(`UPDATE runs SET status = 'running', updated_at = ?
        WHERE id = (SELECT id FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1) RETURNING *`).get(now());
      return row && toJob(row);
    },

    finish(id: number, status: RunStatus, opts: { reviewId?: number; error?: string; findings?: RecordedFinding[] } = {}) {
      const insert = db.prepare('INSERT INTO findings (run_id, focus, outcome, data) VALUES (?, ?, ?, ?)');
      for (const f of opts.findings ?? []) insert.run(id, f.focus, f.outcome, JSON.stringify(f));
      // Only a running job finishes; a superseded one keeps that status whatever the worker ends with.
      db.prepare(`UPDATE runs SET status = ?, review_id = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .run(status, opts.reviewId ?? null, opts.error ?? null, now(), id);
    },

    /** The run-record query interface. */
    runs(): RunRecord[] {
      const findings = db.prepare('SELECT data FROM findings WHERE run_id = ? ORDER BY rowid');
      return db.prepare('SELECT * FROM runs ORDER BY id').all().map((r: any) => {
        const { installationId, title, body, ...job } = toJob(r);
        return {
          ...job,
          status: r.status,
          reviewId: r.review_id,
          error: r.error,
          findings: findings.all(r.id).map((f: any) => JSON.parse(f.data)),
        };
      });
    },

    close: () => db.close(),
  };
}
