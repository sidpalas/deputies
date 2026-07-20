import { describe, expect, it } from 'vitest';
import type { Snippet } from '../../api.js';
import { insertSnippet, matchingSnippets, snippetQueryAtCaret } from './snippet-picker.js';

const snippets: Snippet[] = [
  { id: '1', ownerUserId: 'u', name: 'review-pr', body: 'Review this pull request', createdAt: '', updatedAt: '' },
  { id: '2', ownerUserId: 'u', name: 'archived', body: 'Old', archivedAt: '2026-01-01', createdAt: '', updatedAt: '' },
];

describe('personal snippet picker', () => {
  it('matches a standalone double-slash query at the caret and filters active snippets', () => {
    expect(matchingSnippets(snippets, '//review')).toEqual([snippets[0]]);
    expect(matchingSnippets(snippets, '/review')).toEqual([]);
    expect(matchingSnippets(snippets, 'use //review')).toEqual([snippets[0]]);
    expect(matchingSnippets(snippets, 'first\n\n//review')).toEqual([snippets[0]]);
    expect(matchingSnippets(snippets, '//archived')).toEqual([]);
  });

  it('rejects URL and path-like double slashes', () => {
    for (const prompt of ['https://example.com', 'path//segment', 'some//text', 'use //review/path']) {
      expect(snippetQueryAtCaret(prompt, prompt.length)).toBeNull();
    }
  });

  it('replaces only the query token and returns the caret after editable body text', () => {
    expect(insertSnippet('Please //review-pr carefully.', snippets[0]!, 18)).toEqual({
      prompt: 'Please Review this pull request carefully.',
      selectionStart: 31,
    });
  });

  it('replaces the entire token when the caret is within it', () => {
    expect(insertSnippet('Before //review-pr after', snippets[0]!, 12)).toEqual({
      prompt: 'Before Review this pull request after',
      selectionStart: 31,
    });
  });
});
