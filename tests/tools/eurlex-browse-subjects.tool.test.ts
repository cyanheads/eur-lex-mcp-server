/**
 * @fileoverview Tests for eurlex_browse_subjects tool.
 * @module tests/tools/eurlex-browse-subjects.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_browse_subjects } from '@/mcp-server/tools/definitions/eurlex-browse-subjects.tool.js';
import { escapeSparqlLiteral } from '@/services/cellar-sparql/eli-resolution.js';

// --- Service mock ---
const mockQuery = vi.fn();
vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockQuery }),
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
}): Record<string, { type: string; value: string }> {
  const b: Record<string, { type: string; value: string }> = {
    concept: { type: 'uri', value: opts.uri },
    label: { type: 'literal', value: opts.label },
  };
  if (opts.code) b.code = { type: 'literal', value: opts.code };
  if (opts.broaderLabel) b.broaderLabel = { type: 'literal', value: opts.broaderLabel };
  return b;
}

describe('eurlex_browse_subjects', () => {
  beforeEach(() => mockQuery.mockReset());

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
    expect(sparql).toContain('LIMIT 5');
  });

  // --- Error contract: no_concepts ---

  it('throws ctx.fail("no_concepts") when query returns no bindings', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'zznonexistentterm' });
    await expect(eurlex_browse_subjects.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_concepts' },
    });
  });

  // --- #62: keyword escaping routes through the shared helper ---
  //
  // The former hand-rolled `keyword.replace(/"/g, '\\"')` was a quote-only pass
  // with no backslash pass. A keyword ending in `\` then escaped the closing
  // quote, the literal never terminated, and Virtuoso's raw SP030 compiler error
  // — carrying the internal query text and PREFIX block — reached the client in
  // place of this tool's own no_concepts. Asserting only on the thrown error would
  // pass against the unescaped keyword too (a mocked query returns its fixture
  // whatever it is handed); the built query text is the discriminating part.

  it('escapes a trailing backslash in the keyword so the SPARQL literal terminates (#62)', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data\\' });
    await expect(eurlex_browse_subjects.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_concepts' },
    });

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
    await expect(eurlex_browse_subjects.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_concepts' },
    });

    const sparql = mockQuery.mock.calls[0]?.[0] as string;
    // Keyword is lowercased before escaping, so the helper sees the lowercased value.
    expect(sparql).toContain(
      `CONTAINS(LCASE(STR(?label)), "${escapeSparqlLiteral(keyword.toLowerCase())}")`,
    );
    // Every backslash and quote from the input is escaped, so the only unescaped
    // double quotes in the FILTER are the literal's own delimiters.
    expect(sparql).not.toContain(String.raw`"data\\" x"`);
  });

  // --- #28: truncation disclosure ---

  it('discloses truncation when the returned page fills the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'a' }),
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/2', label: 'b' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 2 });
    await eurlex_browse_subjects.handler(input, ctx);

    const enriched = getEnrichment(ctx);
    expect(enriched.truncated).toBe(true);
    expect(enriched.shown).toBe(2);
    expect(enriched.cap).toBe(2);
  });

  it('does not disclose truncation when the page is short of the limit', async () => {
    const ctx = createMockContext({ errors: eurlex_browse_subjects.errors });
    mockQuery.mockResolvedValue([
      makeConceptBinding({ uri: 'http://eurovoc.europa.eu/1', label: 'a' }),
    ]);

    const input = eurlex_browse_subjects.input.parse({ keyword: 'data', limit: 2 });
    await eurlex_browse_subjects.handler(input, ctx);

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
    expect(sparql).toContain('LIMIT 50');
    expect(sparql).toContain('OFFSET 50');
    // Deterministic order — the unique concept URI breaks label ties so OFFSET pages don't drift.
    expect(sparql).toContain('ORDER BY ?label ?concept');
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
  });
});
