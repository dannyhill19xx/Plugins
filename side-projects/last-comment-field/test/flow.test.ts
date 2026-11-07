// End-to-end flow against an in-memory fake of Jira, KVS and the Forge queue.
// Run with --experimental-test-module-mocks (see package.json "test").
import { before, test, mock } from 'node:test';
import assert from 'node:assert/strict';

type Author = { accountId: string; accountType: 'atlassian' | 'app' | 'customer' };
type Comment = { id: string; jsdPublic?: boolean; visibility?: object; body: object; created?: string; author?: Author };
const para = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const at = (day: number) => `2026-11-0${day}T10:00:00.000+0700`;

// ---- fake Jira -------------------------------------------------------------
const projects: Record<string, { key: string; type: string; issues: string[] }> = {
  '10': { key: 'SW', type: 'software', issues: ['1', '2', '3'] },
  '20': { key: 'BIZ', type: 'business', issues: ['4'] },
  // 120 issues → 3 search pages of 50
  '30': { key: 'BIG', type: 'software', issues: Array.from({ length: 120 }, (_, i) => String(1000 + i)) },
  '40': { key: 'HELP', type: 'service_desk', issues: ['50', '51', '52'] },
};
const agents: Record<string, string[]> = { HELP: ['agent-1'] };

const portalCustomer: Author = { accountId: 'cust-1', accountType: 'customer' };
const employee: Author = { accountId: 'emp-1', accountType: 'atlassian' }; // licensed user, not an agent in HELP
const agent: Author = { accountId: 'agent-1', accountType: 'atlassian' };
const automation: Author = { accountId: 'automation', accountType: 'app' };

const comments: Record<string, Comment[]> = {
  '1': [{ id: 'a', body: para('hello') }],
  '2': [], // no comments
  // newest-first: 150 internal notes hide one public comment on page 2
  '3': [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, jsdPublic: false, body: para('secret') })),
    { id: 'p', body: para('public answer') },
  ],
  '4': [{ id: 'b', visibility: { type: 'role', value: 'Dev' }, body: para('restricted') }],
  // service project, newest-first
  '50': [
    { id: 'c3', created: at(3), author: portalCustomer, body: para('still broken') },
    { id: 'c2', created: at(2), author: agent, jsdPublic: false, body: para('internal: escalate') },
    { id: 'c1', created: at(1), author: agent, jsdPublic: true, body: para('try restarting') },
  ],
  '51': [
    { id: 'd3', created: at(6), author: automation, body: para('Automated reminder') },
    { id: 'd2', created: at(5), author: agent, jsdPublic: true, body: para('fixed') },
    { id: 'd1', created: at(4), author: employee, jsdPublic: true, body: para('please help') },
  ],
  '52': [],
};

const FIELD = {
  comment: 'customfield_10500',
  customerReply: 'customfield_10501',
  agentReply: 'customfield_10502',
  replyBy: 'customfield_10503',
};
const fieldValues = new Map<string, Map<number, string | null>>();
const value = (fieldId: string, issueId: number) => fieldValues.get(fieldId)?.get(issueId);
let rateLimitOnce = false;
const calls: string[] = [];
const agentChecks: string[] = [];

const projectOf = (issueId: string) => Object.entries(projects).find(([, p]) => p.issues.includes(issueId))!;
const projectJson = ([id, p]: [string, (typeof projects)[string]]) => ({ id, key: p.key, projectTypeKey: p.type });

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
    return respond(200, [
      { id: 'summary' },
      { id: FIELD.comment, schema: { custom: 'ari:x/static/last-comment-field' } },
      { id: FIELD.customerReply, schema: { custom: 'ari:x/static/last-customer-reply' } },
      { id: FIELD.agentReply, schema: { custom: 'ari:x/static/last-agent-reply' } },
      { id: FIELD.replyBy, schema: { custom: 'ari:x/static/last-reply-by' } },
    ]);
  }
  if (url.pathname === '/rest/api/3/project/search') {
    return respond(200, { values: Object.entries(projects).map(projectJson), isLast: true });
  }
  const project = /^\/rest\/api\/3\/project\/(\d+)$/.exec(url.pathname);
  if (project) return respond(200, projectJson([project[1], projects[project[1]]]));
  const issue = /^\/rest\/api\/3\/issue\/(\d+)$/.exec(url.pathname);
  if (issue) {
    assert.equal(url.searchParams.get('fields'), 'project');
    return respond(200, { id: issue[1], fields: { project: projectJson(projectOf(issue[1])) } });
  }
  if (url.pathname === '/rest/api/3/user/permission/search') {
    assert.equal(url.searchParams.get('permissions'), 'SERVICEDESK_AGENT');
    const accountId = url.searchParams.get('accountId')!;
    agentChecks.push(accountId);
    const isAgent = agents[url.searchParams.get('projectKey')!]?.includes(accountId);
    return respond(200, isAgent ? [{ accountId }] : []);
  }
  if (url.pathname === '/rest/api/3/search/jql') {
    if (rateLimitOnce) {
      rateLimitOnce = false;
      return respond(429, {}, { 'Retry-After': '7' });
    }
    const req = JSON.parse(init!.body!);
    const pid = /project = (\d+)/.exec(req.jql)![1];
    const start = Number(req.nextPageToken ?? 0);
    const all = projects[pid].issues;
    const ids = all.slice(start, start + req.maxResults);
    const end = start + ids.length;
    return respond(200, {
      issues: ids.map((id) => ({ id })),
      ...(end < all.length ? { nextPageToken: String(end), isLast: false } : { isLast: true }),
    });
  }
  const m = /^\/rest\/api\/3\/issue\/(\d+)\/comment$/.exec(url.pathname);
  if (m) {
    const all = comments[m[1]] ?? [];
    const startAt = Number(url.searchParams.get('startAt'));
    const max = Number(url.searchParams.get('maxResults'));
    return respond(200, { comments: all.slice(startAt, startAt + max), total: all.length, startAt });
  }
  const put = /^\/rest\/api\/3\/app\/field\/([^/]+)\/value$/.exec(url.pathname);
  if (put && init?.method === 'PUT') {
    const values = fieldValues.get(put[1]) ?? new Map();
    for (const u of JSON.parse(init.body!).updates) for (const id of u.issueIds) values.set(id, u.value);
    fieldValues.set(put[1], values);
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

const puts = (fieldId: string) => calls.filter((c) => c === `PUT /rest/api/3/app/field/${fieldId}/value`).length;

test('backfill walks all projects page by page and writes values', async () => {
  const s = await startBackfill();
  assert.equal(s.status, 'running');
  assert.equal(s.projectsTotal, 4);
  await drainQueue();

  assert.equal(value(FIELD.comment, 1), 'hello');
  assert.equal(value(FIELD.comment, 2), null);
  assert.equal(value(FIELD.comment, 3), 'public answer', 'public comment behind 150 internal notes is found');
  assert.equal(value(FIELD.comment, 4), null, 'restricted comment is not leaked');

  const done = await getBackfillState();
  assert.equal(done?.status, 'done');
  assert.equal(done?.projectsDone, 4);
  assert.equal(done?.issuesProcessed, 127);
  assert.equal(fieldValues.get(FIELD.comment)?.has(1119), true, 'last issue of the paged project is written');
  assert.equal(puts(FIELD.comment), 6, 'one PUT per batch');
});

test('backfill fills reply fields in service projects only', () => {
  // 50: customer replied after the agent; the internal note in between is not a reply
  assert.equal(value(FIELD.comment, 50), 'still broken');
  assert.equal(value(FIELD.replyBy, 50), 'Customer');
  assert.equal(value(FIELD.customerReply, 50), at(3));
  assert.equal(value(FIELD.agentReply, 50), at(1));

  // 51: an automation comment is newest, but the last human reply is the agent's;
  // a licensed user who is not an agent in the project counts as a customer
  assert.equal(value(FIELD.comment, 51), 'Automated reminder');
  assert.equal(value(FIELD.replyBy, 51), 'Agent');
  assert.equal(value(FIELD.agentReply, 51), at(5));
  assert.equal(value(FIELD.customerReply, 51), at(4));

  // 52: no comments, values are cleared
  for (const f of [FIELD.replyBy, FIELD.customerReply, FIELD.agentReply]) assert.equal(value(f, 52), null);

  for (const f of [FIELD.replyBy, FIELD.customerReply, FIELD.agentReply]) {
    assert.equal(puts(f), 1, 'one PUT per service project batch');
    assert.equal(fieldValues.get(f)!.size, 3, 'non-service issues are not written');
  }
  assert.deepEqual(agentChecks.sort(), ['agent-1', 'emp-1'], 'one lookup per person; portal customers need none');
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
  assert.equal(value(FIELD.comment, 4), 'restricted');
  store.delete('settings');
  await onComment({ issue: { id: '4' } });
  assert.equal(value(FIELD.comment, 4), null);
  assert.equal(fieldValues.get(FIELD.replyBy)!.has(4), false, 'reply fields stay off non-service issues');
});

test('comment trigger tracks whose turn it is on a service request', async () => {
  comments['52'].unshift({ id: 'e1', created: at(7), author: portalCustomer, body: para('any update?') });
  await onComment({ issue: { id: '52' } });
  assert.equal(value(FIELD.replyBy, 52), 'Customer');
  assert.equal(value(FIELD.customerReply, 52), at(7));
  assert.equal(value(FIELD.agentReply, 52), null);

  // an internal note does not answer the customer
  comments['52'].unshift({ id: 'e2', created: at(8), author: agent, jsdPublic: false, body: para('looking') });
  await onComment({ issue: { id: '52' } });
  assert.equal(value(FIELD.replyBy, 52), 'Customer');
  assert.equal(value(FIELD.comment, 52), 'any update?');

  comments['52'].unshift({ id: 'e3', created: at(9), author: agent, jsdPublic: true, body: para('on it') });
  await onComment({ issue: { id: '52' } });
  assert.equal(value(FIELD.replyBy, 52), 'Agent');
  assert.equal(value(FIELD.agentReply, 52), at(9));
  assert.equal(value(FIELD.customerReply, 52), at(7));
});
