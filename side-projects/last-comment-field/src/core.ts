// Pure logic: no Forge imports, so it is unit-testable with plain Node.

export const JIRA_STRING_FIELD_LIMIT = 255;

export type AdfNode = { type: string; text?: string; attrs?: Record<string, any>; content?: AdfNode[] };

export type JiraComment = {
  id: string;
  body?: AdfNode;
  created?: string;
  author?: { displayName?: string };
  visibility?: { type: string; value: string }; // group/role restriction
  jsdPublic?: boolean; // false = JSM internal note
};

export type Settings = {
  /** Max characters stored in the field (Jira limit for string fields is 255). */
  maxLength: number;
  /** Prefix the text with the comment author's display name. */
  showAuthor: boolean;
  /** Prefix the text with the comment creation date (YYYY-MM-DD, UTC). */
  showDate: boolean;
  /**
   * Also use restricted comments (group/role visibility) and JSM internal notes.
   * The field is visible to everyone who can see the issue, so this is off by default.
   */
  includeRestricted: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  maxLength: JIRA_STRING_FIELD_LIMIT,
  showAuthor: false,
  showDate: false,
  includeRestricted: false,
};

export const MIN_LENGTH = 20;

/** Coerce untrusted input (stored value or admin form) into valid settings. */
export function sanitizeSettings(input: unknown): Settings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const len = Math.round(Number(raw.maxLength));
  return {
    maxLength: Number.isFinite(len)
      ? Math.min(JIRA_STRING_FIELD_LIMIT, Math.max(MIN_LENGTH, len))
      : DEFAULT_SETTINGS.maxLength,
    showAuthor: raw.showAuthor === true,
    showDate: raw.showDate === true,
    includeRestricted: raw.includeRestricted === true,
  };
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableCell', 'tableHeader']);

/** Flatten Atlassian Document Format into plain text. */
export function adfToText(node?: AdfNode): string {
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
      return BLOCK_TYPES.has(node.type) ? `${inner} ` : inner;
    }
  }
}

export function truncate(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`;
}

/** Restricted or internal comments must never leak into a field everyone can see. */
export function isPublic(c: JiraComment): boolean {
  return !c.visibility && c.jsdPublic !== false;
}

export function isEligible(c: JiraComment, settings: Settings): boolean {
  return settings.includeRestricted || isPublic(c);
}

/** Build the field value for a comment according to settings. */
export function formatValue(c: JiraComment, settings: Settings): string {
  const meta: string[] = [];
  if (settings.showDate && c.created) meta.push(c.created.slice(0, 10));
  if (settings.showAuthor && c.author?.displayName) meta.push(c.author.displayName);
  const prefix = meta.length ? `[${meta.join(', ')}] ` : '';
  return truncate(prefix + adfToText(c.body), settings.maxLength);
}
