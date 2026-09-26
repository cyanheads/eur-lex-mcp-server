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
 *    masthead table, the legacy `text/html` page's legal-notice banner,
 *    separators, dead intra-document fragment links);
 *  - flattens the numbering layout tables into inline-marked block text
 *    (`(1) The protection of natural persons…`), recursing innermost-first so
 *    nested points collapse cleanly;
 *  - joins a consolidated text's point labels to their text (#120): consolidated
 *    versions lay points out as CSS-grid divs rather than numbering tables, so a
 *    label would otherwise render as a paragraph of its own;
 *  - preserves genuine data tables — CONVEX tags them `class="oj-table"` — so
 *    node-html-markdown renders them as real GFM tables.
 *
 * The pre-processed body is then translated block by block (#127), never
 * serialized whole, so node-html-markdown never parses a second whole-act DOM.
 * The conversion produces the full Markdown body; windowing/pagination is applied
 * downstream by the caller (a paged window may land mid-structure — acceptable).
 * @module services/eurlex-content/html-to-markdown
 */

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { HTMLElement, type Node, NodeType, parse } from 'node-html-parser';

/**
 * Chrome removed wholesale before conversion: head/style/script/link, separators,
 * and the legal-notice banner (`<div id="banner">`) every legacy `text/html` page
 * opens with (#120).
 */
const CHROME_SELECTOR = 'head, style, script, link, hr, #banner';

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
  joinConsolidatedLabels(body);
  const blocks: string[] = [];
  translateBlocks(body, new NodeHtmlMarkdown(), blocks);
  return blocks.join('\n\n').trim();
}

/**
 * Tags node-html-markdown lays out as blocks, each separated from its neighbours
 * by a blank line — its own `defaultBlockElements`, less those chrome stripping
 * or the ignore list already removes.
 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'dd',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/**
 * Translate a container one block at a time into `out` (#127): a `<div>` holding
 * elements is descended into, any other block child is translated alone, and each
 * run of inline children between blocks — text beside a `<b>`, a label moved in
 * front of its text — is translated together as the paragraph it forms. A
 * whole-body translation re-serializes the body and has node-html-markdown parse
 * that string into a second whole-act DOM; this walk hands it one block at a time.
 */
function translateBlocks(container: HTMLElement, nhm: NodeHtmlMarkdown, out: string[]): void {
  let inline = '';
  const flush = () => {
    push(inline);
    inline = '';
  };
  const push = (html: string) => {
    if (html.trim() === '') return;
    const markdown = nhm.translate(html).replace(/^\n+|\n+$/g, '');
    if (markdown.trim() !== '') out.push(markdown);
  };
  for (const child of container.childNodes) {
    if (!(child instanceof HTMLElement)) {
      inline += child.rawText;
      continue;
    }
    const tag = child.rawTagName?.toLowerCase() ?? '';
    if (!BLOCK_TAGS.has(tag)) {
      inline += child.outerHTML;
      continue;
    }
    flush();
    if (tag === 'div' && child.childNodes.some((node) => node instanceof HTMLElement)) {
      translateBlocks(child, nhm, out);
    } else {
      push(child.outerHTML);
    }
  }
  flush();
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
      anchor.replaceWith(`<span>${anchor.innerHTML}</span>`);
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
    node.replaceWith(flattenNumberingTable(node));
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

/**
 * Join a consolidated text's point labels to the text after them, as the OJ
 * rendering reads (#120), innermost-first so a nested row is already joined when
 * its parent row is rebuilt. A `div.grid-container.grid-list` row becomes its
 * `.grid-list-column-2` text with the `.grid-list-column-1` label in front, and a
 * `span.no-parag` paragraph number moves into the element that follows it. Each
 * element's children are read once, so the pass is linear in the body.
 */
function joinConsolidatedLabels(node: HTMLElement): void {
  const children = node.childNodes;
  for (const child of children) {
    if (child instanceof HTMLElement) joinConsolidatedLabels(child);
  }
  const kept: Node[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Node;
    kept.push(child);
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains('grid-container') && child.classList.contains('grid-list')) {
      const cells = directChildrenByTag(child, ['div']);
      const label = cells.find((cell) => cell.classList.contains('grid-list-column-1'));
      const text = cells.find((cell) => cell.classList.contains('grid-list-column-2'));
      if (!label || !text) continue;
      prefixLabel(label, text);
      text.parentNode = node;
      kept[kept.length - 1] = text;
    } else if (isTag(child, 'span') && child.classList.contains('no-parag')) {
      let next = i + 1;
      while (next < children.length && isBlankText(children[next] as Node)) next++;
      const target = children[next];
      if (!(target instanceof HTMLElement)) continue;
      prefixLabel(child, target);
      kept.pop();
    }
  }
  node.childNodes = kept;
}

/**
 * Put a label at the start of the first block of `container`'s text — descending
 * through leading `<p>`/`<div>` wrappers — or of its bare text.
 */
function prefixLabel(label: HTMLElement, container: HTMLElement): void {
  const markup = labelMarkup(label).replace(/\s+/g, ' ').trim();
  if (markup === '') return;
  let target = container;
  for (;;) {
    const lead = target.childNodes.find((child) => !isBlankText(child));
    if (!(lead instanceof HTMLElement) || !(isTag(lead, 'p') || isTag(lead, 'div'))) break;
    target = lead;
  }
  target.insertAdjacentHTML('afterbegin', `${markup} `);
}

/**
 * A label's content as inline markup, its `<span>` wrappers dropped: the number
 * then joins the text after it as one run, which the conversion escapes where it
 * would read as a list item (`1\.`), while other markup — an amendment marker
 * linked beside a point number — keeps its link.
 */
function labelMarkup(node: HTMLElement): string {
  return node.childNodes
    .map((child) => {
      if (isTag(child, 'span')) return labelMarkup(child);
      return child instanceof HTMLElement ? child.outerHTML : child.rawText;
    })
    .join('');
}

function isBlankText(node: Node): boolean {
  return node.nodeType === NodeType.TEXT_NODE && node.text.trim() === '';
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
