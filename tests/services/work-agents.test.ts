/**
 * @fileoverview Tests for the shared agent reader: institutions labelled from each
 * authority code's English skos:prefLabel (#103) and from national-court names,
 * persons kept out of them, and Advocates General read by surname (#96).
 * @module tests/services/work-agents.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { fetchWorkAgents } from '@/services/cellar-sparql/work-agents.js';
import { agentRows, CELLAR, canonicalWork } from '../fixtures/cellar-works.js';

const AUTHORITY = 'http://publications.europa.eu/resource/authority/';
const CB = `${AUTHORITY}corporate-body/`;
type Row = Record<string, { type: string; value: string }>;

const agent = (
  uri: string,
  role: 'creator' | 'advocate_general',
  names: { personName?: string; courtName?: string; label?: string } = {},
): Row => ({
  agent: { type: 'uri', value: uri },
  role: { type: 'literal', value: role },
  ...(names.personName ? { personName: { type: 'literal', value: names.personName } } : {}),
  ...(names.courtName ? { courtName: { type: 'literal', value: names.courtName } } : {}),
  ...(names.label ? { agentLabel: { type: 'literal', value: names.label } } : {}),
});

/** A creator row for an authority code carrying its English label. */
const labelled = (code: string, label: string): Row =>
  agent(`${AUTHORITY}${code}`, 'creator', { label });

const read = async (rows: Row[] | ((q: string) => Row[]), workUri = `${CELLAR}w`) => {
  const query = vi.fn(async (q: string) => (typeof rows === 'function' ? rows(q) : rows));
  const agents = await fetchWorkAgents({ query }, workUri, createMockContext());
  return { agents, sparql: query.mock.calls[0]?.[0] as string };
};

describe('fetchWorkAgents', () => {
  it.each([
    ['62012CJ0131', ['Court of Justice'], ['Jääskinen']],
    ['62024CC0505', [], ['Biondi']],
    ['82003PT1111(51)', ['Supremo Tribunal de Justiça'], []],
    ['61983CJ0271', ['Court of Justice'], ['Mischo', 'VerLoren van Themaat']],
    ['32016R0679', ['Council of the European Union', 'European Parliament'], []],
  ])('reads %s as institutions %j and Advocates General %j', async (celex, institutions, ags) => {
    const { agents } = await read(agentRows, canonicalWork(celex));
    expect(agents).toEqual({ institutions, advocatesGeneral: ags });
  });

  it('never returns a CELLAR resource URI or UUID as an institution', async () => {
    const { agents } = await read([
      agent(`${CELLAR}233d79cc-67e5-4048-9fd0-fda2509029b4`, 'creator', {
        personName: 'Jääskinen',
      }),
      agent(`${CELLAR}0000-unnamed-resource`, 'creator'),
      agent(`${CB}CJ`, 'creator', { label: 'Court of Justice' }),
    ]);
    expect(agents.institutions).toEqual(['Court of Justice']);
    expect(JSON.stringify(agents)).not.toContain('cellar');
  });

  it('renders an authority code with no English label as its last path segment', async () => {
    const { agents } = await read([agent(`${CB}NEWBODY`, 'creator')]);
    expect(agents.institutions).toEqual(['NEWBODY']);
  });

  it.each([
    [
      '22026A00757',
      [
        labelled('corporate-body/EURUN', 'European Union'),
        labelled('corporate-body/EURUN', 'European Union'),
        labelled('country/AUT', 'Austria'),
        labelled('country/BEL', 'Belgium'),
        labelled('country/SWE', 'Sweden'),
      ],
      ['European Union', 'Austria', 'Belgium', 'Sweden'],
    ],
    ['71991L0683NLD_87862', [labelled('country/NLD', 'Netherlands')], ['Netherlands']],
    [
      '91980E001013',
      [
        labelled('corporate-body/EP', 'European Parliament'),
        labelled('fd_013/VAN-MIERT', 'VAN MIERT'),
      ],
      ['European Parliament', 'VAN MIERT'],
    ],
    [
      '51988AC0454',
      [labelled('corporate-body/EESC', 'European Economic and Social Committee')],
      ['European Economic and Social Committee'],
    ],
    [
      'a consolidated text with no base act',
      [labelled('corporate-body/OP_DATPRO', 'Provisional data')],
      ['Provisional data'],
    ],
    [
      'a court the old static table shortened',
      [labelled('corporate-body/CURIA', 'Court of Justice of the European Union')],
      ['Court of Justice of the European Union'],
    ],
  ])(
    '#103: labels the authority-code authors of %s by English prefLabel',
    async (_w, rows, labels) => {
      const { agents } = await read(rows);
      expect(agents.institutions).toEqual(labels);
      for (const code of ['EURUN', 'AUT', 'NLD', 'VAN-MIERT', 'EESC', 'OP_DATPRO', 'CURIA']) {
        expect(agents.institutions).not.toContain(code);
      }
    },
  );

  it('keeps a court named by cdm:court_national_name ahead of any label', async () => {
    const { agents } = await read([
      agent(`${CELLAR}court`, 'creator', { courtName: 'Supremo Tribunal de Justiça' }),
    ]);
    expect(agents.institutions).toEqual(['Supremo Tribunal de Justiça']);
  });

  it('de-duplicates labels and surnames repeated across rows', async () => {
    const { agents } = await read([
      agent(`${CB}EMA`, 'creator', { label: 'European Medicines Agency' }),
      agent(`${CB}EMEA`, 'creator', { label: 'European Medicines Agency' }),
      agent(`${CELLAR}p`, 'advocate_general', { personName: 'Kokott' }),
      agent(`${CELLAR}p`, 'advocate_general', { personName: 'Kokott' }),
    ]);
    expect(agents).toEqual({
      institutions: ['European Medicines Agency'],
      advocatesGeneral: ['Kokott'],
    });
  });

  it('skips an Advocate General with no recorded name rather than exposing the resource', async () => {
    const { agents } = await read([agent(`${CELLAR}nameless`, 'advocate_general')]);
    expect(agents.advocatesGeneral).toEqual([]);
  });

  it('sorts several Advocates General by surname', async () => {
    const { agents } = await read([
      agent(`${CELLAR}c`, 'advocate_general', { personName: 'Ćapeta' }),
      agent(`${CELLAR}w`, 'advocate_general', { personName: 'Wahl' }),
      agent(`${CELLAR}b`, 'advocate_general', { personName: 'Bobek' }),
    ]);
    expect(agents.advocatesGeneral).toEqual(['Bobek', 'Ćapeta', 'Wahl']);
  });

  it('returns two empty lists for a work with no agents', async () => {
    const { agents } = await read([]);
    expect(agents).toEqual({ institutions: [], advocatesGeneral: [] });
  });

  it('reads both roles of the work in one bounded query with separate name and label variables', async () => {
    const { sparql } = await read([], `${CELLAR}w`);
    expect(sparql).toContain(`{ <${CELLAR}w> cdm:work_created_by_agent ?agent .`);
    expect(sparql).toContain(`{ <${CELLAR}w> cdm:case-law_delivered_by_advocate-general ?agent .`);
    expect(sparql).toContain('OPTIONAL { ?agent cdm:agent_name ?personName . }');
    expect(sparql).toContain('OPTIONAL { ?agent cdm:court_national_name ?courtName . }');
    expect(sparql).toContain(
      'OPTIONAL { ?agent skos:prefLabel ?agentLabel . FILTER(LANG(?agentLabel) = "en") }',
    );
    expect(sparql).not.toContain('GROUP BY');
    expect(sparql.trimEnd().endsWith('LIMIT 100')).toBe(true);
  });
});
