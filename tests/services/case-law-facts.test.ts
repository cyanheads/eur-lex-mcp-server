/**
 * @fileoverview Tests for the case-law facts reader: the query it sends for a set of
 * resolved works and how it reads CELLAR's rows back into sorted per-work facts.
 * @module tests/services/case-law-facts.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { fetchCaseLawFacts } from '@/services/cellar-sparql/case-law-facts.js';

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
});
