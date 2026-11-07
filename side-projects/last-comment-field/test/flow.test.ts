// End-to-end flow against an in-memory fake of Jira, KVS and the Forge queue.
// Run with --experimental-test-module-mocks (see package.json "test").
import { before, test, mock } from 'node:test';
import assert from 'node:assert/strict';

type Comment = { id: string; jsdPublic?: boolean; visibility?: object; body: object };
const para = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

// ---- fake Jira -------------------------------------------------------------
const projects: Record<string, string[]> = {
  '10': ['1', '2', '3'],
  '20': ['4'],
  // 120 issues → 3 search pages of 50
  '30': Array.from({ length: 120 }, (_, i) => String(1000 + i)),
};
const comments: Record<string, Comment[]> = {
  '1': [{ id: 'a', body: para('hello') }],
  '2': [], // no comments
  // newest-first: 150 internal notes hide one public comment on page 2
  '3': [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, jsdPublic: false, body: para('secret') })),
    { id: 'p', body: para('public answer') },
  ],
  '4': [{ id: 'b', visibility: { type: 'role', value: 'Dev' }, body: para('restricted') }],
};
const fieldValues = new Map<number, string | null>();
let rateLimitOnce = false;
const calls: string[] = [];

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function requestJira(path: string, init?: { method?: string; body?: string }) {
  const url = new URL(path, 'https://jira.local');
  calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/rest/api/3/field') {
    return respond(200, [{ id: 'customfield_10500', schema: { custom: 'ari:x/static/last-comment-field' } }]);
  }
  if (url.pathname === '/rest/api/3/project/search') {
    return respond(200, { values: Object.keys(projects).map((id) => ({ id })), isLast: true });
  }
  if (url.pathname === '/rest/api/3/search/jql') {
    if (rateLimitOnce) {
      rateLimitOnce = false;
      return respond(429, {}, { 'Retry-After': '7' });
    }
    const req = JSON.parse(init!.body!);
    const pid = /project = (\d+)/.exec(req.jql)![1];
    const start = Number(req.nextPageToken ?? 0);
    const ids = projects[pid].slice(start, start + req.maxResults);
    const end = start + ids.length;
    return respond(200, {
      issues: ids.map((id) => ({ id })),
      ...(end < projects[pid].length ? { nextPageToken: String(end), isLast: false } : { isLast: true }),
    });
  }
  const m = /^\/rest\/api\/3\/issue\/(\d+)\/comment$/.exec(url.pathname);
  if (m) {
    const all = comments[m[1]] ?? [];
    const startAt = Number(url.searchParams.get('startAt'));
    const max = Number(url.searchParams.get('maxResults'));
    return respond(200, { comments: all.slice(startAt, startAt + max), total: all.length, startAt });
  }
  if (url.pathname.startsWith('/rest/api/3/app/field/') && init?.method === 'PUT') {
    for (const u of JSON.parse(init.body!).updates) for (const id of u.issueIds) fieldValues.set(id, u.value);
    return respond(204, {});
  }
  throw new Error(`unexpected ${path}`);
}

// ---- fake KVS and queue ----------------------------------------------------
const store = new Map<string, unknown>();
const pushed: Array<{ body: any }> = [];

class FakeInvocationError {
  constructor(public retryOptions: unknown) {}
}

mock.module('@forge/api', {
  defaultExport: { asApp: () => ({ requestJira }) },
  namedExports: { route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((a, p, i) => a + p + (i < v.length ? String(v[i]) : ''), '') },
});
mock.module('@forge/kvs', {
  namedExports: {
    kvs: {
      get: async (k: string) => structuredClone(store.get(k)),
      set: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
    },
  },
});
mock.module('@forge/events', {
  namedExports: {
    Queue: class {
      push = async (e: { body: unknown }) => {
        pushed.push(e as { body: any });
        return { jobId: 'job' };
      };
    },
    InvocationError: FakeInvocationError,
    InvocationErrorCode: { FUNCTION_UPSTREAM_RATE_LIMITED: 'FUNCTION_UPSTREAM_RATE_LIMITED' },
  },
});

// Imported after the mocks are registered (no top-level await under CommonJS).
let startBackfill: typeof import('../src/backfill').startBackfill;
let handleBatch: typeof import('../src/backfill').handleBatch;
let getBackfillState: typeof import('../src/backfill').getBackfillState;
let cancelBackfill: typeof import('../src/backfill').cancelBackfill;
let onComment: typeof import('../src/index').onComment;
before(async () => {
  ({ startBackfill, handleBatch, getBackfillState, cancelBackfill } = await import('../src/backfill'));
  ({ onComment } = await import('../src/index'));
});

async function drainQueue(limit = 20) {
  for (let i = 0; i < limit && pushed.length; i++) {
    const result = await handleBatch(pushed.shift()!.body);
    if (result instanceof FakeInvocationError) return result;
  }
}

test('backfill walks all projects page by page and writes values', async () => {
  const s = await startBackfill();
  assert.equal(s.status, 'running');
  assert.equal(s.projectsTotal, 3);
  await drainQueue();

  assert.equal(fieldValues.get(1), 'hello');
  assert.equal(fieldValues.get(2), null);
  assert.equal(fieldValues.get(3), 'public answer', 'public comment behind 150 internal notes is found');
  assert.equal(fieldValues.get(4), null, 'restricted comment is not leaked');

  const done = await getBackfillState();
  assert.equal(done?.status, 'done');
  assert.equal(done?.projectsDone, 3);
  assert.equal(done?.issuesProcessed, 124);
  assert.equal(fieldValues.has(1119), true, 'last issue of the paged project is written');
  assert.equal(calls.filter((c) => c === 'PUT /rest/api/3/app/field/customfield_10500/value').length, 5, 'one PUT per batch');
});

test('a second start while running returns the same run', async () => {
  store.clear();
  pushed.length = 0;
  const a = await startBackfill();
  const b = await startBackfill();
  assert.equal(a.runId, b.runId);
  assert.equal(pushed.length, 1);
});

test('cancel stops the chain', async () => {
  await cancelBackfill();
  await drainQueue();
  assert.equal(pushed.length, 0);
  assert.equal((await getBackfillState())?.status, 'cancelled');
});

test('429 from Jira asks the queue to retry the same batch', async () => {
  store.clear();
  pushed.length = 0;
  await startBackfill();
  const event = pushed[0].body;
  rateLimitOnce = true;
  const res = await drainQueue();
  assert.ok(res instanceof FakeInvocationError);
  assert.deepEqual((res as FakeInvocationError).retryOptions, {
    retryAfter: 7,
    retryReason: 'FUNCTION_UPSTREAM_RATE_LIMITED',
  });
  assert.equal((await getBackfillState())?.status, 'running');
  // redelivery of the same event succeeds
  pushed.unshift({ body: event });
  await drainQueue();
  assert.equal((await getBackfillState())?.status, 'done');
});

test('comment trigger applies stored settings', async () => {
  store.set('settings', { maxLength: 255, showAuthor: false, showDate: false, includeRestricted: true });
  await onComment({ issue: { id: '4' } });
  assert.equal(fieldValues.get(4), 'restricted');
  store.delete('settings');
  await onComment({ issue: { id: '4' } });
  assert.equal(fieldValues.get(4), null);
});
