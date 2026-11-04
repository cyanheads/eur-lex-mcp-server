/**
 * @fileoverview Tests for the legislative-procedure reader: the query it sends for an
 * act's work, and how it reads CELLAR's per-dossier rows back into procedures — the
 * status flags, the reference grammar, the withdrawal date, and the produced acts.
 * @module tests/services/legislative-procedures.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { fetchLegislativeProcedures } from '@/services/cellar-sparql/legislative-procedures.js';

type Row = Record<string, { type: string; value: string }>;

const WORK = 'http://publications.europa.eu/resource/cellar/b54bd5d0-d809-11e6-ad7c-01aa75ed71a1';

/** The flags a dossier sets, each `true`/`false` as `STR()` of an `xsd:boolean` reads. */
interface Dossier {
  adopted?: string;
  adoptedActs?: string;
  notAdopted?: string;
  pending?: string;
  ref: string;
  withdrawalDate?: string;
  withdrawn?: string;
}

/** One grouped row as CELLAR returns it: unbound aggregates are left out. */
function row({ ref, ...rest }: Dossier): Row {
  return {
    procedureRef: { type: 'literal', value: ref },
    ...Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, { type: 'literal', value }]),
    ),
  };
}

/** A dossier with exactly the named flag true and the other three false. */
function flagged(ref: string, flag: 'adopted' | 'withdrawn' | 'pending' | 'notAdopted'): Dossier {
  return {
    ref,
    adopted: 'false',
    withdrawn: 'false',
    pending: 'false',
    notAdopted: 'false',
    adoptedActs: '',
    [flag]: 'true',
  };
}

async function read(rows: Row[]) {
  const query = vi.fn(async (_sparql: string) => rows);
  const procedures = await fetchLegislativeProcedures({ query }, WORK, createMockContext());
  return { procedures, query };
}

describe('fetchLegislativeProcedures', () => {
  it('reads all three dossier links in one grouped query keyed by the work, with no LIMIT', async () => {
    const { query } = await read([]);

    expect(query).toHaveBeenCalledTimes(1);
    const sparql = query.mock.calls[0]?.[0] ?? '';
    /**
     * The proposal's link, the adopted act's link, and the initiating act's link, as
     * three arms of one UNION: many initiating proposals carry only the last.
     */
    expect(sparql).toContain(
      `{ <${WORK}> cdm:work_part_of_dossier ?procedure . }\n  UNION\n  { ?procedure cdm:dossier_produces_resource_legal <${WORK}> . }\n  UNION\n  { ?procedure cdm:dossier_initiated_by_act_preparatory <${WORK}> . }`,
    );
    // Only a dossier carrying a procedure reference is a procedure: the pattern is required.
    expect(sparql).toMatch(
      /\n {2}\?procedure cdm:procedure_code_interinstitutional_reference_procedure \?procedureRef \.\n/,
    );
    for (const [predicate, variable] of [
      ['dossier_adopted-proposal', 'adopted'],
      ['dossier_withdrawn-proposal', 'withdrawn'],
      ['dossier_pending-proposal', 'pending'],
      ['dossier_not-adopted-proposal', 'notAdopted'],
    ]) {
      expect(sparql).toContain(`OPTIONAL { ?procedure cdm:${predicate} ?${variable}Flag . }`);
      expect(sparql).toContain(`(MAX(STR(?${variable}Flag)) AS ?${variable})`);
    }
    expect(sparql).toContain('(MIN(STR(?withdrawalDateValue)) AS ?withdrawalDate)');
    // The withdrawal date and the produced acts are optional: a dossier recording
    // neither is still a procedure. The acts are the ones the dossier produced.
    expect(sparql).toContain(
      '\n  OPTIONAL { ?procedure cdm:dossier_date_withdrawn ?withdrawalDateValue . }\n',
    );
    expect(sparql).toContain(
      '\n  OPTIONAL {\n    ?procedure cdm:dossier_produces_resource_legal ?adoptedAct .\n    ?adoptedAct cdm:resource_legal_id_celex ?adoptedCelex .\n  }\n',
    );
    expect(sparql).toMatch(/GROUP BY \?procedure \?procedureRef$/);
    // Neither the file status nor the adoption date is read.
    expect(sparql).not.toMatch(/file-status|dossier_date_adopted|LIMIT/);
  });

  it('reads no procedure from a work in none', async () => {
    const { procedures } = await read([]);
    expect(procedures).toEqual([]);
  });

  it('52017PC0010: the ePrivacy procedure, withdrawn on 2025-10-06, as CELLAR returns it', async () => {
    const { procedures } = await read([
      row({
        ref: '2017/0003/COD',
        adopted: 'false',
        withdrawn: 'true',
        pending: 'false',
        withdrawalDate: '2025-10-06',
        adoptedActs: '',
      }),
    ]);
    expect(procedures).toEqual([
      { reference: '2017/0003(COD)', status: 'withdrawn', withdrawal_date: '2025-10-06' },
    ]);
  });

  it.each([
    ['adopted', 'adopted'],
    ['withdrawn', 'withdrawn'],
    ['pending', 'pending'],
    ['notAdopted', 'not_adopted'],
  ] as const)('a dossier whose only true flag is %s has status %s', async (flag, status) => {
    const { procedures } = await read([row(flagged('2002/0047/COD', flag))]);
    expect(procedures).toEqual([{ reference: '2002/0047(COD)', status }]);
  });

  it('reads the flags in either lexical form CELLAR serializes a boolean in', async () => {
    const { procedures } = await read([
      row({ ref: '2021/0106/COD', adopted: '1', withdrawn: '0', pending: '0' }),
    ]);
    expect(procedures[0]?.status).toBe('adopted');
  });

  it.each([
    ['no flag true', { adopted: 'false', withdrawn: 'false', pending: 'false' }],
    ['no flag recorded', {}],
    ['adopted and withdrawn', { adopted: 'true', withdrawn: 'true', pending: 'false' }],
    ['withdrawn and pending', { adopted: 'false', withdrawn: 'true', pending: 'true' }],
  ])('a dossier with %s has no status, and keeps its reference and acts', async (_label, flags) => {
    const { procedures } = await read([
      row({ ref: '2014/0298/NLE', adoptedActs: '32015D0001', ...flags }),
    ]);
    expect(procedures).toHaveLength(1);
    expect(procedures[0]).not.toHaveProperty('status');
    expect(procedures[0]).toMatchObject({
      reference: '2014/0298(NLE)',
      adopted_acts: ['32015D0001'],
    });
  });

  it('carries the withdrawal date whenever the withdrawn flag is true, a conflicting status included', async () => {
    const { procedures } = await read([
      // 1995/0146/CNS: adopted 1995-12-08, then flagged withdrawn too.
      row({
        ref: '1995/0146/CNS',
        adopted: 'true',
        withdrawn: 'true',
        pending: 'false',
        withdrawalDate: '1998-12-17',
        adoptedActs: '31995R2870',
      }),
      // A date beside a false withdrawn flag is not a withdrawal.
      row({ ...flagged('2016/0141/COD', 'pending'), withdrawalDate: '2020-01-01' }),
      // Flagged withdrawn with no date recorded.
      row(flagged('2016/0337/CNS', 'withdrawn')),
    ]);
    expect(procedures).toEqual([
      { reference: '1995/0146(CNS)', withdrawal_date: '1998-12-17', adopted_acts: ['31995R2870'] },
      { reference: '2016/0141(COD)', status: 'pending' },
      { reference: '2016/0337(CNS)', status: 'withdrawn' },
    ]);
  });

  it('reads a withdrawal date written as a dateTime to its date', async () => {
    const { procedures } = await read([
      row({ ...flagged('2012/0007/COD', 'withdrawn'), withdrawalDate: '2015-03-07T00:00:00' }),
    ]);
    expect(procedures[0]?.withdrawal_date).toBe('2015-03-07');
  });

  it.each([
    ['2017/0003/COD', '2017/0003(COD)'],
    ['2023/0807/NLE', '2023/0807(NLE)'],
    ['2010/0002/BUD', '2010/0002(BUD)'],
    // A split procedure keeps its lettered number as written, padding included.
    ['2011/341A/COD', '2011/341A(COD)'],
    ['1998/031R/NLE', '1998/031R(NLE)'],
    ['2011/0901A/COD', '2011/0901A(COD)'],
    // Any other shape is returned verbatim.
    ['2010/2001(BUD)', '2010/2001(BUD)'],
    ['2008/0073/', '2008/0073/'],
    ['2017/0003/cod', '2017/0003/cod'],
    ['17/0003/COD', '17/0003/COD'],
    ['2017/0003/COD/X', '2017/0003/COD/X'],
  ])('writes the reference %s as %s', async (stored, cited) => {
    const { procedures } = await read([row({ ref: stored })]);
    expect(procedures).toEqual([{ reference: cited }]);
  });

  it('lists every act a procedure produced, sorted and once each, and none when it links none', async () => {
    const { procedures } = await read([
      row({
        ...flagged('1981/0021/COD', 'adopted'),
        adoptedActs: '31983L0182 31983L0181 31983L0182',
      }),
      row({ ...flagged('2021/0136/COD', 'adopted'), adoptedActs: '' }),
    ]);
    expect(procedures).toEqual([
      {
        reference: '1981/0021(COD)',
        status: 'adopted',
        adopted_acts: ['31983L0181', '31983L0182'],
      },
      { reference: '2021/0136(COD)', status: 'adopted' },
    ]);
  });

  it('52023PC0331: every procedure the work sits in, sorted by reference whatever the row order', async () => {
    const { procedures } = await read([
      row({ ...flagged('2021/0430/CNS', 'pending'), adoptedActs: '' }),
      row({ ...flagged('2018/0135/CNS', 'adopted'), adoptedActs: '32020D2053' }),
    ]);
    expect(procedures).toEqual([
      { reference: '2018/0135(CNS)', status: 'adopted', adopted_acts: ['32020D2053'] },
      { reference: '2021/0430(CNS)', status: 'pending' },
    ]);
  });

  it('32023D2641: three NLE procedures, each producing the act', async () => {
    const { procedures } = await read(
      ['2023/0808/NLE', '2023/0807/NLE', '2023/0806/NLE'].map((ref) =>
        row({ ...flagged(ref, 'adopted'), adoptedActs: '32023D2641' }),
      ),
    );
    expect(procedures.map((p) => p.reference)).toEqual([
      '2023/0806(NLE)',
      '2023/0807(NLE)',
      '2023/0808(NLE)',
    ]);
    for (const procedure of procedures) expect(procedure.adopted_acts).toEqual(['32023D2641']);
  });

  it('skips a row that binds no procedure reference', async () => {
    const { procedures } = await read([
      { celexNumber: { type: 'literal', value: '32016R0679' } },
      row(flagged('2012/0011/COD', 'adopted')),
    ]);
    expect(procedures).toEqual([{ reference: '2012/0011(COD)', status: 'adopted' }]);
  });
});
