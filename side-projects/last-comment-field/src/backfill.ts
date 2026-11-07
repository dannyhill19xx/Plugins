import { Queue, InvocationError, InvocationErrorCode } from '@forge/events';
import { kvs } from '@forge/kvs';
import { Settings } from './core';
import { RateLimitedError, computeValues, getProject, listProjectIds, searchIssueIds, writeIssueValues } from './jira';
import { loadSettings } from './settings';

/**
 * Backfill: recompute the field for every existing issue.
 *
 * One queue event = one page of issues in one project. Each event pushes the
 * next one, so there is at most one batch in flight per site and Jira rate
 * limits are respected. Progress lives in KVS so the admin page can show it.
 */

export const QUEUE_KEY = 'backfill-queue';
const STATE_KEY = 'backfill-state';
const ISSUES_PER_BATCH = 50;
const PARALLEL_COMMENT_FETCHES = 5;
/** A run that has not advanced for this long is considered dead and may be restarted. */
const STALE_AFTER_MS = 30 * 60 * 1000;

const queue = new Queue({ key: QUEUE_KEY });

export type BackfillState = {
  runId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  projectsTotal: number;
  projectsDone: number;
  issuesProcessed: number;
  error?: string;
};

export type BatchEvent = {
  runId: string;
  projectIds: string[];
  projectIndex: number;
  nextPageToken?: string;
};

export async function getBackfillState(): Promise<BackfillState | null> {
  return (await kvs.get<BackfillState>(STATE_KEY)) ?? null;
}

function isAlive(s: BackfillState | null): boolean {
  return !!s && s.status === 'running' && Date.now() - Date.parse(s.updatedAt) < STALE_AFTER_MS;
}

export async function startBackfill(): Promise<BackfillState> {
  const current = await getBackfillState();
  if (current && isAlive(current)) return current;

  const projectIds = await listProjectIds();
  const now = new Date().toISOString();
  const state: BackfillState = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: projectIds.length ? 'running' : 'done',
    startedAt: now,
    updatedAt: now,
    projectsTotal: projectIds.length,
    projectsDone: 0,
    issuesProcessed: 0,
  };
  await kvs.set(STATE_KEY, state);
  if (projectIds.length) {
    await queue.push({ body: { runId: state.runId, projectIds, projectIndex: 0 } satisfies BatchEvent });
  }
  return state;
}

export async function cancelBackfill(): Promise<BackfillState | null> {
  const state = await getBackfillState();
  if (state?.status !== 'running') return state;
  const next = { ...state, status: 'cancelled' as const, updatedAt: new Date().toISOString() };
  await kvs.set(STATE_KEY, next);
  return next;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function processPage(event: BatchEvent, settings: Settings) {
  const project = await getProject(event.projectIds[event.projectIndex]);
  const page = await searchIssueIds(project.id, event.nextPageToken, ISSUES_PER_BATCH);
  const values = await mapLimit(page.issueIds, PARALLEL_COMMENT_FETCHES, (id) => computeValues(id, settings, project));
  await writeIssueValues(page.issueIds.map((id, i) => [id, values[i]]));
  return { processed: page.issueIds.length, nextPageToken: page.nextPageToken };
}

/** Queue consumer: one batch per invocation. */
export async function handleBatch(event: BatchEvent): Promise<InvocationError | void> {
  const state = await getBackfillState();
  if (!state || state.runId !== event.runId || state.status !== 'running') {
    console.log(`Backfill ${event.runId}: stopped (state ${state?.status ?? 'missing'})`);
    return;
  }

  let result: Awaited<ReturnType<typeof processPage>>;
  try {
    result = await processPage(event, await loadSettings());
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // Same event is redelivered later; the batch is idempotent.
      return new InvocationError({
        retryAfter: e.retryAfterSec,
        retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Backfill ${event.runId} failed: ${message}`);
    await kvs.set(STATE_KEY, { ...state, status: 'failed', error: message, updatedAt: new Date().toISOString() });
    return;
  }

  const projectDone = !result.nextPageToken;
  const next: BatchEvent | null = !projectDone
    ? { ...event, nextPageToken: result.nextPageToken }
    : event.projectIndex + 1 < event.projectIds.length
      ? { runId: event.runId, projectIds: event.projectIds, projectIndex: event.projectIndex + 1 }
      : null;

  // Re-read so a cancel issued during this batch is not overwritten.
  const latest = (await getBackfillState()) ?? state;
  const cancelled = latest.runId !== event.runId || latest.status !== 'running';
  const updated: BackfillState = {
    ...state,
    status: cancelled ? latest.status : next ? 'running' : 'done',
    projectsDone: state.projectsDone + (projectDone ? 1 : 0),
    issuesProcessed: state.issuesProcessed + result.processed,
    updatedAt: new Date().toISOString(),
  };
  if (latest.runId === event.runId) await kvs.set(STATE_KEY, updated);
  if (next && !cancelled) await queue.push({ body: next });
}
