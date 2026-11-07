import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  JiraComment,
  adfToText,
  formatValue,
  isEligible,
  isPublic,
  isReply,
  sanitizeSettings,
  truncate,
} from '../src/core';

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
});

test('adfToText flattens paragraphs, mentions and emoji', () => {
  const body = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { text: '@Anna' } },
          { type: 'text', text: ' fixed ' },
          { type: 'emoji', attrs: { shortName: ':tada:' } },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    ],
  };
  assert.equal(truncate(adfToText(body), 255), '@Anna fixed :tada: second');
});

test('truncate collapses whitespace and adds ellipsis within the limit', () => {
  assert.equal(truncate('  a \n\n b  ', 255), 'a b');
  const out = truncate('x'.repeat(300), 255);
  assert.equal(out.length, 255);
  assert.ok(out.endsWith('…'));
});

test('restricted and JSM internal comments are not public', () => {
  assert.equal(isPublic({ id: '1' }), true);
  assert.equal(isPublic({ id: '2', visibility: { type: 'role', value: 'Developers' } }), false);
  assert.equal(isPublic({ id: '3', jsdPublic: false }), false);
  assert.equal(isPublic({ id: '4', jsdPublic: true }), true);
});

test('includeRestricted makes every comment eligible', () => {
  const internal: JiraComment = { id: '3', jsdPublic: false };
  assert.equal(isEligible(internal, DEFAULT_SETTINGS), false);
  assert.equal(isEligible(internal, { ...DEFAULT_SETTINGS, includeRestricted: true }), true);
});

test('only public comments written by people are replies', () => {
  const base: JiraComment = { id: '1', created: '2026-11-07T10:00:00.000+0700', author: { accountId: 'u1', accountType: 'atlassian' } };
  assert.equal(isReply(base), true);
  assert.equal(isReply({ ...base, author: { accountId: 'c1', accountType: 'customer' } }), true);
  assert.equal(isReply({ ...base, jsdPublic: false }), false, 'internal note');
  assert.equal(isReply({ ...base, visibility: { type: 'group', value: 'staff' } }), false, 'restricted');
  assert.equal(isReply({ ...base, author: { accountId: 'bot', accountType: 'app' } }), false, 'automation');
  assert.equal(isReply({ ...base, author: undefined }), false, 'no author');
  assert.equal(isReply({ ...base, created: undefined }), false, 'no date');
});

test('formatValue adds date and author prefix when enabled', () => {
  const c: JiraComment = {
    id: '1',
    body: doc('Deployed to prod'),
    created: '2026-11-07T10:15:00.000+0700',
    author: { displayName: 'Ivan Petrov' },
  };
  assert.equal(formatValue(c, DEFAULT_SETTINGS), 'Deployed to prod');
  assert.equal(
    formatValue(c, { ...DEFAULT_SETTINGS, showDate: true, showAuthor: true }),
    '[2026-11-07, Ivan Petrov] Deployed to prod',
  );
  assert.equal(formatValue(c, { ...DEFAULT_SETTINGS, showAuthor: true }), '[Ivan Petrov] Deployed to prod');
});

test('formatValue respects maxLength including the prefix', () => {
  const c: JiraComment = { id: '1', body: doc('y'.repeat(100)), author: { displayName: 'Bob' } };
  const out = formatValue(c, { ...DEFAULT_SETTINGS, showAuthor: true, maxLength: 30 });
  assert.equal(out.length, 30);
  assert.ok(out.startsWith('[Bob] '));
});

test('sanitizeSettings clamps length and rejects non-boolean flags', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.equal(sanitizeSettings({ maxLength: 1000 }).maxLength, 255);
  assert.equal(sanitizeSettings({ maxLength: 3 }).maxLength, 20);
  assert.equal(sanitizeSettings({ maxLength: 'abc' }).maxLength, 255);
  assert.equal(sanitizeSettings({ maxLength: '80' }).maxLength, 80);
  assert.equal(sanitizeSettings({ includeRestricted: 'true' }).includeRestricted, false);
  assert.equal(sanitizeSettings({ showAuthor: true }).showAuthor, true);
});
