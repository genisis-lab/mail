/**
 * Long-running per-user jobs (IMAP import, mailbox export). Each run does a
 * bounded slice of work and saves its state, so a job survives restarts and
 * never exceeds a single Durable Object invocation's limits.
 */
import { all, get, insert, now, run } from '../db/index.js';
import { logger } from '../lib/log.js';
import { platform } from '../platform.js';

const log = logger('jobs');

export type JobKind = 'imap_import' | 'export';

export interface JobRow {
  id: number;
  user_id: number;
  kind: JobKind;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  config: string | null;
  state: string;
  progress: string;
  error: string | null;
  next_run_at: number;
  created_at: number;
  updated_at: number;
}

/** A step returns the new state/progress, and whether the job is finished. */
export type JobStep = (job: JobRow, state: any) => Promise<{ state: any; progress: Record<string, unknown>; done: boolean; delayMs?: number }>;

const handlers = new Map<JobKind, JobStep>();

export function registerJob(kind: JobKind, step: JobStep) {
  handlers.set(kind, step);
}

export function createJob(userId: number, kind: JobKind, config: string | null, state: unknown = {}): number {
  const ts = now();
  const id = insert('INSERT INTO jobs (user_id, kind, config, state, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    userId,
    kind,
    config,
    JSON.stringify(state),
    ts,
    ts,
    ts,
  ]);
  platform().wake?.(ts);
  return id;
}

export function jobsDueAt(): number {
  return get<{ t: number | null }>(`SELECT MIN(next_run_at) AS t FROM jobs WHERE status IN ('queued','running')`)?.t ?? Infinity;
}

const MAX_RETRIES = 3;
let busy = false;

/** Run one slice of every due job. */
export async function runJobs() {
  if (busy) return;
  busy = true;
  try {
    const due = all<JobRow>(`SELECT * FROM jobs WHERE status IN ('queued','running') AND next_run_at <= ? ORDER BY next_run_at LIMIT 3`, [now()]);
    for (const job of due) {
      const step = handlers.get(job.kind);
      if (!step) continue;
      run(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?`, [now(), job.id]);
      try {
        const r = await step(job, JSON.parse(job.state || '{}'));
        // The job may have been cancelled while the step ran.
        const current = get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [job.id]);
        if (!current || current.status === 'cancelled') continue;
        if (r.state && typeof r.state === 'object') delete r.state._retries;
        run('UPDATE jobs SET status = ?, state = ?, progress = ?, error = NULL, next_run_at = ?, updated_at = ? WHERE id = ?', [
          r.done ? 'done' : 'running',
          JSON.stringify(r.state),
          JSON.stringify(r.progress),
          now() + (r.delayMs ?? 250),
          now(),
          job.id,
        ]);
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        const current = get<JobRow>('SELECT * FROM jobs WHERE id = ?', [job.id]);
        if (!current || current.status === 'cancelled') continue;
        // Network hiccups get a few retries; anything marked permanent (bad password, full mailbox) fails now.
        const state = JSON.parse(current.state || '{}');
        const retries = (state._retries ?? 0) + 1;
        if (!(err as { permanent?: boolean }).permanent && retries <= MAX_RETRIES) {
          log.warn(`Job ${job.id} (${job.kind}) failed, retrying (${retries}/${MAX_RETRIES})`, err);
          state._retries = retries;
          run('UPDATE jobs SET state = ?, error = ?, next_run_at = ?, updated_at = ? WHERE id = ?', [JSON.stringify(state), message, now() + retries * 60_000, now(), job.id]);
        } else {
          log.warn(`Job ${job.id} (${job.kind}) failed`, err);
          // Forget stored credentials once a job can no longer use them.
          run(`UPDATE jobs SET status = 'failed', error = ?, config = NULL, updated_at = ? WHERE id = ?`, [message, now(), job.id]);
        }
      }
    }
  } finally {
    busy = false;
  }
}

export function jobDto(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    progress: JSON.parse(j.progress || '{}'),
    error: j.error,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}
