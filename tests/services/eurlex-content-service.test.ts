/**
 * @fileoverview Tests for EurLexContentService — CELLAR content negotiation,
 * ISO 639-2/T language mapping, HTML→Formex variant fallback, English fallback,
 * AWS WAF bot-challenge detection (issue #16), multi-part Formex 4 assembly
 * (issue #18), and the body cache (#127, #129). `fetch` is stubbed; no test
 * touches the live network. The
 * challenge case reads the committed stub fixture; the multi-part fixtures mirror
 * the real CELLAR 300 index and Formex part shapes.
 * @module tests/services/eurlex-content-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { parseActStructure } from '@/services/eurlex-content/act-structure.js';
import {
  type ContentFormat,
  EurLexContentService,
} from '@/services/eurlex-content/eurlex-content-service.js';
import { htmlToMarkdown } from '@/services/eurlex-content/html-to-markdown.js';
import { AWS_WAF_CHALLENGE_HTML } from '../fixtures/aws-waf-challenge.js';
import { ACT_XHTML } from '../fixtures/eurlex-act-html.js';
import { AMENDING_HTML } from '../fixtures/eurlex-amending-act.js';
import {
  FORMEX_DOC_1,
  FORMEX_DOC_2,
  FORMEX_MULTIPART_INDEX_300,
  FORMEX_PART_URL_DOC_1,
  FORMEX_PART_URL_DOC_2,
  FORMEX_SINGLE_PART_ACT,
} from '../fixtures/eurlex-formex-multipart.js';
import {
  actByActPackage,
  buildZip,
  LEGACY_PACKAGE_MANIFEST,
  PACKAGE_ACT,
  PACKAGE_ANNEX,
  PACKAGE_MANIFEST,
  PACKAGE_TOC,
  type ZipFixtureEntry,
} from '../fixtures/formex-zip.js';

/** A representative (non-stub) xhtml act body — well over the empty-body floor. */
const GDPR_XHTML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
  '<p>REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</p>' +
  '<p>on the protection of natural persons with regard to the processing of personal data</p>' +
  '<p>Article 1 — Subject-matter and objectives</p></body></html>';

function makeService(): EurLexContentService {
  const serverConfig = {
    cellarSparqlEndpoint: 'http://publications.europa.eu/webapi/rdf/sparql',
    eurLexContentBaseUrl: 'http://publications.europa.eu',
    sparqlQueryTimeoutMs: 5_000,
    maxSparqlResults: 100,
  } satisfies ServerConfig;
  return new EurLexContentService({} as AppConfig, {} as StorageService, serverConfig);
}

/** Read the `Accept` / `Accept-Language` headers off a recorded fetch call. */
function headersOf(call: unknown[] | undefined): Record<string, string> {
  return (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

/**
 * A mock `fetch` for the multi-part path: the CELEX URL yields the given 300
 * index, each part URL matched by a key substring yields that factory's response,
 * and any other URL 404s. Factories build a fresh `Response` per call so bodies
 * are never read twice.
 */
function routeMultipart(
  parts: Record<string, () => Response>,
  index: string = FORMEX_MULTIPART_INDEX_300,
): (url: string) => Promise<Response> {
  return (url: string) => {
    if (url.includes('/resource/celex/')) {
      return Promise.resolve(new Response(index, { status: 300 }));
    }
    for (const [marker, make] of Object.entries(parts)) {
      if (url.includes(marker)) return Promise.resolve(make());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

describe('EurLexContentService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches HTML via CELLAR content negotiation (xhtml + 3-letter language)', async () => {
    mockFetch.mockResolvedValue(new Response(GDPR_XHTML, { status: 200 }));

    const result = await makeService().fetchContent(
      '32016R0679',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.content).toContain('personal data');
    expect(result.language).toBe('EN');
    expect(result.format).toBe('html');

    // The request targets the CELLAR resolver, not the WAF-protected legal-content endpoint.
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'http://publications.europa.eu/resource/celex/32016R0679',
    );
    expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xhtml+xml');
    expect(headersOf(mockFetch.mock.calls[0])['Accept-Language']).toBe('eng');
  });

  it('maps the EUR-Lex 2-letter code to its ISO 639-2/T form (DE → deu)', async () => {
    mockFetch.mockResolvedValue(new Response(GDPR_XHTML, { status: 200 }));

    await makeService().fetchContent('32016R0679', 'DE', 'html', createMockContext());

    expect(headersOf(mockFetch.mock.calls[0])['Accept-Language']).toBe('deu');
  });

  it('falls back from xhtml to text/html when no xhtml manifestation exists (court cases)', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers.Accept === 'application/xhtml+xml'
          ? new Response('not found', { status: 404 })
          : new Response(`<HTML>${'j'.repeat(300)} JUDGMENT OF THE COURT</HTML>`, { status: 200 }),
      ),
    );

    const result = await makeService().fetchContent(
      '62024CJ0629',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.content).toContain('JUDGMENT OF THE COURT');
    expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xhtml+xml');
    expect(headersOf(mockFetch.mock.calls[1]).Accept).toBe('text/html');
  });

  it('falls back to English when the requested language has no content', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers['Accept-Language'] === 'fra'
          ? new Response('not found', { status: 404 })
          : new Response(GDPR_XHTML, { status: 200 }),
      ),
    );

    const result = await makeService().fetchContent(
      '32016R0679',
      'FR',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.language).toBe('EN');
    expect(result.languageFallback).toContain('FR');
  });

  it('reports content unavailable (not an error) when no manifestation exists in any language', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('Resource not found.', { status: 404 })),
    );

    const result = await makeService().fetchContent(
      '39999R9999',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(false);
    expect(result.content).toBe('');
    expect(result.unavailabilityReason).toBe('no_representation');
  });

  it('classifies a non-404 upstream response as an upstream failure', async () => {
    mockFetch.mockResolvedValue(new Response('service unavailable', { status: 503 }));

    const result = await makeService().fetchContent(
      '32016R0679',
      'EN',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(false);
    expect(result.unavailabilityReason).toBe('upstream_failure');
  });

  it('rethrows a fetch failure after the request is cancelled instead of degrading it', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new TypeError('fetch failed'));
    });

    await expect(
      makeService().fetchContent(
        '32016R0679',
        'EN',
        'html',
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retains an upstream failure across the requested-language and English fallback attempts', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers['Accept-Language'] === 'fra'
          ? new Response('not found', { status: 404 })
          : new Response('service unavailable', { status: 503 }),
      ),
    );

    const result = await makeService().fetchContent(
      '32016R0679',
      'FR',
      'html',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(false);
    expect(result.unavailabilityReason).toBe('upstream_failure');
  });

  // --- Multi-part Formex 4 assembly for the xml format (issue #18) ---

  describe('multi-part Formex 4 assembly (xml, issue #18)', () => {
    it('follows a 300 index and assembles the sibling parts into the full act', async () => {
      mockFetch.mockImplementation(
        routeMultipart({
          '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
          '/DOC_2': () => new Response(FORMEX_DOC_2, { status: 200 }),
        }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(true);
      expect(result.format).toBe('xml');
      // The Formex variant was negotiated on the initial (CELEX) request.
      expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xml;type=fmx4');

      // The assembled body carries BOTH the DOC_1 notice header and the DOC_2 act
      // body — not just the <BIB.DOC> shell the single fetch used to return.
      const content = result.content;
      expect(content).toContain('<BIB.DOC>');
      expect(content).toContain('<ENACTING.TERMS>');
      expect(content).toContain('<ARTICLE IDENTIFIER="001">');
      expect(content).toContain('Subject-matter and objectives');

      // Wrapped as one well-formed document: a single prolog + one synthetic root,
      // parts in stream order (DOC_1 header before DOC_2 body).
      expect(content.startsWith('<?xml version="1.0"')).toBe(true);
      expect(content.match(/<\?xml/g)).toHaveLength(1);
      expect(content).toContain('<formex-multipart parts="2">');
      expect(content.indexOf('<BIB.DOC>')).toBeLessThan(content.indexOf('<ENACTING.TERMS>'));
    });

    it('orders parts by DOC sequence even when the index lists them out of order', async () => {
      // A 300 index that lists DOC_2 before DOC_1 — assembly must still emit the
      // notice header (DOC_1) before the act body (DOC_2).
      const reversedIndex =
        `<html><body> List of URI's:<ul>` +
        `<li title="item"><a href="${FORMEX_PART_URL_DOC_2}">DOC_2</a></li>` +
        `<li title="item"><a href="${FORMEX_PART_URL_DOC_1}">DOC_1</a></li>` +
        `</ul></body></html>`;
      mockFetch.mockImplementation(
        routeMultipart(
          {
            '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
            '/DOC_2': () => new Response(FORMEX_DOC_2, { status: 200 }),
          },
          reversedIndex,
        ),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(true);
      expect(result.content.indexOf('<BIB.DOC>')).toBeLessThan(
        result.content.indexOf('<ENACTING.TERMS>'),
      );
    });

    it('returns a single-part Formex act unchanged (200, no 300, no wrapper)', async () => {
      mockFetch.mockResolvedValue(new Response(FORMEX_SINGLE_PART_ACT, { status: 200 }));

      const result = await makeService().fetchContent(
        '32019R2065',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(true);
      expect(result.content).toBe(FORMEX_SINGLE_PART_ACT);
      expect(result.content).not.toContain('<formex-multipart');
      expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xml;type=fmx4');
    });

    it('falls back to content_available: false (no throw) when a sibling part fails', async () => {
      mockFetch.mockImplementation(
        routeMultipart({
          '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
          '/DOC_2': () => new Response('gone', { status: 404 }),
        }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(false);
      expect(result.content).toBe('');
      expect(result.unavailabilityReason).toBe('multipart_incomplete');
    });

    it('falls back to content_available: false when a 300 lists no discoverable parts', async () => {
      // A 300 body with no <a href> part links — assembly finds nothing to fetch.
      mockFetch.mockResolvedValue(
        new Response('<html><title>300 Multiple-Choice Response</title></html>', { status: 300 }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(false);
      expect(result.unavailabilityReason).toBe('multipart_incomplete');
      expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xml;type=fmx4');
    });

    it('serves the 300 assembly byte for byte: stream order, one prolog, the HTTP 300 note, no further request', async () => {
      mockFetch.mockImplementation(
        routeMultipart({
          '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
          '/DOC_2': () => new Response(FORMEX_DOC_2, { status: 200 }),
        }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      const strip = (part: string) => part.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim();
      expect(result.content).toBe(
        `<?xml version="1.0" encoding="UTF-8"?>
<!-- Assembled by eur-lex-mcp-server from multi-part Formex 4 streams (CELLAR returned HTTP 300 Multiple Choices). Each child is one part root, in stream order. -->
<formex-multipart parts="2">
${strip(FORMEX_DOC_1)}
${strip(FORMEX_DOC_2)}
</formex-multipart>`,
      );
      expect(mockFetch.mock.calls.map((call) => [call[0], headersOf(call).Accept])).toEqual([
        ['http://publications.europa.eu/resource/celex/32016R0679', 'application/xml;type=fmx4'],
        [FORMEX_PART_URL_DOC_1, 'application/xml;type=fmx4'],
        [FORMEX_PART_URL_DOC_2, 'application/xml;type=fmx4'],
      ]);
    });

    it('asks for nothing further after a non-404 Formex failure', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response('service unavailable', { status: 503 })),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.unavailabilityReason).toBe('upstream_failure');
      expect(mockFetch.mock.calls.map((call) => headersOf(call).Accept)).toEqual([
        'application/xml;type=fmx4',
      ]);
    });

    it('treats a sibling WAF challenge as multipart_incomplete without weakening the primary challenge error', async () => {
      mockFetch.mockImplementation(
        routeMultipart({
          '/DOC_1': () => new Response(FORMEX_DOC_1, { status: 200 }),
          '/DOC_2': () => new Response(AWS_WAF_CHALLENGE_HTML, { status: 200 }),
        }),
      );

      const result = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(false);
      expect(result.unavailabilityReason).toBe('multipart_incomplete');
    });
  });

  // --- Zipped Formex 4 packages for acts CELLAR serves no other way (#108) ---

  describe('zipped Formex 4 package (xml, #108)', () => {
    const FMX4 = 'application/xml;type=fmx4';
    const ZIP = 'application/zip;mtype=fmx4';
    const notFound = () => new Response('does not hold a content datastream', { status: 404 });

    /** Answer each `Accept` variant from its own factory; `fmx4` 404s unless given. */
    function routeFormex(zip: () => Response, fmx4: () => Response = notFound) {
      return (_url: string, init: { headers: Record<string, string> }) =>
        Promise.resolve(init.headers.Accept === ZIP ? zip() : fmx4());
    }
    const zipOf = (entries: ZipFixtureEntry[]) => () =>
      new Response(buildZip(entries), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      });
    const fetchXml = (language: 'EN' | 'FR' = 'EN', ctx = createMockContext()) =>
      makeService().fetchContent('32024R1689', language, 'xml', ctx);

    it('asks for the zipped package after the Formex variant 404s, and assembles it', async () => {
      mockFetch.mockImplementation(routeFormex(zipOf(actByActPackage())));

      const result = await fetchXml();

      expect(result.contentAvailable).toBe(true);
      expect(result.format).toBe('xml');
      expect(mockFetch.mock.calls.map((call) => headersOf(call).Accept)).toEqual([FMX4, ZIP]);
      expect(headersOf(mockFetch.mock.calls[1])['Accept-Language']).toBe('eng');
    });

    it('wraps the manifest, then each part it names, in manifest order, leaving the toc out', async () => {
      // Stored act-first, as 32023R2854 is: entry order is not publication order.
      const [toc, manifest, act, annex] = actByActPackage();
      mockFetch.mockImplementation(routeFormex(zipOf([annex!, act!, toc!, manifest!])));

      const { content } = await fetchXml();

      const strip = (part: string) => part.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim();
      expect(content).toBe(
        `<?xml version="1.0" encoding="UTF-8"?>
<!-- Assembled by eur-lex-mcp-server from a zipped Formex 4 package (application/zip;mtype=fmx4). The first child is the package manifest, followed by each part it names, in manifest order. -->
<formex-multipart parts="3">
${strip(PACKAGE_MANIFEST)}
${strip(PACKAGE_ACT)}
${strip(PACKAGE_ANNEX)}
</formex-multipart>`,
      );
      expect(content).not.toContain(strip(PACKAGE_TOC));
      // The assembled act outlines like any Formex body.
      const headings = parseActStructure(content, 'xml', 'EN');
      expect(headings.map((h) => h.label)).toEqual(['CHAPTER I', 'Article 1', 'Article 2']);
    });

    it('reads the older package naming (*.doc.xml manifest, no toc)', async () => {
      mockFetch.mockImplementation(
        routeFormex(
          zipOf([
            { name: 'L_2022277EN.01000101.xml', content: PACKAGE_ACT },
            { name: 'L_2022277EN.01000101.doc.xml', content: LEGACY_PACKAGE_MANIFEST },
          ]),
        ),
      );

      const result = await fetchXml();

      expect(result.contentAvailable).toBe(true);
      expect(result.content).toContain('<formex-multipart parts="2">');
      expect(result.content.indexOf('<DOC>')).toBeLessThan(result.content.indexOf('<ACT>'));
    });

    it('serves an assembled package from the body cache on the next call', async () => {
      mockFetch.mockImplementation(routeFormex(zipOf(actByActPackage())));
      const service = makeService();

      const first = await service.fetchContent('32024R1689', 'EN', 'xml', createMockContext());
      const second = await service.fetchContent('32024R1689', 'EN', 'xml', createMockContext());

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
    });

    it('assembles the requested language’s package without an English fallback', async () => {
      mockFetch.mockImplementation(routeFormex(zipOf(actByActPackage())));

      const result = await fetchXml('FR');

      expect(result.language).toBe('FR');
      expect(result.languageFallback).toBeUndefined();
      expect(mockFetch.mock.calls.map((call) => headersOf(call)['Accept-Language'])).toEqual([
        'fra',
        'fra',
      ]);
    });

    it('falls back to the English package when the requested language has none', async () => {
      mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
        Promise.resolve(
          init.headers.Accept === ZIP && init.headers['Accept-Language'] === 'eng'
            ? zipOf(actByActPackage())()
            : notFound(),
        ),
      );

      const result = await fetchXml('FR');

      expect(result.contentAvailable).toBe(true);
      expect(result.language).toBe('EN');
      expect(result.languageFallback).toContain('FR');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('stays no_representation when the package 404s too (31995L0046)', async () => {
      mockFetch.mockImplementation(routeFormex(notFound));

      const result = await makeService().fetchContent(
        '31995L0046',
        'EN',
        'xml',
        createMockContext(),
      );

      expect(result.contentAvailable).toBe(false);
      expect(result.unavailabilityReason).toBe('no_representation');
      expect(mockFetch.mock.calls.map((call) => headersOf(call).Accept)).toEqual([FMX4, ZIP]);
    });

    it('never asks for the package on the html path', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(notFound()));

      await makeService().fetchContent('31995L0046', 'EN', 'html', createMockContext());

      expect(mockFetch.mock.calls.map((call) => headersOf(call).Accept)).toEqual([
        'application/xhtml+xml',
        'text/html',
      ]);
    });

    it('classifies a failing package request as upstream_failure', async () => {
      mockFetch.mockImplementation(routeFormex(() => new Response('bad gateway', { status: 502 })));

      const result = await fetchXml();

      expect(result.unavailabilityReason).toBe('upstream_failure');
    });

    it.each<[string, () => Response]>([
      [
        'a zip with no manifest',
        zipOf(
          actByActPackage({ 'L_202401689EN.doc.fmx.xml': { name: 'notes.txt', content: 'x' } }),
        ),
      ],
      [
        'a manifest naming a part the archive lacks',
        zipOf(
          actByActPackage({
            'L_202401689EN.012401.fmx.xml': { name: 'L_202401689EN.099901.fmx.xml', content: 'x' },
          }),
        ),
      ],
      [
        'a non-zip 200 body',
        () => new Response(`<html><body>${'Not a package. '.repeat(20)}</body></html>`),
      ],
      [
        'a declared uncompressed total over the cap',
        zipOf(
          actByActPackage({
            'L_202401689EN.012401.fmx.xml': {
              name: 'L_202401689EN.012401.fmx.xml',
              content: PACKAGE_ANNEX,
              declaredSize: 40 * 1024 * 1024,
            },
          }),
        ),
      ],
      ['an empty 200 body', () => new Response('')],
      [
        'a part whose data fails its CRC',
        zipOf(
          actByActPackage({
            'L_202401689EN.000101.fmx.xml': {
              name: 'L_202401689EN.000101.fmx.xml',
              content: PACKAGE_ACT,
              declaredCrc: 0x1234_5678,
            },
          }),
        ),
      ],
    ])('yields multipart_incomplete, never a throw, for %s', async (_case, zip) => {
      mockFetch.mockImplementation(routeFormex(zip));

      const result = await fetchXml();

      expect(result.contentAvailable).toBe(false);
      expect(result.content).toBe('');
      expect(result.unavailabilityReason).toBe('multipart_incomplete');
    });

    it('stores no entry for a package that did not assemble', async () => {
      let packageBody: () => Response = () => new Response('not a zip, and long enough to count');
      mockFetch.mockImplementation(routeFormex(() => packageBody()));
      const service = makeService();
      await service.fetchContent('32024R1689', 'EN', 'xml', createMockContext());

      packageBody = zipOf(actByActPackage());
      const second = await service.fetchContent('32024R1689', 'EN', 'xml', createMockContext());

      expect(second.contentAvailable).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it.each([200, 403])(
      'refuses a WAF challenge answering the package request (HTTP %i) as content_challenge',
      async (status) => {
        mockFetch.mockImplementation(
          routeFormex(() => new Response(AWS_WAF_CHALLENGE_HTML, { status })),
        );

        await expect(fetchXml()).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'content_challenge' },
        });
      },
    );

    it('rethrows a cancellation during the package request instead of degrading it', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) => {
        if (init.headers.Accept === FMX4) return Promise.resolve(notFound());
        controller.abort();
        return Promise.reject(new TypeError('fetch failed'));
      });

      await expect(
        fetchXml('EN', createMockContext({ signal: controller.signal })),
      ).rejects.toThrow();
    });
  });

  // --- Markdown: fetch HTML over the wire, convert server-side (issue #13) ---

  it('fetches HTML and returns server-converted Markdown when format is "markdown"', async () => {
    mockFetch.mockResolvedValue(new Response(ACT_XHTML, { status: 200 }));

    const result = await makeService().fetchContent(
      '32016R0679',
      'EN',
      'markdown',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.format).toBe('markdown');
    // Markdown is derived from HTML — the wire request negotiates xhtml, never a markdown media type.
    expect(headersOf(mockFetch.mock.calls[0]).Accept).toBe('application/xhtml+xml');
    // Recital flattened to inline-marked text; genuine data table → GFM; no raw HTML.
    expect(result.content).toContain('(1) The protection of natural persons');
    expect(result.content).toMatch(/\|\s*CN code\s*\|\s*Description\s*\|/);
    expect(result.content).not.toMatch(/<table|<td|<div/i);
    // Its headings ride along, read against the wire HTML (#106).
    expect(result.headings).toEqual(parseActStructure(result.content, 'markdown', 'EN', ACT_XHTML));
  });

  it('lists headings only behind an available Markdown body (#106)', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(new Response(ACT_XHTML, { status: 200 })));
    const service = makeService();
    const html = await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
    expect(html.content).toBe(ACT_XHTML);
    expect(html.headings).toBeUndefined();

    mockFetch.mockImplementation(() => Promise.resolve(new Response('not found', { status: 404 })));
    const missing = await service.fetchContent('32013R0575', 'EN', 'markdown', createMockContext());
    expect(missing.contentAvailable).toBe(false);
    expect(missing.headings).toBeUndefined();
  });

  it('renders Markdown from the English fallback body when the requested language is unavailable', async () => {
    mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(
        init.headers['Accept-Language'] === 'fra'
          ? new Response('not found', { status: 404 })
          : new Response(ACT_XHTML, { status: 200 }),
      ),
    );

    const result = await makeService().fetchContent(
      '32016R0679',
      'FR',
      'markdown',
      createMockContext(),
    );

    expect(result.contentAvailable).toBe(true);
    expect(result.language).toBe('EN');
    expect(result.format).toBe('markdown');
    expect(result.languageFallback).toContain('FR');
    expect(result.content).toContain('(1) The protection of natural persons');
    expect(result.headings).toEqual(parseActStructure(result.content, 'markdown', 'EN', ACT_XHTML));
  });

  // --- The body cache: one fetch and one conversion per act, language, and format (#127, #129) ---

  describe('body cache (#127, #129)', () => {
    const serve = (body: string, status = 200) =>
      mockFetch.mockImplementation(() => Promise.resolve(new Response(body, { status })));
    const WIRE: Record<ContentFormat, string> = {
      html: ACT_XHTML,
      markdown: ACT_XHTML,
      xml: FORMEX_SINGLE_PART_ACT,
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(['html', 'xml', 'markdown'] as const)(
      'serves a second %s call for the same act and language without a request',
      async (format) => {
        serve(WIRE[format]);
        const service = makeService();
        const first = await service.fetchContent('32016R0679', 'EN', format, createMockContext());
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const translate = vi.spyOn(NodeHtmlMarkdown.prototype, 'translate');
        const second = await service.fetchContent('32016R0679', 'EN', format, createMockContext());
        expect(translate).not.toHaveBeenCalled();
        translate.mockRestore();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
        expect(second.content.length).toBe(first.content.length);
      },
    );

    it('keys the cache by format and by requested language', async () => {
      serve(ACT_XHTML);
      const service = makeService();
      await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      await service.fetchContent('32016R0679', 'EN', 'markdown', createMockContext());
      await service.fetchContent('32016R0679', 'DE', 'html', createMockContext());
      await service.fetchContent('32013R0575', 'EN', 'html', createMockContext());
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('holds an English fallback under the requested language, note included', async () => {
      mockFetch.mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
        Promise.resolve(
          init.headers['Accept-Language'] === 'fra'
            ? new Response('not found', { status: 404 })
            : new Response(ACT_XHTML, { status: 200 }),
        ),
      );
      const service = makeService();
      const first = await service.fetchContent('32016R0679', 'FR', 'markdown', createMockContext());
      const requests = mockFetch.mock.calls.length;
      const second = await service.fetchContent(
        '32016R0679',
        'FR',
        'markdown',
        createMockContext(),
      );

      expect(mockFetch).toHaveBeenCalledTimes(requests);
      expect(second).toEqual(first);
      expect(second.language).toBe('EN');
      expect(second.languageFallback).toContain('FR');
    });

    it('returns Markdown with its heading list read against the source HTML, not the HTML', async () => {
      serve(AMENDING_HTML);
      const result = await makeService().fetchContent(
        '32015R2120',
        'EN',
        'markdown',
        createMockContext(),
      );

      expect(result.content).toBe(htmlToMarkdown(AMENDING_HTML));
      // The #106 verdicts: the quoted headings the Markdown alone cannot tell apart are gone.
      expect(result.headings).toEqual(
        parseActStructure(result.content, 'markdown', 'EN', AMENDING_HTML),
      );
      expect(result.headings).not.toEqual(parseActStructure(result.content, 'markdown', 'EN'));
      expect(result).not.toHaveProperty('sourceHtml');
    });

    it('lists no headings behind an html or xml body', async () => {
      serve(ACT_XHTML);
      const html = await makeService().fetchContent(
        '32016R0679',
        'EN',
        'html',
        createMockContext(),
      );
      expect(html).not.toHaveProperty('headings');
    });

    it('keeps each caller’s result apart from the cached entry', async () => {
      serve(AMENDING_HTML);
      const service = makeService();
      const first = await service.fetchContent('32015R2120', 'EN', 'markdown', createMockContext());
      const pristine = structuredClone(first);

      first.content = '';
      first.language = 'DE';
      (first.headings ?? [])[0]!.label = 'Tampered';
      first.headings?.push({ kind: 'article', label: 'Article 99', number: '99', offset: 0 });

      const second = await service.fetchContent(
        '32015R2120',
        'EN',
        'markdown',
        createMockContext(),
      );
      expect(second).toEqual(pristine);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('stores no entry for an unavailable body', async () => {
      serve('not found', 404);
      const service = makeService();
      const missing = await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      expect(missing.contentAvailable).toBe(false);

      serve(ACT_XHTML);
      const found = await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      expect(found.contentAvailable).toBe(true);
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it('stores no entry for a challenged call', async () => {
      serve(AWS_WAF_CHALLENGE_HTML);
      const service = makeService();
      await expect(
        service.fetchContent('32016R0679', 'EN', 'html', createMockContext()),
      ).rejects.toThrow(/bot-challenge/i);

      serve(ACT_XHTML);
      const found = await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      expect(found.contentAvailable).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('rethrows a cancellation during the fetch, with no retry and no fallback request', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(() => {
        controller.abort();
        return Promise.reject(new TypeError('fetch failed'));
      });
      const service = makeService();
      await expect(
        service.fetchContent(
          '32016R0679',
          'FR',
          'markdown',
          createMockContext({ signal: controller.signal }),
        ),
      ).rejects.toThrow('fetch failed');
      // Degraded to unavailable, the call would have gone on to the text/html variant and English.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('stores no entry for a call cancelled after its body arrived', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(() => {
        controller.abort();
        return Promise.resolve(new Response(ACT_XHTML, { status: 200 }));
      });
      const service = makeService();
      await service.fetchContent(
        '32016R0679',
        'EN',
        'html',
        createMockContext({ signal: controller.signal }),
      );
      await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('runs two cold calls as two fetches, each under its own caller’s signal', async () => {
      const release: (() => void)[] = [];
      mockFetch.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
            release.push(() => resolve(new Response(ACT_XHTML, { status: 200 })));
          }),
      );
      const service = makeService();
      const cancelled = new AbortController();
      const kept = new AbortController();
      const first = service.fetchContent(
        '32016R0679',
        'EN',
        'markdown',
        createMockContext({ signal: cancelled.signal }),
      );
      const second = service.fetchContent(
        '32016R0679',
        'EN',
        'markdown',
        createMockContext({ signal: kept.signal }),
      );
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

      cancelled.abort();
      await expect(first).rejects.toThrow();
      for (const resolve of release) resolve();
      const result = await second;

      expect(result.contentAvailable).toBe(true);
      expect(kept.signal.aborted).toBe(false);
      const [a, b] = mockFetch.mock.calls.map(
        (call) => (call[1] as { signal: AbortSignal }).signal,
      );
      expect(a).not.toBe(b);
      expect(a?.aborted).toBe(true);
      expect(b?.aborted).toBe(false);

      // The completed call's entry serves the next caller.
      await service.fetchContent('32016R0679', 'EN', 'markdown', createMockContext());
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('expires an entry after one hour', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
      serve(ACT_XHTML);
      const service = makeService();
      await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());

      vi.setSystemTime(new Date('2026-09-26T00:59:59Z'));
      await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-09-26T01:00:01Z'));
      await service.fetchContent('32016R0679', 'EN', 'html', createMockContext());
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    /** An html body of `chars` characters, one per CELEX, served by URL. */
    const serveSized = (sizes: Record<string, number>) =>
      mockFetch.mockImplementation((url: string) => {
        const celex = decodeURIComponent(url.split('/').at(-1) ?? '');
        return Promise.resolve(new Response('a'.repeat(sizes[celex] ?? 0), { status: 200 }));
      });

    it('evicts the least recently used entry to keep retained characters within 16 million', async () => {
      serveSized({ '32016R0679': 7_000_000, '32019R0876': 7_000_000, '32024R1689': 7_000_000 });
      const service = makeService();
      const get = (celex: string) => service.fetchContent(celex, 'EN', 'html', createMockContext());
      await get('32016R0679');
      await get('32019R0876');
      await get('32016R0679'); // a hit, and now the most recently used
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await get('32024R1689'); // 21 million characters: 32019R0876 goes
      expect(mockFetch).toHaveBeenCalledTimes(3);
      await get('32016R0679');
      await get('32024R1689');
      expect(mockFetch).toHaveBeenCalledTimes(3);
      await get('32019R0876');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('stores no entry over the cap, and keeps the entries it holds', async () => {
      serveSized({ '32016R0679': 1_000, '02013R0575-20240709': 16_000_001 });
      const service = makeService();
      const get = (celex: string) => service.fetchContent(celex, 'EN', 'html', createMockContext());
      await get('32016R0679');
      const huge = await get('02013R0575-20240709');
      expect(huge.content.length).toBe(16_000_001);

      await get('02013R0575-20240709');
      await get('32016R0679');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // --- The bug: an AWS WAF challenge must NEVER be reported as content (issue #16) ---

  it('detects the AWS WAF challenge stub and raises content_unavailable instead of returning it', async () => {
    mockFetch.mockResolvedValue(new Response(AWS_WAF_CHALLENGE_HTML, { status: 200 }));

    await expect(
      makeService().fetchContent('32016R0679', 'EN', 'html', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'content_challenge' },
    });
  });

  it('refuses the challenge even when served with a 2xx status (the original passthrough bug)', async () => {
    // The legacy endpoint returned the stub with HTTP 202, which is `response.ok`,
    // so it slipped past the old length check and was surfaced as the act text.
    mockFetch.mockResolvedValue(new Response(AWS_WAF_CHALLENGE_HTML, { status: 202 }));

    await expect(
      makeService().fetchContent('32016R0679', 'EN', 'html', createMockContext()),
    ).rejects.toThrow(/bot-challenge/i);
  });

  it('refuses the challenge when the WAF serves it with a non-2xx status', async () => {
    mockFetch.mockResolvedValue(new Response(AWS_WAF_CHALLENGE_HTML, { status: 403 }));

    await expect(
      makeService().fetchContent('32016R0679', 'EN', 'html', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'content_challenge' },
    });
  });

  it('refuses the challenge before treating a 404 response as an absent representation', async () => {
    mockFetch.mockResolvedValue(new Response(AWS_WAF_CHALLENGE_HTML, { status: 404 }));

    await expect(
      makeService().fetchContent('32016R0679', 'EN', 'html', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'content_challenge' },
    });
  });
});
