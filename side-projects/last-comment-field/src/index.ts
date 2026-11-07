import Resolver from '@forge/resolver';
import { BatchEvent, cancelBackfill, getBackfillState, handleBatch, startBackfill } from './backfill';
import { computeValue, writeValues } from './jira';
import { loadSettings, saveSettings } from './settings';

/** Trigger: a comment was added or deleted → recompute the field for that issue. */
export async function onComment(event: any): Promise<void> {
  const issueId: string | undefined = event?.issue?.id;
  if (!issueId) {
    console.warn('Event without issue id', JSON.stringify(event).slice(0, 500));
    return;
  }
  const value = await computeValue(issueId, await loadSettings());
  await writeValues(new Map([[issueId, value]]));
  console.log(`Issue ${issueId}: last comment field updated`);
}

/** Trigger: app installed → fill the field for existing issues. */
export async function onInstalled(): Promise<void> {
  const state = await startBackfill();
  console.log(`Backfill ${state.runId} started on install: ${state.projectsTotal} projects`);
}

/** Queue consumer for backfill batches. */
const consumer = new Resolver();
consumer.define('backfill-batch', ({ payload }) => handleBatch(payload as BatchEvent));
export const backfillConsumer = consumer.getDefinitions();

/** Backend for the admin settings page (UI Kit). */
const admin = new Resolver();
admin.define('getSettings', () => loadSettings());
admin.define('saveSettings', ({ payload }) => saveSettings(payload));
admin.define('getBackfill', () => getBackfillState());
admin.define('startBackfill', () => startBackfill());
admin.define('cancelBackfill', () => cancelBackfill());
export const adminResolver = admin.getDefinitions();
