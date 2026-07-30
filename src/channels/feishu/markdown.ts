const MARKDOWN_BLOCK = /(^|\n)\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|~~~)/u;
const MARKDOWN_INLINE = /(?:\*\*|__)[^\n]+?(?:\*\*|__)|`[^`\n]+`|\[[^\]\n]+\]\([^)]+\)|~~[^\n]+?~~/u;
const MARKDOWN_TABLE = /(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*\|/u;

/**
 * Feishu `text` messages never interpret Markdown. Route only content that
 * actually carries Markdown syntax through an interactive markdown card so
 * short plain messages retain their lightweight text representation.
 */
export function shouldRenderAsMarkdownCard(content: Record<string, unknown>, renderedText: string): boolean {
  if (typeof content.markdown === 'string' && content.markdown.trim()) return true;
  return MARKDOWN_BLOCK.test(renderedText) || MARKDOWN_INLINE.test(renderedText) || MARKDOWN_TABLE.test(renderedText);
}
