import api, { APIResponse, route } from '@forge/api';
import { JiraComment, Replies, ReplyRole, Settings, formatValue, isEligible, isReply } from './core';

/** Forge module keys of the app's fields (manifest.yml, `jira:customField`). */
export const FIELD_KEYS = {
  lastComment: 'last-comment-field',
  lastCustomerReply: 'last-customer-reply',
  lastAgentReply: 'last-agent-reply',
  lastReplyBy: 'last-reply-by',
} as const;
export type FieldName = keyof typeof FIELD_KEYS;

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

// Module key → customfield_XXXXX. Cached per warm invocation; resolved once from /rest/api/3/field.
let cachedFieldIds: Map<string, string> | null = null;

/** Find a field's customfield_XXXXX id by matching its Forge module key. */
export async function getFieldId(name: FieldName): Promise<string> {
  if (!cachedFieldIds) {
    const res = await checked(await api.asApp().requestJira(route`/rest/api/3/field`), 'Field lookup');
    const fields: Array<{ id: string; schema?: { custom?: string } }> = await res.json();
    cachedFieldIds = new Map();
    for (const f of fields) {
      const key = /\/static\/([^/]+)$/.exec(f.schema?.custom ?? '')?.[1];
      if (key && !cachedFieldIds.has(key)) cachedFieldIds.set(key, f.id);
    }
  }
  const id = cachedFieldIds.get(FIELD_KEYS[name]);
  if (!id) throw new Error(`Field ${FIELD_KEYS[name]} not found`);
  return id;
}

export type ProjectInfo = { id: string; key: string; isServiceProject: boolean };

type JiraProject = { id: string; key: string; projectTypeKey?: string };

const toProjectInfo = (p: JiraProject): ProjectInfo => ({
  id: p.id,
  key: p.key,
  isServiceProject: p.projectTypeKey === 'service_desk',
});

export async function getProject(projectId: string): Promise<ProjectInfo> {
  const res = await checked(
    await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`),
    `Project ${projectId} lookup`,
  );
  return toProjectInfo(await res.json());
}

/** Project of an issue; the issue's project field carries the project type. */
export async function getIssueProject(issueId: string): Promise<ProjectInfo> {
  const res = await checked(
    await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}?fields=project`),
    `Issue ${issueId} lookup`,
  );
  const data: { fields: { project: JiraProject } } = await res.json();
  return toProjectInfo(data.fields.project);
}

// "projectKey/accountId" → agent check. Cached per warm invocation; parallel lookups share one request.
const agentChecks = new Map<string, Promise<boolean>>();

/** An agent holds the service project agent permission in the project; everyone else is a customer. */
function isAgent(accountId: string, projectKey: string): Promise<boolean> {
  const key = `${projectKey}/${accountId}`;
  let check = agentChecks.get(key);
  if (!check) {
    check = (async () => {
      const res = await checked(
        await api
          .asApp()
          .requestJira(
            route`/rest/api/3/user/permission/search?accountId=${accountId}&projectKey=${projectKey}&permissions=SERVICEDESK_AGENT&maxResults=1`,
          ),
        `Agent check in ${projectKey}`,
      );
      const users: Array<{ accountId: string }> = await res.json();
      return users.some((u) => u.accountId === accountId);
    })();
    agentChecks.set(key, check);
    // Do not cache failures (e.g. 429): the next call asks Jira again.
    check.catch(() => agentChecks.delete(key));
  }
  return check;
}

async function replyRole(c: JiraComment, projectKey: string): Promise<ReplyRole> {
  // Portal-only customer accounts can never be agents: skip the lookup.
  if (c.author!.accountType === 'customer') return 'Customer';
  return (await isAgent(c.author!.accountId!, projectKey)) ? 'Agent' : 'Customer';
}

/** Values of the app's fields for one issue. `replies` is set only for service project issues. */
export type IssueValues = { lastComment: string | null; replies?: Replies };

/**
 * Value for the newest eligible comment and, in service projects, the newest
 * customer and agent replies. Pages through comments newest-first and stops once
 * everything is found, so a long tail of restricted/internal comments does not
 * hide an older public one.
 */
export async function computeValues(issueId: string, settings: Settings, project: ProjectInfo): Promise<IssueValues> {
  let lastComment: string | null = null;
  const replies: Replies = { lastCustomerReply: null, lastAgentReply: null, lastReplyBy: null };
  const result = (): IssueValues => (project.isServiceProject ? { lastComment, replies } : { lastComment });
  const complete = () =>
    lastComment !== null && (!project.isServiceProject || (!!replies.lastCustomerReply && !!replies.lastAgentReply));

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
    for (const c of data.comments) {
      if (lastComment === null && isEligible(c, settings)) lastComment = formatValue(c, settings);
      if (project.isServiceProject && isReply(c)) {
        const role = await replyRole(c, project.key);
        replies.lastReplyBy ??= role;
        if (role === 'Customer') replies.lastCustomerReply ??= c.created!;
        else replies.lastAgentReply ??= c.created!;
      }
      if (complete()) return result();
    }
    startAt += data.comments.length;
    if (data.comments.length === 0 || startAt >= (data.total ?? 0)) return result();
  }
  console.warn(`Issue ${issueId}: comments not fully scanned within ${MAX_COMMENT_PAGES} pages`);
  return result();
}

/** Write one field for many issues in one request; issues sharing a value are grouped. */
async function writeField(name: FieldName, values: Map<string, string | null>): Promise<void> {
  if (values.size === 0) return;
  const groups = new Map<string | null, number[]>();
  for (const [issueId, value] of values) {
    const ids = groups.get(value) ?? [];
    ids.push(Number(issueId));
    groups.set(value, ids);
  }
  const updates = [...groups].map(([value, issueIds]) => ({ issueIds, value }));
  const fieldId = await getFieldId(name);
  await checked(
    await api.asApp().requestJira(route`/rest/api/3/app/field/${fieldId}/value?generateChangelog=false`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    }),
    `Field ${FIELD_KEYS[name]} update`,
  );
}

/**
 * Write every value computed for the given issues: one request per field.
 * Reply fields are written only for service project issues.
 */
export async function writeIssueValues(entries: Array<[string, IssueValues]>): Promise<void> {
  const fields: Record<FieldName, Map<string, string | null>> = {
    lastComment: new Map(),
    lastCustomerReply: new Map(),
    lastAgentReply: new Map(),
    lastReplyBy: new Map(),
  };
  for (const [issueId, v] of entries) {
    fields.lastComment.set(issueId, v.lastComment);
    if (v.replies) {
      fields.lastCustomerReply.set(issueId, v.replies.lastCustomerReply);
      fields.lastAgentReply.set(issueId, v.replies.lastAgentReply);
      fields.lastReplyBy.set(issueId, v.replies.lastReplyBy);
    }
  }
  for (const name of Object.keys(fields) as FieldName[]) await writeField(name, fields[name]);
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
