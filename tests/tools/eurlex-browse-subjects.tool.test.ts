/**
 * @fileoverview Tests for eurlex_browse_subjects tool.
 * @module tests/tools/eurlex-browse-subjects.tool.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_browse_subjects } from '@/mcp-server/tools/definitions/eurlex-browse-subjects.tool.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';
import { readCommonMark } from '../helpers/commonmark.js';
import { assertInSortWindow, pageSpan, pagingClauses } from '../helpers/sort-window.js';

// --- Service mock ---
const mockQuery = vi.fn();
let mockMaxResults = 100;
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({
    query: mockQuery,
    queryWithContinuation: mockQuery,
    maxResults: mockMaxResults,
  }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
  },
}));

function makeConceptBinding(opts: {
  uri: string;
  label: string;
  code?: string;
  broaderLabel?: string;
  matchedLabel?: string;
  /** Tier of the matched alternative label (1 exact, 2 word start, 3 substring). */
  matchedTier?: 1 | 2 | 3;
  tier?: 1 | 2 | 3;
}): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    concept: { type: 'uri', value: opts.uri },
    label: { type: 'literal', value: opts.label },
    tier: { type: 'literal', value: String(opts.tier ?? 3) },
    // Mirrors MIN(tier digit + ?altValue): the best-tier alternative label behind
    // its tier digit, or "" when no alternative label matched (#113).
    matchedKey: {
      type: 'literal',
      value: opts.matchedLabel ? `${opts.matchedTier ?? 3}${opts.matchedLabel}` : '',
    },
  };
  if (opts.code) b.code = { type: 'literal', value: opts.code };
  if (opts.broaderLabel) b.broaderLabel = { type: 'literal', value: opts.broaderLabel };
  return b;
}

/** The SPARQL text of the first query the handler sent. */
function sentQuery(): string {
  return mockQuery.mock.calls[0]?.[0] as string;
}

/** Every text block of a tool result's content[], joined. */
function contentText(result: { content: unknown[] }): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

describe('eurlex_browse_subjects', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockMaxResults = 100;
  });

  // --- Happy paths ---

  it('returns matching EuroVoc concepts', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({
        uri: 'http://eurovoc.europa.eu/2830',
        label: 'data protection',
        code: '2830',
        broaderLabel: 'information',
      }),
      makeConceptBinding({
        uri: 'http://eurovoc.europa.eu/5550',
        label: 'personal data',
        code: '5550',
      }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data' });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.concepts[0]?.concept_uri).toBe('http://eurovoc.europa.eu/2830');
    expect(result.concepts[0]?.pref_label).toBe('data protection');
    expect(result.concepts[0]?.concept_code).toBe('2830');
    expect(result.concepts[0]?.broader_label).toBe('information');
    // Second concept: no broader label
    expect(result.concepts[1]?.broader_label).toBeUndefined();
  });

  it('passes keyword lowercased to SPARQL CONTAINS filter', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'Privacy' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'Privacy' });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"privacy"');
  });

  it('passes language filter to SPARQL', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'vie privée' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'vie', language: 'fr' });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"fr"');
  });

  it('accepts uppercase language codes and lowercases them for SPARQL (issue #46)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'vie privée' }),
    ]);

    // Uppercase passes schema validation (previously a -32602 at the schema gate)…
    const input = eurlex_browse_subjects.input.parse({ keyword: 'vie', language: 'FR' });
    await eurlex_browse_subjects.handler(input, ctx);

    // …and the SPARQL language tag is still the normalized lowercase form.
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('"fr"');
    expect(sparql).not.toContain('"FR"');
  });

  it('restricts results to the EuroVoc namespace so every URI is filter-compatible (issue #11)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2828', label: 'privacy', code: '2828' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'privacy' });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    // The query constrains ?concept to the EuroVoc namespace, so non-EuroVoc
    // authority concepts (class-sum-leg, fd_*) cannot be returned — every
    // concept_uri is usable in eurlex_search_documents.eurovoc_concept.
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('STRSTARTS(STR(?concept), "http://eurovoc.europa.eu/")');
    expect(result.concepts[0]?.concept_uri).toBe('http://eurovoc.europa.eu/2828');
  });

  it('respects limit parameter', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'agriculture' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'agri', limit: 5 });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LIMIT 6');
  });

  it('rejects pagination values outside the public boundary', () => {
    expect(() => eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 10_001 })).toThrow();
    expect(() => eurlex_browse_subjects.input.parse({ keyword: 'data', offset: -1 })).toThrow();
  });

  // --- Empty pages ---

  it('returns an empty first page with a broadening notice when query returns no bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'zznonexistentterm' });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result).toEqual({ concepts: [], total: 0, offset: 0, has_more: false });
    expect(getEnrichment(ctx).notice).toContain('"zznonexistentterm"');
  });

  it('returns an empty successful page when a non-zero offset is exhausted', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', offset: 200, limit: 20 });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result).toEqual({
      concepts: [],
      total: 0,
      offset: 200,
      has_more: false,
    });
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect((eurlex_browse_subjects.format!(result)[0] as { text: string }).text).toContain(
      '**Has more:** false',
    );
  });

  it('carries no notice on either surface for a page past the end (#112)', async () => {
    mockQuery.mockResolvedValue([]);

    const result = await runToolContract(eurlex_browse_subjects, {
      keyword: 'data',
      offset: 200,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      concepts: [],
      total: 0,
      offset: 200,
      has_more: false,
    });
    expect(contentText(result)).not.toMatch(/^> /m);
  });

  // --- #62: keyword escaping routes through the shared helper ---
  //
  // The former hand-rolled `keyword.replace(/"/g, '\\"')` was a quote-only pass
  // with no backslash pass. A keyword ending in `\` then escaped the closing
  // quote, the literal never terminated, and Virtuoso's raw SP030 compiler error
  // — carrying the internal query text and PREFIX block — reached the client in
  // place of this tool's own empty result. Asserting only on the returned page would
  // pass against the unescaped keyword too (a mocked query returns its fixture
  // whatever it is handed); the built query text is the discriminating part.

  it('escapes a trailing backslash in the keyword so the SPARQL literal terminates (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data\\' });
    await expect(eurlex_browse_subjects.handler(input, ctx)).resolves.toMatchObject({ total: 0 });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // The literal carries exactly what the shared helper produces.
    expect(sparql).toContain(`CONTAINS(LCASE(STR(?label)), "${escapeSparqlLiteral('data\\')}")`);
    // The unterminated form the quote-only pass produced is gone.
    expect(sparql).not.toContain(String.raw`"data\"))`);
  });

  it('escapes an embedded quote-and-backslash sequence in the keyword (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const keyword = 'data\\" x';
    const input = eurlex_browse_subjects.input.parse({ keyword });
    await expect(eurlex_browse_subjects.handler(input, ctx)).resolves.toMatchObject({ total: 0 });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Keyword is lowercased before escaping, so the helper sees the lowercased value.
    expect(sparql).toContain(
      `CONTAINS(LCASE(STR(?label)), "${escapeSparqlLiteral(keyword.toLowerCase())}")`,
    );
    // Every backslash and quote from the input is escaped, so the only unescaped
    // double quotes in the FILTER are the literal's own delimiters.
    expect(sparql).not.toContain(String.raw`"data\\" x"`);
  });

  // --- #72: proven continuation ---

  it('does not disclose continuation for an exactly-full final page', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'a' }),
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2', label: 'b' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 2 });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.concepts).toHaveLength(2);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns one-row continuation proof without exposing the sentinel row', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'a' }),
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2', label: 'b' }),
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/3', label: 'c' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 2 });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.concepts).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('LIMIT 3');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const text = (eurlex_browse_subjects.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Has more:** true');
    expect(text).toContain('**Next offset:** 2');
  });

  it('uses the service ceiling as the effective page size when it is lower than limit', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockMaxResults = 2;
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'a' }),
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2', label: 'b' }),
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/3', label: 'c' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 50 });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.concepts).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('LIMIT 3');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
  });

  it('does not disclose continuation when the page is short of the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'a' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 2 });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  // --- #51: offset pagination over distinct concepts ---

  it('applies a non-zero offset and limit and echoes the offset (issue #51)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'data' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', offset: 50, limit: 50 });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    // Offset is echoed to both channels so a paging caller knows which page it holds.
    expect(result.offset).toBe(50);
    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sparql).toContain('LIMIT 51');
    expect(sparql).toContain('OFFSET 50');
    // Deterministic order — the unique concept URI breaks label ties so OFFSET pages don't drift.
    expect(sparql).toContain('ORDER BY ?tier ?label ?concept LIMIT 51 OFFSET 50');
  });

  it('defaults offset to 0 for the first page (issue #51)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'data' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data' });
    const result = await eurlex_browse_subjects.handler(input, ctx);

    expect(result.offset).toBe(0);
    expect(mockQuery.mock.calls[0]?.[0] as string).toContain('OFFSET 0');
  });

  it('groups by concept so OFFSET paginates over distinct concepts, not skos:broader rows (issue #51)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'data' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data' });
    await eurlex_browse_subjects.handler(input, ctx);

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // EuroVoc is polyhierarchical and multi-notation: the OPTIONAL skos:broader and
    // skos:notation joins bind many rows per concept (e.g. "United States" has nine
    // parents), so an ungrouped LIMIT/OFFSET paginated over rows, not concepts. GROUP BY
    // collapses them to one row per concept — the same to-many-join fix eurlex_get_cases
    // applies via GROUP BY ?celexNumber. ?label is grouped (not sampled) so ORDER BY sorts
    // the real label string.
    expect(sparql).toContain('GROUP BY ?concept ?label');
    expect(sparql).toContain('SAMPLE(?codeValue)');
    expect(sparql).toContain('SAMPLE(?broaderLabelValue)');
  });

  // --- Format ---

  it('format renders concept URI, label, code, broader label, and offset', () => {
    const output = {
      concepts: [
        {
          concept_uri: 'http://eurovoc.europa.eu/2830',
          pref_label: 'data protection',
          concept_code: '2830',
          broader_label: 'information',
        },
      ],
      total: 1,
      offset: 40,
      has_more: false,
    };
    const blocks = eurlex_browse_subjects.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('http://eurovoc.europa.eu/2830');
    expect(text).toContain('data protection');
    expect(text).toContain('2830');
    expect(text).toContain('information');
    // Offset reaches content[] so paginating clients see which page this is (#51).
    expect(text).toContain('offset 40');
    expect(text).toContain('**Has more:** false');
  });

  // --- #70: alternative (non-preferred) EuroVoc labels ---

  describe('alternative label matching (#70)', () => {
    it('queries skos:altLabel under the same keyword and language filters', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/3635', label: "producer's liability" }),
      ]);

      const input = eurlex_browse_subjects.input.parse({ keyword: 'Product Liability' });
      await eurlex_browse_subjects.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sparql).toContain('?concept skos:altLabel ?altValue .');
      expect(sparql).toContain('FILTER(LANG(?altValue) = "en")');
      expect(sparql).toContain('FILTER(CONTAINS(LCASE(STR(?altValue)), "product liability"))');
      // The preferred-label filter is widened rather than replaced, so a concept
      // reached by either path qualifies.
      expect(sparql).toContain(
        'FILTER(CONTAINS(LCASE(STR(?label)), "product liability") || BOUND(?altValue))',
      );
      expect(sparql).toContain('AS ?matchedKey)');
      // Grouping keys on the preferred label, never the matched one.
      expect(sparql).toContain('GROUP BY ?concept ?label ORDER BY ?tier ?label ?concept');
    });

    it('escapes the keyword in the alternative-label filter too', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'x' }),
      ]);

      const keyword = 'a"b\\c';
      const input = eurlex_browse_subjects.input.parse({ keyword });
      await eurlex_browse_subjects.handler(input, ctx);

      const sparql = mockQuery.mock.calls[0]?.[0] as string;
      const escaped = escapeSparqlLiteral(keyword.toLowerCase());
      expect(sparql).toContain(`FILTER(CONTAINS(LCASE(STR(?altValue)), "${escaped}"))`);
    });

    it('surfaces a concept reached only through an alternative label', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([
        makeConceptBinding({
          uri: 'http://eurovoc.europa.eu/3635',
          label: "producer's liability",
          code: '3635',
          matchedLabel: 'product liability',
        }),
      ]);

      const input = eurlex_browse_subjects.input.parse({ keyword: 'product liability' });
      const result = await eurlex_browse_subjects.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.concepts[0]?.concept_uri).toBe('http://eurovoc.europa.eu/3635');
      // The row stays keyed by the preferred label; the alternative says why it hit.
      expect(result.concepts[0]?.pref_label).toBe("producer's liability");
      expect(result.concepts[0]?.matched_label).toBe('product liability');
    });

    it('returns one row for a concept matching both label paths', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      // Grouping is unchanged, so CELLAR collapses both paths into a single row
      // whose matched label is bound alongside the preferred one.
      mockQuery.mockResolvedValue([
        makeConceptBinding({
          uri: 'http://eurovoc.europa.eu/3497',
          label: 'liability',
          matchedLabel: 'collective liability',
        }),
      ]);

      const input = eurlex_browse_subjects.input.parse({ keyword: 'liability' });
      const result = await eurlex_browse_subjects.handler(input, ctx);

      expect(result.concepts).toHaveLength(1);
      expect(result.concepts[0]?.pref_label).toBe('liability');
      expect(result.concepts[0]?.matched_label).toBe('collective liability');
    });

    it('omits matched_label for a preferred-label-only hit', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/3497', label: 'liability' }),
      ]);

      const input = eurlex_browse_subjects.input.parse({ keyword: 'liability' });
      const result = await eurlex_browse_subjects.handler(input, ctx);

      expect(result.concepts[0]).not.toHaveProperty('matched_label');
    });

    it('returns an empty page with a broadening notice when neither label path matches', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([]);

      const input = eurlex_browse_subjects.input.parse({ keyword: 'zzzznotathing' });
      const result = await eurlex_browse_subjects.handler(input, ctx);

      expect(result.concepts).toEqual([]);
      expect(getEnrichment(ctx).notice).toContain('broader');
    });

    it('leaves the continuation sentinel and OFFSET paging untouched', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      // limit 2 requests 3 rows; the third is the private sentinel proving more exist.
      mockQuery.mockResolvedValue([
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'liability a' }),
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2', label: 'liability b' }),
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/3', label: 'liability c' }),
      ]);

      const input = eurlex_browse_subjects.input.parse({
        keyword: 'liability',
        limit: 2,
        offset: 4,
      });
      const result = await eurlex_browse_subjects.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[0] as string).toContain('LIMIT 3 OFFSET 4');
      expect(result.total).toBe(2);
      expect(result.has_more).toBe(true);
      expect(result.next_offset).toBe(6);
      expect(result.concepts.map((c) => c.concept_uri)).toEqual([
        'http://eurovoc.europa.eu/1',
        'http://eurovoc.europa.eu/2',
      ]);
    });

    it('renders matched_label in format() and omits the line when absent', () => {
      const withAlt = eurlex_browse_subjects.format!({
        concepts: [
          {
            concept_uri: 'http://eurovoc.europa.eu/3635',
            pref_label: "producer's liability",
            concept_code: '3635',
            matched_label: 'product liability',
          },
        ],
        total: 1,
        offset: 0,
        has_more: false,
      });
      const withAltText = (withAlt[0] as { text: string }).text;
      expect(withAltText).toContain("### producer's liability");
      expect(withAltText).toContain('**Matched via:** product liability');

      const withoutAlt = eurlex_browse_subjects.format!({
        concepts: [{ concept_uri: 'http://eurovoc.europa.eu/3497', pref_label: 'liability' }],
        total: 1,
        offset: 0,
        has_more: false,
      });
      expect((withoutAlt[0] as { text: string }).text).not.toContain('**Matched via:**');
    });
  });

  // --- #113: tiered ranking, computed in CELLAR ahead of LIMIT/OFFSET ---

  describe('tiered ranking (#113)', () => {
    it('ranks by tier inside the SPARQL ORDER BY, ahead of LIMIT and OFFSET', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([]);

      await eurlex_browse_subjects.handler(
        eurlex_browse_subjects.input.parse({ keyword: 'AI', limit: 5, offset: 10 }),
        ctx,
      );

      const sparql = sentQuery();
      expect(sparql).toMatch(/\(MIN\(IF\([\s\S]+\) AS \?tier\)/);
      expect(sparql).toMatch(/ORDER BY \?tier \?label \?concept LIMIT 6 OFFSET 10$/);
    });

    it('builds the tiers from plain string functions over both labels, with no REGEX', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([]);

      await eurlex_browse_subjects.handler(
        eurlex_browse_subjects.input.parse({ keyword: 'Data Protection' }),
        ctx,
      );

      const sparql = sentQuery();
      // Tier 1: an exact preferred or alternative label.
      expect(sparql).toContain('LCASE(STR(?label)) = "data protection"');
      expect(sparql).toContain('(BOUND(?altValue) && LCASE(STR(?altValue)) = "data protection")');
      // Tier 2: the label, or a word in it, starts with the keyword.
      expect(sparql).toContain(
        'STRSTARTS(LCASE(STR(?label)), "data protection") || CONTAINS(LCASE(STR(?label)), " data protection")',
      );
      expect(sparql).toContain(
        '(BOUND(?altValue) && (STRSTARTS(LCASE(STR(?altValue)), "data protection") || CONTAINS(LCASE(STR(?altValue)), " data protection")))',
      );
      expect(sparql).not.toMatch(/REGEX/i);
    });

    it('maps an exact label to tier 1, a label or word start to tier 2, and any other match to tier 3', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([]);

      await eurlex_browse_subjects.handler(
        eurlex_browse_subjects.input.parse({ keyword: 'ai' }),
        ctx,
      );

      const exact =
        'LCASE(STR(?label)) = "ai" || (BOUND(?altValue) && LCASE(STR(?altValue)) = "ai")';
      const wordStart =
        'STRSTARTS(LCASE(STR(?label)), "ai") || CONTAINS(LCASE(STR(?label)), " ai") || (BOUND(?altValue) && (STRSTARTS(LCASE(STR(?altValue)), "ai") || CONTAINS(LCASE(STR(?altValue)), " ai")))';
      expect(sentQuery()).toContain(
        `(MIN(IF(${exact}, 1,\n       IF(${wordStart}, 2, 3))) AS ?tier)`,
      );
    });

    it('escapes the keyword in every tier comparison', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([]);
      const keyword = 'a"b\\c';

      await eurlex_browse_subjects.handler(eurlex_browse_subjects.input.parse({ keyword }), ctx);

      const escaped = escapeSparqlLiteral(keyword.toLowerCase());
      const sparql = sentQuery();
      expect(sparql).toContain(`= "${escaped}"`);
      expect(sparql).toContain(`STRSTARTS(LCASE(STR(?label)), "${escaped}")`);
      expect(sparql).toContain(`CONTAINS(LCASE(STR(?altValue)), " ${escaped}")`);
      expect(sparql).not.toContain('a"b');
    });

    it('selects matched_label as the best-tier alternative, alphabetical among equals', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([]);

      await eurlex_browse_subjects.handler(
        eurlex_browse_subjects.input.parse({ keyword: 'ai' }),
        ctx,
      );

      // MIN over the tier digit + label: "2airship" sorts ahead of "3hot-air balloon".
      expect(sentQuery()).toContain(
        '(MIN(IF(BOUND(?altValue),\n       CONCAT(IF(LCASE(STR(?altValue)) = "ai", "1", IF(STRSTARTS(LCASE(STR(?altValue)), "ai") || CONTAINS(LCASE(STR(?altValue)), " ai"), "2", "3")), STR(?altValue)),\n       "")) AS ?matchedKey)',
      );
      expect(sentQuery()).not.toContain('SAMPLE(?altValue)');
    });

    it('keeps CELLAR row order and reports the matched alternative without its tier digit', async () => {
      const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
      mockQuery.mockResolvedValue([
        makeConceptBinding({
          uri: 'http://eurovoc.europa.eu/3030',
          label: 'artificial intelligence',
          matchedLabel: 'AI',
          matchedTier: 1,
          tier: 1,
        }),
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/5172', label: 'AIDS', tier: 2 }),
        makeConceptBinding({
          uri: 'http://eurovoc.europa.eu/c_ea3f5ed2',
          label: 'aerostat',
          matchedLabel: 'airship',
          matchedTier: 2,
          tier: 2,
        }),
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1094', label: 'ALADI', tier: 3 }),
      ]);

      const result = await eurlex_browse_subjects.handler(
        eurlex_browse_subjects.input.parse({ keyword: 'ai' }),
        ctx,
      );

      // No in-memory re-sort: the page arrives ranked and stays that way.
      expect(result.concepts.map((c) => c.concept_uri)).toEqual([
        'http://eurovoc.europa.eu/3030',
        'http://eurovoc.europa.eu/5172',
        'http://eurovoc.europa.eu/c_ea3f5ed2',
        'http://eurovoc.europa.eu/1094',
      ]);
      expect(result.concepts[0]?.matched_label).toBe('AI');
      expect(result.concepts[2]?.matched_label).toBe('airship');
      expect(result.concepts[1]).not.toHaveProperty('matched_label');
      // The output shape is unchanged: no tier or score field.
      for (const concept of result.concepts) expect(concept).not.toHaveProperty('tier');
    });

    it('describes the ranking instead of an alphabetical order', () => {
      expect(eurlex_browse_subjects.description).not.toContain('alphabetically');
      expect(eurlex_browse_subjects.description).toContain('exact');
      expect(eurlex_browse_subjects.output.shape.concepts.description).not.toContain(
        'alphabetically',
      );
    });
  });

  // --- #112: an empty first page is an empty page, not an error ---

  describe('empty first page (#112)', () => {
    it('returns an empty page with a notice on both surfaces', async () => {
      mockQuery.mockResolvedValue([]);

      const result = await runToolContract(eurlex_browse_subjects, {
        keyword: 'zzqxunmatchablephrase',
        language: 'FR',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ concepts: [], total: 0, offset: 0, has_more: false });
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('truncated');
      const notice = structured.notice as string;
      expect(notice).toContain('"zzqxunmatchablephrase"');
      expect(notice).toContain('"fr"');
      expect(notice).toContain(
        'Try a broader or simpler term, or retry with language "en" for wider coverage.',
      );

      const text = contentText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**Has more:** false');
      expect(text).not.toContain('**Next offset:**');
    });

    it('names the next offset in the notice of a page with more rows', async () => {
      mockQuery.mockResolvedValue([
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'data a' }),
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2', label: 'data b' }),
        makeConceptBinding({ uri: 'http://eurovoc.europa.eu/3', label: 'data c' }),
      ]);

      const result = await runToolContract(eurlex_browse_subjects, { keyword: 'data', limit: 2 });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ has_more: true, next_offset: 2, truncated: true });
      expect(structured.notice).toContain('offset=2');
      expect(contentText(result)).toContain(`> ${structured.notice as string}`);
    });

    it.each(['en', 'EN'])(
      'suggests no English retry for a search already in English (language %j)',
      async (language) => {
        mockQuery.mockResolvedValue([]);

        const result = await runToolContract(eurlex_browse_subjects, {
          keyword: 'zzqxunmatchablephrase',
          language,
        });

        const notice = (result.structuredContent as { notice?: string }).notice ?? '';
        expect(notice).toContain('in language "en"');
        expect(notice).toContain('Try a broader or simpler term.');
        expect(notice).not.toContain('retry with language');
        expect(contentText(result)).toContain(`> ${notice}`);
      },
    );

    it('bounds the keyword echoed in the notice', async () => {
      mockQuery.mockResolvedValue([]);
      const keyword = `zz${'q'.repeat(4998)}`;

      const result = await runToolContract(eurlex_browse_subjects, { keyword });

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain(`"${keyword.slice(0, 100)}…"`);
      expect(notice).not.toContain(keyword.slice(0, 101));
      expect(notice.length).toBeLessThan(300);
      expect(contentText(result)).toContain(`> ${notice}`);
    });
  });

  describe('CELLAR sort window (#154)', () => {
    /** CELLAR over `total` concepts ranked by the query: refuses a page past row 10,000. */
    function windowedConcepts(total: number) {
      return async (q: string) => {
        assertInSortWindow(q);
        const [clause] = pagingClauses(q);
        const { start, end } = pageSpan(clause ?? { limit: 0, offset: 0 }, total);
        return Array.from({ length: end - start }, (_, i) =>
          makeConceptBinding({
            uri: `http://eurovoc.europa.eu/${start + i}`,
            label: `law ${start + i}`,
          }),
        );
      };
    }

    it('keeps the sentinel while the page and its sentinel fit (offset 9,949)', async () => {
      mockQuery.mockImplementation(windowedConcepts(14_567));

      const result = await runToolContract(eurlex_browse_subjects, {
        keyword: 'law',
        limit: 50,
        offset: 9_949,
      });

      expect(sentQuery()).toContain('LIMIT 51 OFFSET 9949');
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ total: 50, has_more: true, next_offset: 9_999 });
      expect(structured.notice).toContain('offset=9999');
    });

    it.each([
      [9_950, 50, 50],
      [9_999, 1, 1],
    ])(
      'serves the rows left in the window at offset %i (LIMIT %i) and promises no page past it',
      async (offset, limit, served) => {
        mockQuery.mockImplementation(windowedConcepts(14_567));

        const result = await runToolContract(eurlex_browse_subjects, {
          keyword: 'law',
          limit: 50,
          offset,
        });

        expect(result.isError).toBeFalsy();
        expect(sentQuery()).toContain(`LIMIT ${limit} OFFSET ${offset}`);
        const structured = result.structuredContent as Record<string, unknown>;
        expect(structured).toMatchObject({ total: served, offset, has_more: false });
        expect(structured).not.toHaveProperty('next_offset');
        expect(structured).not.toHaveProperty('truncated');
        const notice = structured.notice as string;
        expect(notice).toContain('row 10,000');
        expect(notice).toContain('more specific keyword');
        expect(notice).not.toContain('offset=');
        const text = contentText(result);
        expect(text).toContain(`> ${notice}`);
        expect(text).not.toContain('**Next offset:**');
      },
    );

    it('reads a short page inside the cut window as the end of the matches', async () => {
      mockQuery.mockImplementation(windowedConcepts(9_960));

      const result = await runToolContract(eurlex_browse_subjects, {
        keyword: 'law',
        limit: 50,
        offset: 9_950,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ total: 10, has_more: false });
      expect(structured).not.toHaveProperty('notice');
    });

    it('rejects an offset at or past row 10,000 with a typed error and no query', async () => {
      mockQuery.mockImplementation(windowedConcepts(14_567));
      const declared = eurlex_browse_subjects.errors?.find(
        (e) => e.reason === 'offset_past_window',
      );

      const result = await runToolContract(eurlex_browse_subjects, {
        keyword: 'law',
        limit: 50,
        offset: 10_000,
      });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error?: { code?: number; data?: { reason?: string; recovery?: { hint?: string } } };
        }
      ).error;
      expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error?.data?.reason).toBe('offset_past_window');
      expect(error?.data?.recovery?.hint).toBe(declared?.recovery);
      expect(declared?.recovery).toContain('keyword');
      expect(contentText(result)).toContain('10,000');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('states the bound in the offset description', () => {
      const offset = eurlex_browse_subjects.input.shape.offset;
      expect(offset.description).toContain('10,000');
      // A schema maximum would reject the call as invalid_arguments, skipping the recovery.
      expect(eurlex_browse_subjects.input.parse({ keyword: 'law', offset: 10_000 }).offset).toBe(
        10_000,
      );
    });

    it('discloses both the clamp and the window when they meet (offset 9,975, limit 80)', async () => {
      mockQuery.mockImplementation(windowedConcepts(14_567));

      const result = await runToolContract(eurlex_browse_subjects, {
        keyword: 'law',
        limit: 80,
        offset: 9_975,
      });

      expect(sentQuery()).toContain('LIMIT 25 OFFSET 9975');
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        total: 25,
        has_more: false,
        limit_clamp: { requested: 80, applied: 50 },
      });
      const notice = structured.notice as string;
      expect(notice).toContain('row 10,000');
      const text = contentText(result);
      expect(text).toContain('**Limit clamped:** 80 → 50 (per-call maximum)');
      expect(text).toContain(`> ${notice}`);
    });
  });

  describe('over-maximum limit (#151)', () => {
    /** `n` concepts, labelled in rank order. */
    const concepts = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        makeConceptBinding({ uri: `http://eurovoc.europa.eu/${i}`, label: `law ${i}` }),
      );

    it('serves limit 51 at the 50-concept maximum and reports the clamp on both surfaces', async () => {
      mockQuery.mockResolvedValue(concepts(51));

      const result = await runToolContract(eurlex_browse_subjects, { keyword: 'law', limit: 51 });

      expect(sentQuery()).toContain('LIMIT 51 OFFSET 0');
      expect(result.structuredContent).toMatchObject({
        total: 50,
        has_more: true,
        next_offset: 50,
        cap: 50,
        limit_clamp: { requested: 51, applied: 50 },
      });
      expect(contentText(result)).toContain('**Limit clamped:** 51 → 50 (per-call maximum)');
    });

    it('reports the operator ceiling as the applied value on a short page', async () => {
      mockMaxResults = 30;
      mockQuery.mockResolvedValue(concepts(4));

      const result = await runToolContract(eurlex_browse_subjects, { keyword: 'law', limit: 40 });

      expect(sentQuery()).toContain('LIMIT 31 OFFSET 0');
      expect(result.structuredContent).toMatchObject({
        total: 4,
        has_more: false,
        limit_clamp: { requested: 40, applied: 30 },
      });
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('**Limit clamped:** 40 → 30 (per-call maximum)');
    });

    it('adds no clamp within the maximum, and rejects limit 0 and 10,001', async () => {
      mockQuery.mockResolvedValue(concepts(51));

      const result = await runToolContract(eurlex_browse_subjects, { keyword: 'law', limit: 50 });

      expect(result.structuredContent).toMatchObject({ total: 50, cap: 50 });
      expect(result.structuredContent).not.toHaveProperty('limit_clamp');
      expect(contentText(result)).not.toContain('Limit clamped');
      expect(() => eurlex_browse_subjects.input.parse({ keyword: 'law', limit: 0 })).toThrow();
      expect(() => eurlex_browse_subjects.input.parse({ keyword: 'law', limit: 10_001 })).toThrow();
      expect(eurlex_browse_subjects.input.parse({ keyword: 'law', limit: 10_000 }).limit).toBe(
        10_000,
      );
    });
  });

  // --- content[] reads back as structuredContent carries it (add-tool 2.35) ---

  describe('Markdown round-trip of content[]', () => {
    type Concept = {
      concept_uri: string;
      pref_label: string;
      concept_code?: string;
      broader_label?: string;
      matched_label?: string;
    };

    /** The content[] text format() renders for a one-concept page. */
    const formatConcept = (concept: Concept) =>
      (
        eurlex_browse_subjects.format!({
          concepts: [concept],
          total: 1,
          offset: 0,
          has_more: false,
        })[0] as { text: string }
      ).text;

    /** The CommonMark read of that page when every value reads back as written. */
    const readBack = (concept: Concept) =>
      [
        '⟨heading_open⟩',
        'EuroVoc Concepts (1 found, offset 0)',
        '⟨heading_close⟩',
        '⟨strong⟩Has more:⟨/strong⟩ false',
        '⟨heading_open⟩',
        concept.pref_label,
        '⟨heading_close⟩',
        [
          `⟨strong⟩URI:⟨/strong⟩ ${concept.concept_uri}`,
          ...(concept.concept_code ? [`⟨strong⟩Code:⟨/strong⟩ ${concept.concept_code}`] : []),
          ...(concept.broader_label ? [`⟨strong⟩Broader:⟨/strong⟩ ${concept.broader_label}`] : []),
          ...(concept.matched_label
            ? [`⟨strong⟩Matched via:⟨/strong⟩ ${concept.matched_label}`]
            : []),
        ].join('\n'),
      ].join('\n\n');

    it('reads hostile EuroVoc labels back exactly in the heading and every field line', () => {
      const concept = {
        concept_uri: 'http://eurovoc.europa.eu/c_1*<b>',
        pref_label: '*privacy* & <b>data</b> [EU](x) | `c` ~s~ #',
        concept_code: '_2830_',
        broader_label: '# information\n- technology',
        matched_label: '1. product \\ liability',
      };
      expect(readCommonMark(formatConcept(concept))).toBe(readBack(concept));
    });

    it('keeps a multi-line label inside its heading and a plain URI byte for byte', () => {
      const concept = {
        concept_uri: 'http://eurovoc.europa.eu/2830',
        pref_label: 'data\n- protection',
      };
      const text = formatConcept(concept);
      expect(readCommonMark(text)).toBe(readBack(concept));
      expect(text).toContain('**URI:** http://eurovoc.europa.eu/2830');
    });

    it('reads 2,000 random concepts over a hostile alphabet back exactly', () => {
      /** mulberry32: a seeded generator, so a failure replays from its seed. */
      let seed = 0x5eed_0113;
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
      };
      /** Single characters plus the multi-character openers that form syntax only together. */
      const pieces = [
        ...'aZ9é_*`\\[]()|<>!#&;~-+=.:@"\' \t\n^{}/?%',
        '&amp;',
        '<b>',
        '](',
        '```',
        '- ',
        '1. ',
        '# ',
        ' #',
        '##',
        '***',
        '__',
        '<a@b.io>',
        '<http://x>',
        '---',
        '===',
        '    ',
        '> ',
      ];
      // A field line holds a non-empty value; a heading may hold an empty label.
      const text = (max: number, min = 1) =>
        Array.from(
          { length: min + Math.floor(random() * (max - min + 1)) },
          () => pieces[Math.floor(random() * pieces.length)],
        ).join('');

      let firstMismatch: Record<string, unknown> | undefined;
      for (let i = 0; i < 2_000 && !firstMismatch; i++) {
        const concept = {
          concept_uri: text(6),
          pref_label: text(10, 0),
          concept_code: text(5),
          broader_label: text(8),
          matched_label: text(8),
        };
        const markdown = formatConcept(concept);
        const expected = readBack(concept);
        const read = readCommonMark(markdown);
        if (read !== expected) firstMismatch = { i, concept, markdown, read, expected };
      }
      expect(firstMismatch).toBeUndefined();
    });

    it('reads the empty-page notice back as structuredContent carries it', async () => {
      mockQuery.mockResolvedValue([]);
      const keyword = '*privacy* [x](y) <b>z</b>\n- item';

      const result = await runToolContract(eurlex_browse_subjects, { keyword });

      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain(`"${keyword}"`);
      expect(readCommonMark(contentText(result))).toBe(
        [
          '⟨heading_open⟩',
          'EuroVoc Concepts (0 found, offset 0)',
          '⟨heading_close⟩',
          '⟨strong⟩Has more:⟨/strong⟩ false',
          '⟨blockquote_open⟩',
          notice,
          '⟨blockquote_close⟩',
        ].join('\n\n'),
      );
    });
  });
});

// --- CELLAR failures carry this tool's own recovery ---

describe('eurlex_browse_subjects CELLAR failures', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it.each([
    [
      'sparql_error',
      JsonRpcErrorCode.ValidationError,
      () =>
        validationError('CELLAR SPARQL error: Virtuoso 37000 Error SQ156: compiler error', {
          reason: 'sparql_error',
          retryable: false,
        }),
    ],
    [
      'sparql_timeout',
      JsonRpcErrorCode.ServiceUnavailable,
      () =>
        serviceUnavailable('CELLAR SPARQL query timed out on Virtuoso', {
          reason: 'sparql_timeout',
          retryable: false,
        }),
    ],
  ])('fails %s with recovery naming keyword', async (reason, code, failure) => {
    mockQuery.mockRejectedValue(failure());

    const result = await runToolContract(eurlex_browse_subjects, { keyword: 'privacy' });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; recovery?: { hint?: string } } };
      }
    ).error;
    expect(error.code).toBe(code);
    expect(error.data.reason).toBe(reason);
    const hint = error.data.recovery?.hint ?? '';
    expect(hint).toContain('keyword');
    expect(hint).toBe(eurlex_browse_subjects.errors?.find((e) => e.reason === reason)?.recovery);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain(hint);
  });
});
