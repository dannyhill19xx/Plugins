import api, { route } from '@forge/api';

const MODULE_KEY = 'last-comment-field';
const MAX_LEN = 255; // Jira string custom field limit

// Cached per warm invocation; resolved once from /rest/api/3/field.
let cachedFieldId: string | null = null;

type AdfNode = { type: string; text?: string; attrs?: Record<string, any>; content?: AdfNode[] };

type JiraComment = {
  id: string;
  body?: AdfNode;
  visibility?: { type: string; value: string }; // group/role restriction
  jsdPublic?: boolean;                          // false = JSM internal note
};

/** Find our field's customfield_XXXXX id by matching the Forge module key. */
async function getFieldId(): Promise<string> {
  if (cachedFieldId) return cachedFieldId;
  const res = await api.asApp().requestJira(route`/rest/api/3/field`);
  if (!res.ok) throw new Error(`Field lookup failed: ${res.status}`);
  const fields: Array<{ id: string; schema?: { custom?: string } }> = await res.json();
  const field = fields.find((f) => f.schema?.custom?.endsWith(`/static/${MODULE_KEY}`));
  if (!field) throw new Error('Last comment field not found');
  cachedFieldId = field.id;
  return field.id;
}

/** Flatten Atlassian Document Format into plain text. */
function adfToText(node?: AdfNode): string {
  if (!node) return '';
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'mention':
      return node.attrs?.text ?? '@user';
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'hardBreak':
      return ' ';
    case 'inlineCard':
      return node.attrs?.url ?? '';
    default: {
      const inner = (node.content ?? []).map(adfToText).join('');
      const isBlock = ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type);
      return isBlock ? `${inner} ` : inner;
    }
  }
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_LEN ? clean : `${clean.slice(0, MAX_LEN - 1)}…`;
}

/** Restricted or internal comments must never leak into a field everyone can see. */
function isPublic(c: JiraComment): boolean {
  return !c.visibility && c.jsdPublic !== false;
}

async function latestPublicCommentText(issueId: string): Promise<string | null> {
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueId}/comment?orderBy=-created&maxResults=50`);
  if (!res.ok) throw new Error(`Comment fetch failed for ${issueId}: ${res.status}`);
  const data: { comments: JiraComment[] } = await res.json();
  const latest = data.comments.find(isPublic);
  return latest ? truncate(adfToText(latest.body)) : null;
}

async function writeValue(issueId: string, value: string | null): Promise<void> {
  const fieldId = await getFieldId();
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/app/field/${fieldId}/value?generateChangelog=false`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ issueIds: [Number(issueId)], value }] }),
    });
  if (!res.ok) throw new Error(`Field update failed for ${issueId}: ${res.status} ${await res.text()}`);
}

export async function onComment(event: any): Promise<void> {
  const issueId: string | undefined = event?.issue?.id;
  if (!issueId) {
    console.warn('Event without issue id', JSON.stringify(event).slice(0, 500));
    return;
  }
  const text = await latestPublicCommentText(issueId);
  await writeValue(issueId, text);
  console.log(`Issue ${issueId}: last comment field updated`);
}
