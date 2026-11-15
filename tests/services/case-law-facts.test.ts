/**
 * @fileoverview Tests for the case-law facts reader: the query it sends for a set of
 * resolved works and how it reads CELLAR's rows back into sorted per-work facts.
 * @module tests/services/case-law-facts.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCaseLawFacts } from '@/services/cellar-sparql/case-law-facts.js';
import { CellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';

type Row = Record<string, { type: string; value: string }>;

const AUTHORITY = 'http://publications.europa.eu/resource/authority/';
const CELLAR = 'http://publications.europa.eu/resource/cellar/';
/** 62021CJ0340's canonical work. */
const C_340_21 = `${CELLAR}c340-main`;
const OTHER = `${CELLAR}other-main`;

/** One row as CELLAR returns it: a work, the fact its arm binds, the code, and a label. */
function row(work: string, fact: string, code: string, label?: string): Row {
  return {
    work: { type: 'uri', value: work },
    fact: { type: 'literal', value: fact },
    code: { type: 'uri', value: code },
    ...(label ? { label: { type: 'literal', value: label } } : {}),
  };
}

/** A fake service answering every query with `rows`, recording each query. */
function serviceAnswering(rows: Row[]) {
  const query = vi.fn(async (_sparql: string) => rows);
  return { svc: { query }, query };
}

/** The facts of 62021CJ0340 (C-340/21) as CELLAR records them on its canonical work. */
const C_340_21_ROWS = [
  row(C_340_21, 'countries', `${AUTHORITY}country/BGR`),
  row(C_340_21, 'procedure_types', `${AUTHORITY}fd_100/PREJ`, 'Reference for a preliminary ruling'),
  row(
    C_340_21,
    'subjects',
    `${AUTHORITY}case-law-subject-matter/PDON`,
    'Protection of personal data',
  ),
  row(C_340_21, 'subjects', `${AUTHORITY}case-law-subject-matter/PRIN`, 'Principles of Union law'),
  row(C_340_21, 'procedure_languages', `${AUTHORITY}language/BUL`),
];

describe('fetchCaseLawFacts', () => {
  it('sends no query for no works', async () => {
    const { svc, query } = serviceAnswering([]);

    expect(await fetchCaseLawFacts(svc, [], createMockContext())).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('reads every fact of the works in one ungrouped query keyed by the distinct works', async () => {
    const { svc, query } = serviceAnswering([]);

    await fetchCaseLawFacts(svc, [C_340_21, OTHER, C_340_21], createMockContext());

    expect(query).toHaveBeenCalledTimes(1);
    const sparql = query.mock.calls[0]?.[0] ?? '';
    expect(sparql).toContain(`VALUES ?work { <${C_340_21}> <${OTHER}> }`);
    // Labels are joined in English, inside the arms that report them and no other.
    const englishLabel =
      '\n    OPTIONAL { ?code skos:prefLabel ?label . FILTER(LANG(?label) = "en") }';
    for (const [predicate, fact, labelled] of [
      ['cdm:case-law_originates_in_country', 'countries', false],
      ['cdm:case-law_has_type_procedure_concept_type_procedure', 'procedure_types', true],
      ['cdm:case-law_is-about_case-law-subject-matter', 'subjects', true],
      ['cdm:case-law_uses_procedure_language', 'procedure_languages', false],
    ] as const) {
      expect(sparql).toContain(
        `?work ${predicate} ?code .\n    BIND("${fact}" AS ?fact)${labelled ? englishLabel : ''}\n  }`,
      );
    }
    expect(
      sparql.match(
        /OPTIONAL \{ \?code skos:prefLabel \?label \. FILTER\(LANG\(\?label\) = "en"\) \}/g,
      ),
    ).toHaveLength(2);
    expect(sparql.match(/\} UNION \{/g)).toHaveLength(3);
    expect(sparql).not.toMatch(/GROUP BY|LIMIT|GROUP_CONCAT/);
  });

  it('reports 62021CJ0340 as CELLAR records it: BGR, a preliminary reference, two subjects, BG', async () => {
    const { svc } = serviceAnswering(C_340_21_ROWS);

    const facts = await fetchCaseLawFacts(svc, [C_340_21], createMockContext());

    expect(facts.get(C_340_21)).toEqual({
      countries: ['BGR'],
      procedure_types: ['Reference for a preliminary ruling'],
      subjects: ['Principles of Union law', 'Protection of personal data'],
      procedure_languages: ['BG'],
    });
  });

  it('keeps each work its own facts, sorted and de-duplicated, every value of a multi-valued fact', async () => {
    const { svc } = serviceAnswering([
      row(OTHER, 'countries', `${AUTHORITY}country/NLD`),
      row(OTHER, 'countries', `${AUTHORITY}country/BEL`),
      row(OTHER, 'countries', `${AUTHORITY}country/GBR`),
      row(OTHER, 'countries', `${AUTHORITY}country/BEL`),
      row(OTHER, 'procedure_types', `${AUTHORITY}fd_100/PVOI%3DOB`, 'Appeal - successful'),
      row(OTHER, 'procedure_types', `${AUTHORITY}fd_100/ANNU`, 'Action for annulment'),
      row(OTHER, 'procedure_languages', `${AUTHORITY}language/ENG`),
      row(OTHER, 'procedure_languages', `${AUTHORITY}language/FRA`),
      ...C_340_21_ROWS,
    ]);

    const facts = await fetchCaseLawFacts(svc, [C_340_21, OTHER], createMockContext());

    expect(facts.get(OTHER)).toEqual({
      countries: ['BEL', 'GBR', 'NLD'],
      procedure_types: ['Action for annulment', 'Appeal - successful'],
      procedure_languages: ['EN', 'FR'],
    });
    expect(facts.get(C_340_21)?.countries).toEqual(['BGR']);
  });

  it('leaves a fact CELLAR records nothing for absent, and a work with none out of the map', async () => {
    const { svc } = serviceAnswering([
      row(OTHER, 'procedure_types', `${AUTHORITY}fd_100/FONC%3DRF`, 'Staff cases - unfounded'),
    ]);

    const facts = await fetchCaseLawFacts(svc, [C_340_21, OTHER], createMockContext());

    expect(facts.get(OTHER)).toEqual({ procedure_types: ['Staff cases - unfounded'] });
    expect(facts.get(OTHER)).not.toHaveProperty('countries');
    expect(facts.has(C_340_21)).toBe(false);
  });

  it('never reports the Provisional data placeholder in any fact', async () => {
    const { svc } = serviceAnswering([
      row(OTHER, 'countries', `${AUTHORITY}country/OP_DATPRO`),
      row(OTHER, 'countries', `${AUTHORITY}country/USA`),
      row(OTHER, 'procedure_types', `${AUTHORITY}fd_100/OP_DATPRO`, 'Provisional data'),
      row(OTHER, 'subjects', `${AUTHORITY}case-law-subject-matter/OP_DATPRO`, 'Provisional data'),
      row(OTHER, 'procedure_languages', `${AUTHORITY}language/OP_DATPRO`),
      row(
        C_340_21,
        'subjects',
        `${AUTHORITY}case-law-subject-matter/OP_DATPRO`,
        'Provisional data',
      ),
    ]);

    const facts = await fetchCaseLawFacts(svc, [C_340_21, OTHER], createMockContext());

    // A third country is a recorded fact; the placeholder is not.
    expect(facts.get(OTHER)).toEqual({ countries: ['USA'] });
    expect(facts.has(C_340_21)).toBe(false);
  });

  it('reports the authority code of a value with no English label or no EUR-Lex language code', async () => {
    const { svc } = serviceAnswering([
      row(OTHER, 'procedure_types', `${AUTHORITY}fd_100/ANNU%3DXX`),
      row(OTHER, 'subjects', `${AUTHORITY}case-law-subject-matter/NEWCODE`),
      row(OTHER, 'procedure_languages', `${AUTHORITY}language/ISL`),
      row(OTHER, 'procedure_languages', `${AUTHORITY}language/GLE`),
    ]);

    const facts = await fetchCaseLawFacts(svc, [OTHER], createMockContext());

    expect(facts.get(OTHER)).toEqual({
      procedure_types: ['ANNU%3DXX'],
      subjects: ['NEWCODE'],
      procedure_languages: ['GA', 'ISL'],
    });
  });

  it('maps every procedure language CELLAR records on case law to its EUR-Lex code', async () => {
    // The 24 values on primary records (live, 2026-11-03).
    const authorityCodes =
      'ENG FRA DEU ITA NLD SPA ELL POL POR BUL HUN RON DAN SWE CES FIN LIT LAV SLK SLV EST HRV MLT GLE';
    const { svc } = serviceAnswering(
      authorityCodes
        .split(' ')
        .map((code) => row(OTHER, 'procedure_languages', `${AUTHORITY}language/${code}`)),
    );

    const facts = await fetchCaseLawFacts(svc, [OTHER], createMockContext());

    expect(facts.get(OTHER)?.procedure_languages).toEqual(
      'BG CS DA DE EL EN ES ET FI FR GA HR HU IT LT LV MT NL PL PT RO SK SL SV'.split(' '),
    );
  });

  // CELLAR refuses a SPARQL POST body over 8,192 bytes with HTTP 403.
  describe('the request size CELLAR accepts', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const BODY_LIMIT_BYTES = 8_192;
    /** A work URI as CELLAR mints it: its namespace and a UUID. */
    const work = (i: number) =>
      `${CELLAR}${String(i).padStart(8, '0')}-8b3f-11e3-8c37-01aa75ed71a1`;

    function realService(): CellarSparqlService {
      return new CellarSparqlService({} as never, {} as never, {
        cellarSparqlEndpoint: 'http://cellar.test/sparql',
        eurLexContentBaseUrl: 'http://content.test',
        sparqlQueryTimeoutMs: 5_000,
        maxSparqlResults: 100,
      });
    }

    /**
     * CELLAR answering each facts request with a country for every work its `VALUES`
     * list names, recording each request's body size and works, and when it was sent
     * and answered: each answer waits a macrotask, so requests sent together overlap.
     */
    function stubCellar() {
      const requests: { bytes: number; works: string[] }[] = [];
      const events: string[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
        const query = new URLSearchParams(init.body).get('query') ?? '';
        const named = /VALUES \?work \{([^}]*)\}/.exec(query)?.[1] ?? '';
        const works = [...named.matchAll(/<([^>]+)>/g)].map(([, uri]) => uri ?? '');
        requests.push({ bytes: Buffer.byteLength(init.body), works });
        events.push('sent');
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.push('answered');
        const bindings = works.map((uri) => row(uri, 'countries', `${AUTHORITY}country/AUT`));
        return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
      });
      return { requests, events };
    }

    it('reads the facts of a full 100-row page in concurrent queries under the limit, every work once', async () => {
      const { requests, events } = stubCellar();
      const works = Array.from({ length: 100 }, (_, i) => work(i));

      const facts = await fetchCaseLawFacts(realService(), works, createMockContext());

      expect(requests.length).toBeGreaterThan(1);
      for (const { bytes } of requests) expect(bytes).toBeLessThanOrEqual(BODY_LIMIT_BYTES);
      expect(requests.flatMap((r) => r.works).sort()).toEqual([...works].sort());
      // Every request is sent before any is answered.
      expect(events).toEqual([...requests.map(() => 'sent'), ...requests.map(() => 'answered')]);
      expect(facts.size).toBe(100);
      for (const uri of works) expect(facts.get(uri)).toEqual({ countries: ['AUT'] });
    });

    it('reads one work, as eurlex_get_document does, in one query', async () => {
      const { requests } = stubCellar();

      const facts = await fetchCaseLawFacts(realService(), [work(7)], createMockContext());

      expect(requests).toEqual([{ bytes: expect.any(Number), works: [work(7)] }]);
      expect(facts.get(work(7))).toEqual({ countries: ['AUT'] });
    });
  });
});
