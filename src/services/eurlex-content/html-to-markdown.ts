/**
 * @fileoverview Server-side HTML→Markdown conversion for EU act bodies.
 *
 * EUR-Lex/CELLAR serves acts as CONVEX-generated XHTML in which the numbered
 * structure — recitals, article paragraphs, lettered/roman points — is laid out
 * in two-column tables: a narrow marker column (`(1)`, `(a)`, `1.1.`, `—`) beside
 * a wide ~96% prose column. A naive HTML→Markdown pass turns each of these into an
 * unreadable two-column GFM row (`| (1) | The protection of natural persons… |`).
 *
 * This module pre-processes the parsed DOM before conversion:
 *  - strips non-body chrome (`<head>`, inline `<style>`/`<script>`, the OJ
 *    masthead table, separators, dead intra-document fragment links);
 *  - flattens the numbering layout tables into inline-marked block text
 *    (`(1) The protection of natural persons…`), recursing innermost-first so
 *    nested points collapse cleanly;
 *  - preserves genuine data tables — CONVEX tags them `class="oj-table"` — so
 *    node-html-markdown renders them as real GFM tables.
 *
 * The conversion produces the full Markdown body; windowing/pagination is applied
 * downstream by the caller (a paged window may land mid-structure — acceptable).
 * @module services/eurlex-content/html-to-markdown
 */

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { HTMLElement, type Node, NodeType, parse } from 'node-html-parser';

/** Chrome removed wholesale before conversion (head/style/script/link/separators). */
const CHROME_SELECTOR = 'head, style, script, link, hr';

/**
 * The OJ masthead table (date | language | "Official Journal of the European
 * Union" | "L 119/1") is identified by these CONVEX paragraph classes and dropped
 * so it never leads the body.
 */
const MASTHEAD_SELECTOR = '.oj-hd-ti, .oj-hd-oj, .oj-hd-date, .oj-hd-lg';

/**
 * Lead-column width (percent) at or below which a class-less table is treated as a
 * numbering layout (its first column holds a `4%` marker), not tabular data. Every
 * observed genuine data table leads with a column ≥ 20%; numbering tables lead with
 * `4%` (single marker) or `4%`/`4%` (nested marker). The OJ masthead's `10%` lead
 * also falls under this floor, a harmless extra guard since it is stripped above.
 */
const LAYOUT_LEAD_COL_MAX_PCT = 10;

/** Max length of a first-cell string still considered an ordinal marker (col-less fallback). */
const MARKER_MAX_LEN = 6;

/**
 * Convert an EU act XHTML/HTML body to clean Markdown. Numbering layout tables
 * become inline-marked text; genuine data tables become GFM tables; no raw HTML
 * leaks through. Returns the full converted body.
 */
export function htmlToMarkdown(html: string): string {
  const root = parse(html, { comment: false });
  stripChrome(root);
  const body = root.querySelector('body') ?? root;
  flattenLayoutTables(body);
  return NodeHtmlMarkdown.translate(body.innerHTML).trim();
}

/** Remove document chrome and neutralize dead intra-document links in place. */
function stripChrome(root: HTMLElement): void {
  for (const node of root.querySelectorAll(CHROME_SELECTOR)) node.remove();
  for (const table of root.querySelectorAll('table')) {
    if (table.querySelector(MASTHEAD_SELECTOR)) table.remove();
  }
  // Intra-document fragment anchors (footnote refs, internal cross-refs) don't
  // survive as Markdown links — keep the visible text, drop the dead href.
  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? '';
    if (href === '' || href.startsWith('#')) {
      anchor.replaceWith(parse(`<span>${anchor.innerHTML}</span>`));
    }
  }
}

/**
 * Flatten numbering layout tables to inline-marked block text, innermost-first so
 * a nested point is already collapsed when its parent row is rebuilt. Genuine data
 * tables are left intact for GFM conversion.
 */
function flattenLayoutTables(node: HTMLElement): void {
  for (const child of [...node.childNodes]) {
    if (child instanceof HTMLElement) flattenLayoutTables(child);
  }
  if (isTag(node, 'table') && !isGenuineDataTable(node)) {
    node.replaceWith(parse(flattenNumberingTable(node)));
  }
}

/**
 * Whether a table carries tabular data (→ GFM) rather than numbering layout
 * (→ flattened text). CONVEX marks real tables `class="oj-table"`; for class-less
 * tables, a wide lead column (or, when no `<col>` widths exist, rows that don't all
 * begin with a short ordinal marker) signals genuine data.
 */
function isGenuineDataTable(table: HTMLElement): boolean {
  if (/\boj-table\b/.test(table.getAttribute('class') ?? '')) return true;
  const leadPct = leadColWidthPct(table);
  if (leadPct !== null) return leadPct > LAYOUT_LEAD_COL_MAX_PCT;
  return !allRowsLeadWithMarker(table);
}

/** Width (percent) of the table's own first `<col>`, or null when absent/unparseable. */
function leadColWidthPct(table: HTMLElement): number | null {
  const col = directChildrenByTag(table, ['col'])[0];
  const match = (col?.getAttribute('width') ?? '').match(/^(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

/** True when every row's first cell is empty or a short ordinal marker (no `<col>` widths). */
function allRowsLeadWithMarker(table: HTMLElement): boolean {
  const rows = directRows(table);
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const first = directCells(row)[0];
    if (!first) return true;
    const text = first.text.trim();
    return text === '' || (text.length <= MARKER_MAX_LEN && !/\s/.test(text));
  });
}

/**
 * Rebuild a numbering layout table as a `<div>` of block rows: the marker cell(s)
 * are prefixed inline onto the prose cell so each row reads `(1) prose…`. The prose
 * cell's inner HTML is preserved verbatim, so inline markup and any nested genuine
 * tables (already-flattened nested points) carry through unchanged.
 */
function flattenNumberingTable(table: HTMLElement): string {
  const blocks: string[] = [];
  for (const row of directRows(table)) {
    const cells = directCells(row);
    const prose = cells.at(-1);
    if (!prose) continue;
    const marker = cells
      .slice(0, -1)
      .map((cell) => cell.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    let inner = prose.innerHTML.trim();
    if (marker) {
      const openTag = inner.match(/^<p\b[^>]*>/i);
      inner = openTag
        ? inner.slice(0, openTag[0].length) +
          `${escapeHtml(marker)} ` +
          inner.slice(openTag[0].length)
        : `<p>${escapeHtml(marker)}</p>${inner}`;
    }
    if (inner) blocks.push(inner);
  }
  return `<div>${blocks.join('\n')}</div>`;
}

function isTag(node: Node, tag: string): node is HTMLElement {
  return node instanceof HTMLElement && node.rawTagName?.toLowerCase() === tag;
}

function directChildrenByTag(node: HTMLElement, tags: readonly string[]): HTMLElement[] {
  return node.childNodes.filter(
    (child): child is HTMLElement =>
      child.nodeType === NodeType.ELEMENT_NODE &&
      tags.includes((child as HTMLElement).rawTagName?.toLowerCase()),
  );
}

/** A table's own rows (direct `<tr>`, plus those under its direct sections) — never nested tables'. */
function directRows(table: HTMLElement): HTMLElement[] {
  const sections = directChildrenByTag(table, ['tbody', 'thead', 'tfoot']);
  const rows = sections.flatMap((section) => directChildrenByTag(section, ['tr']));
  rows.push(...directChildrenByTag(table, ['tr']));
  return rows;
}

function directCells(row: HTMLElement): HTMLElement[] {
  return directChildrenByTag(row, ['td', 'th']);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
