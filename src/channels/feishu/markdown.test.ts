import { describe, expect, it } from 'vitest';

import { shouldRenderAsMarkdownCard } from './markdown.js';

describe('shouldRenderAsMarkdownCard', () => {
  it.each([
    '# Heading',
    '**bold**',
    '- item',
    '1. item',
    '> quote',
    '```text\ncode\n```',
    '`inline`',
    '[label](https://example.test)',
    '| A | B |\n| --- | --- |',
  ])('detects Markdown syntax in text: %s', (text) => {
    expect(shouldRenderAsMarkdownCard({ text }, text)).toBe(true);
  });

  it('honors an explicit markdown field without requiring syntax markers', () => {
    expect(shouldRenderAsMarkdownCard({ markdown: 'render this' }, 'render this')).toBe(true);
  });

  it.each(['plain hi', 'Error: provider unavailable', '2.5 grams', 'a * b'])(
    'keeps plain text lightweight: %s',
    (text) => {
      expect(shouldRenderAsMarkdownCard({ text }, text)).toBe(false);
    },
  );
});
