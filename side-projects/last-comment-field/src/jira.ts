import api, { APIResponse, route } from '@forge/api';
import { JiraComment, Settings, formatValue, isEligible } from './core';

const MODULE_KEY = 'last-comment-field';
const COMMENT_PAGE_SIZE = 100;
/** Upper bound on comment pages scanned per issue (10 000 comments). */
const MAX_COMMENT_PAGES = 100;

/** Jira answered 429: the caller should retry after `retryAfterSec`. */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`Jira rate limit, retry after ${retryAfterSec}s`);
  }
}

async function checked(res: APIResponse, what: string): Promise<APIResponse> {
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    throw new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
  }
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res;
}

// Cached per warm invocation; resolved once from /rest/api/3/field.
let cachedFieldId: string | null = null;

/** Find our field's customfield_XXXXX id by matching the Forge module key. */
export async function getFieldId(): Promise<string> {
  if (cachedFieldId) return cachedFieldId;
  const res = await checked(await api.asApp().requestJira(route`/rest/api/3/field`), 'Field lookup');
  const fields: Array<{ id: string; schema?: { custom?: string } }> = await res.json();
  const field = fields.find((f) => f.schema?.custom?.endsWith(`/static/${MODULE_KEY}`));
  if (!field) throw new Error('Last comment field not found');
  cachedFieldId = field.id;
  return field.id;
}

/**
 * Value for the newest eligible comment, or null if there is none.
 * Pages through comments newest-first, so a long tail of restricted/internal
 * comments does not hide an older public one.
 */
export async function computeValue(issueId: string, settings: Settings): Promise<string | null> {
  for (let page = 0, startAt = 0; page < MAX_COMMENT_PAGES; page++) {
    const res = await checked(
      await api
        .asApp()
        .requestJira(
          route`/rest/api/3/issue/${issueId}/comment?orderBy=-created&startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`,
        ),
      `Comment fetch for ${issueId}`,
    );
    const data: { comments: JiraComment[]; total?: number } = await res.json();
    const hit = data.comments.find((c) => isEligible(c, settings));
    if (hit) return formatValue(hit, settings);
    startAt += data.comments.length;
    if (data.comments.length === 0 || startAt >= (data.total ?? 0)) return null;
  }
  console.warn(`Issue ${issueId}: no eligible comment within ${MAX_COMMENT_PAGES} pages`);
  return null;
}

/** Write values for many issues in one request; issues sharing a value are grouped. */
export async function writeValues(values: Map<string, string | null>): Promise<void> {
  if (values.size === 0) return;
  const groups = new Map<string | null, number[]>();
  for (const [issueId, value] of values) {
    const ids = groups.get(value) ?? [];
    ids.push(Number(issueId));
    groups.set(value, ids);
  }
  const updates = [...groups].map(([value, issueIds]) => ({ issueIds, value }));
  const fieldId = await getFieldId();
  await checked(
    await api.asApp().requestJira(route`/rest/api/3/app/field/${fieldId}/value?generateChangelog=false`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    }),
    'Field update',
  );
}

/** All project ids visible to the app. */
export async function listProjectIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let startAt = 0; ; ) {
    const res = await checked(
      await api.asApp().requestJira(route`/rest/api/3/project/search?startAt=${startAt}&maxResults=50`),
      'Project search',
    );
    const data: { values: Array<{ id: string }>; isLast?: boolean } = await res.json();
    ids.push(...data.values.map((p) => p.id));
    startAt += data.values.length;
    if (data.isLast !== false || data.values.length === 0) return ids;
  }
}

/** One page of issue ids in a project, via the enhanced JQL search (token paging). */
export async function searchIssueIds(
  projectId: string,
  nextPageToken: string | undefined,
  maxResults: number,
): Promise<{ issueIds: string[]; nextPageToken?: string }> {
  const res = await checked(
    await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql: `project = ${projectId} ORDER BY id ASC`,
        fields: ['id'],
        maxResults,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    }),
    `Issue search in project ${projectId}`,
  );
  const data: { issues: Array<{ id: string }>; nextPageToken?: string; isLast?: boolean } = await res.json();
  return {
    issueIds: data.issues.map((i) => i.id),
    nextPageToken: data.isLast === true ? undefined : data.nextPageToken,
  };
}
