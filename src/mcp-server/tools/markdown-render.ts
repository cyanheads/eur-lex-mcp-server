/**
 * @fileoverview Markdown renderers shared by the tools' `content[]` output: an
 * ATX-heading escaper and the blockquote form of the enrichment `notice` trailer.
 * @module mcp-server/tools/markdown-render
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * `text` encoded for an ATX heading, which a CommonMark parse reads back as
 * `text`: escaped as running text, each line break written as `&#10;` in place
 * of the escaper's hard break (a heading holds one line), and a final `#`
 * escaped so it cannot close the heading.
 */
export function escapeMarkdownHeading(text: string): string {
  const encoded = escapeMarkdownInline(text).replaceAll('\\\n', '&#10;');
  return encoded.endsWith('#') && !encoded.endsWith('\\#') ? `${encoded.slice(0, -1)}\\#` : encoded;
}

/**
 * The enrichment `notice` as a `content[]` blockquote. A notice quotes caller input
 * and upstream values, so it is escaped whole and every line keeps the quote marker.
 * `md` lets a caller that renders repeatedly pass a memoized escaper.
 */
export function renderNoticeBlockquote(
  notice: string,
  md: (text: string) => string = escapeMarkdownInline,
): string {
  return `> ${md(notice).replaceAll('\n', '\n> ')}`;
}
