// SQLite (WAL) holds both the job queue and the run records: a run row is the job.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from './ports.ts';

export type RunStatus = 'queued' | 'running' | 'published' | 'nothing_to_publish' | 'failed';
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

export interface RecordedFocus {
  focus: string;
  reason: string;
  status: 'succeeded' | 'failed';
  error?: string;
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
  focuses: RecordedFocus[];
  /** Whether the orchestrator failed and the fixed fallback selection was used. */
  fallbackUsed: boolean;
  orchestratorError: string | null;
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
    CREATE TABLE IF NOT EXISTS focuses (
      run_id INTEGER NOT NULL REFERENCES runs(id),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orchestrations (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id),
      fallback_used INTEGER NOT NULL,
      error TEXT
    );
  `);
  const now = () => clock.now().toISOString();
  const toJob = (r: any): Job => ({
    id: r.id, deliveryId: r.delivery_id, event: r.event, repo: r.repo, pr: r.pr,
    installationId: r.installation_id, headSha: r.head_sha, baseSha: r.base_sha, title: r.title, body: r.body,
  });

  return {
    enqueue(job: Omit<Job, 'id'>) {
      db.prepare(`INSERT INTO runs (delivery_id, event, repo, pr, installation_id, head_sha, base_sha, title, body,
        status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(job.deliveryId, job.event, job.repo, job.pr, job.installationId, job.headSha, job.baseSha,
          job.title, job.body, now(), now());
    },

    claimNext(): Job | undefined {
      const row = db.prepare(`UPDATE runs SET status = 'running', updated_at = ?
        WHERE id = (SELECT id FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1) RETURNING *`).get(now());
      return row && toJob(row);
    },

    finish(id: number, status: RunStatus, opts: {
      reviewId?: number; error?: string; findings?: RecordedFinding[]; focuses?: RecordedFocus[];
      fallbackUsed?: boolean; orchestratorError?: string;
    } = {}) {
      const insert = db.prepare('INSERT INTO findings (run_id, focus, outcome, data) VALUES (?, ?, ?, ?)');
      for (const f of opts.findings ?? []) insert.run(id, f.focus, f.outcome, JSON.stringify(f));
      const insertFocus = db.prepare('INSERT INTO focuses (run_id, data) VALUES (?, ?)');
      for (const f of opts.focuses ?? []) insertFocus.run(id, JSON.stringify(f));
      if (opts.fallbackUsed !== undefined) {
        db.prepare('INSERT INTO orchestrations (run_id, fallback_used, error) VALUES (?, ?, ?)')
          .run(id, opts.fallbackUsed ? 1 : 0, opts.orchestratorError ?? null);
      }
      db.prepare('UPDATE runs SET status = ?, review_id = ?, error = ?, updated_at = ? WHERE id = ?')
        .run(status, opts.reviewId ?? null, opts.error ?? null, now(), id);
    },

    /** The run-record query interface. */
    runs(): RunRecord[] {
      const findings = db.prepare('SELECT data FROM findings WHERE run_id = ? ORDER BY rowid');
      const focuses = db.prepare('SELECT data FROM focuses WHERE run_id = ? ORDER BY rowid');
      const orchestration = db.prepare('SELECT fallback_used, error FROM orchestrations WHERE run_id = ?');
      return db.prepare('SELECT * FROM runs ORDER BY id').all().map((r: any) => {
        const { installationId, title, body, ...job } = toJob(r);
        const o: any = orchestration.get(r.id);
        return {
          ...job,
          status: r.status,
          reviewId: r.review_id,
          error: r.error,
          findings: findings.all(r.id).map((f: any) => JSON.parse(f.data)),
          focuses: focuses.all(r.id).map((f: any) => JSON.parse(f.data)),
          fallbackUsed: o?.fallback_used === 1,
          orchestratorError: o?.error ?? null,
        };
      });
    },

    close: () => db.close(),
  };
}
