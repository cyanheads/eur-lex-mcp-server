/**
 * @fileoverview Tests for Commission document numbers and interinstitutional
 * procedure references (#179): the grammar `parsePreparatoryReference` reads, the
 * typed literals each lookup sends, and the one / several / none outcomes.
 * @module tests/services/preparatory-reference.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { CellarSparqlService } from '@/services/cellar-sparql/cellar-sparql-service.js';
import {
  buildCommissionDocumentQuery,
  buildProcedureQuery,
  commissionDocumentIds,
  type PreparatoryReference,
  type PreparatoryResolution,
  parsePreparatoryReference,
  preparatoryLabel,
  procedureReferenceLiterals,
  resolvePreparatoryReference,
} from '@/services/cellar-sparql/preparatory-reference.js';
import type { SparqlBinding } from '@/services/cellar-sparql/types.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS } from '../helpers/cpu-time.js';

const COM_2021_206 = {
  kind: 'document',
  series: 'COM',
  year: '2021',
  number: '0206',
  version: '',
} satisfies PreparatoryReference;
const PROCEDURE_2021_106 = {
  kind: 'procedure',
  year: '2021',
  number: '106',
  suffix: '',
  type: 'COD',
} satisfies PreparatoryReference;

describe('parsePreparatoryReference', () => {
  it.each<[string, PreparatoryReference]>([
    ['COM(2021) 206 final', COM_2021_206],
    ['COM(2021)206', COM_2021_206],
    ['COM(2021) 206', COM_2021_206],
    ['COM (2021) 0206', COM_2021_206],
    ['COM/2021/206 final', COM_2021_206],
    ['COM/2021/206', COM_2021_206],
    ['com(2021) 206 FINAL', COM_2021_206],
    ['COM(2021) 206 final.', COM_2021_206],
    ['  COM(2021)\n206   final ', COM_2021_206],
    [
      'COM(2020) 66',
      { kind: 'document', series: 'COM', year: '2020', number: '0066', version: '' },
    ],
    [
      'SWD(2021) 84 final',
      { kind: 'document', series: 'SWD', year: '2021', number: '0084', version: '' },
    ],
    [
      'JOIN(2020) 18 final',
      { kind: 'document', series: 'JOIN', year: '2020', number: '0018', version: '' },
    ],
    [
      'SEC(2008) 85',
      { kind: 'document', series: 'SEC', year: '2008', number: '0085', version: '' },
    ],
    [
      'COM(2021) 278 final/2',
      { kind: 'document', series: 'COM', year: '2021', number: '0278', version: '2' },
    ],
    [
      'COM(90) 314 final',
      { kind: 'document', series: 'COM', year: '1990', number: '0314', version: '' },
    ],
    [
      'COM(1972) 1581 final',
      { kind: 'document', series: 'COM', year: '1972', number: '1581', version: '' },
    ],
    ['2021/0106(COD)', PROCEDURE_2021_106],
    ['2021/106 (COD)', PROCEDURE_2021_106],
    ['2021/0106/COD', PROCEDURE_2021_106],
    ['2021/0106(cod)', PROCEDURE_2021_106],
    ['2021/0106(COD).', PROCEDURE_2021_106],
    ['2008/0264(CNS)', { kind: 'procedure', year: '2008', number: '264', suffix: '', type: 'CNS' }],
    [
      '2023/0077B(COD)',
      { kind: 'procedure', year: '2023', number: '77', suffix: 'B', type: 'COD' },
    ],
    ['2022/132a/cod', { kind: 'procedure', year: '2022', number: '132', suffix: 'A', type: 'COD' }],
    [
      '2013/2145(BUD)',
      { kind: 'procedure', year: '2013', number: '2145', suffix: '', type: 'BUD' },
    ],
    [
      '2021/2040(INI)',
      { kind: 'procedure', year: '2021', number: '2040', suffix: '', type: 'INI' },
    ],
  ])('parses %j', (text, expected) => {
    expect(parsePreparatoryReference(text)).toEqual(expected);
  });

  it.each([
    ['a Commission decision number', 'C(2021) 4500 final'],
    ['a Commission decision number without spaces', 'C(2021)4500'],
    ['a procedure without its type', '2021/0106'],
    ['a type before the numbers', 'COD/2021/0106'],
    ['a document number and a procedure together', 'COM(2021) 206 final – 2021/0106(COD)'],
    ['two document numbers', 'COM(2021) 206 final and COM(2021) 207 final'],
    ['no number', 'COM(2021)'],
    ['a five-digit number', 'COM(2021) 12345'],
    ['a three-digit year', 'COM(021) 206'],
    ['no year', 'COM 206 final'],
    ['two versions', 'COM(2021) 278 final/2/3'],
    ['a two-digit procedure year', '21/0106(COD)'],
    ['a four-letter type', '2021/0106(CODE)'],
    ['a two-letter type', '2021/0106(CO)'],
    ['two suffix letters', '2021/0106AB(COD)'],
    ['a CELEX', '52021PC0206'],
    ['an act citation', 'Regulation (EU) 2016/679'],
    ['an OJ reference', 'OJ L 119, 4.5.2016, p. 1'],
    ['an ECLI', 'ECLI:EU:C:2014:317'],
    ['a CELEX: prefix', 'CELEX:COM(2021)206'],
  ])('does not parse %s', (_label, text) => {
    expect(parsePreparatoryReference(text)).toBeUndefined();
  });

  it.each<[string, string]>([
    ['com(90) 314 final', 'COM(1990) 314 final'],
    ['COM(2021) 278 final/2', 'COM(2021) 278 final/2'],
    ['COM/2021/206', 'COM(2021) 206 final'],
    ['2021/106 (cod)', '2021/0106(COD)'],
    ['2022/132A/COD', '2022/0132A(COD)'],
  ])('labels %j as %j', (text, label) => {
    const reference = parsePreparatoryReference(text);
    if (!reference) throw new Error(`not a reference: ${text}`);
    expect(preparatoryLabel(reference)).toBe(label);
  });
});

describe('commissionDocumentIds', () => {
  it('sends the bare id and every part (01)–(99), each with _FIN', () => {
    const ids = commissionDocumentIds(COM_2021_206);

    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(ids.slice(0, 2)).toEqual(['comnat:COM_2021_0206_FIN', 'comnat:COM_2021_0206(01)_FIN']);
    expect(ids.at(-1)).toBe('comnat:COM_2021_0206(99)_FIN');
  });

  it('carries a later version as _FINn on the bare id and every part', () => {
    const reference = parsePreparatoryReference('COM(2021) 278 final/2');
    if (reference?.kind !== 'document') throw new Error('not a document number');
    const ids = commissionDocumentIds(reference);

    expect(ids[0]).toBe('comnat:COM_2021_0278_FIN2');
    expect(ids[1]).toBe('comnat:COM_2021_0278(01)_FIN2');
    expect(ids.every((id) => id.endsWith('_FIN2'))).toBe(true);
  });
});

describe('procedureReferenceLiterals', () => {
  it.each<[string, string[]]>([
    ['2021/106(COD)', ['2021/0106/COD', '2021/0106(COD)']],
    ['2013/2145(BUD)', ['2013/2145/BUD', '2013/2145(BUD)']],
    ['2022/132A(COD)', ['2022/0132A/COD', '2022/0132A(COD)', '2022/132A/COD', '2022/132A(COD)']],
    ['2023/0077B/COD', ['2023/0077B/COD', '2023/0077B(COD)', '2023/077B/COD', '2023/077B(COD)']],
    ['2019/1B(COD)', ['2019/0001B/COD', '2019/0001B(COD)', '2019/001B/COD', '2019/001B(COD)']],
    ['2018/1234A(NLE)', ['2018/1234A/NLE', '2018/1234A(NLE)']],
  ])('sends %j as %j', (text, literals) => {
    const reference = parsePreparatoryReference(text);
    if (reference?.kind !== 'procedure') throw new Error('not a procedure reference');
    expect(procedureReferenceLiterals(reference)).toEqual(literals);
  });
});

describe('query builders', () => {
  it('matches the typed comnat: ids in one VALUES list, never an owl:sameAs alias', () => {
    const query = buildCommissionDocumentQuery(COM_2021_206);

    expect(query).toContain('VALUES ?documentId {');
    expect(query).toContain('"comnat:COM_2021_0206_FIN"^^xsd:string');
    expect(query).toContain('"comnat:COM_2021_0206(99)_FIN"^^xsd:string');
    expect(query).toContain('?work cdm:work_id_document ?documentId');
    expect(query.match(/\^\^xsd:string/g)).toHaveLength(100);
    expect(query).not.toContain('sameAs');
  });

  it('matches the typed reference literals and reads an alias initiator through owl:sameAs', () => {
    const query = buildProcedureQuery(PROCEDURE_2021_106);

    expect(query).toContain(
      'VALUES ?reference { "2021/0106/COD"^^xsd:string "2021/0106(COD)"^^xsd:string }',
    );
    expect(query).toContain(
      '?dossier cdm:procedure_code_interinstitutional_reference_procedure ?reference',
    );
    expect(query).toContain('?dossier cdm:dossier_initiated_by_act_preparatory ?initiator');
    expect(query).toContain('<http://www.w3.org/2002/07/owl#sameAs> ?initiator');
    expect(query).not.toContain('resource/procedure');
  });
});

/** A fake service answering each query with the rows `answer` gives it. */
function fakeService(answer: (query: string) => SparqlBinding[]) {
  const query = vi.fn(async (q: string) => answer(q));
  return { svc: { query } as unknown as Pick<CellarSparqlService, 'query'>, query };
}

const literal = (value: string) => ({ type: 'literal', value });
const dossier = (id: string, celex?: string): SparqlBinding => ({
  dossier: { type: 'uri', value: `http://publications.europa.eu/resource/cellar/${id}` },
  ...(celex ? { celex: literal(celex) } : {}),
});

describe('resolvePreparatoryReference', () => {
  it.each<[string, string, SparqlBinding[], PreparatoryResolution]>([
    [
      'resolves the one work carrying a document number',
      'COM(2021) 206 final',
      [{ celex: literal('52021PC0206') }],
      { kind: 'one', celex: '52021PC0206' },
    ],
    [
      'resolves a CELEX two works share once',
      'COM(2021) 206 final',
      [{ celex: literal('52021PC0206') }, { celex: literal('52021PC0206') }],
      { kind: 'one', celex: '52021PC0206' },
    ],
    [
      'names a bare work and its parts, in CELEX order',
      'COM(90) 314 final',
      ['51990PC0314(02)', '51990DC0314', '51990PC0314(01)'].map((c) => ({ celex: literal(c) })),
      { kind: 'several', celex: ['51990DC0314', '51990PC0314(01)', '51990PC0314(02)'] },
    ],
    ['is a miss when no work carries the number', 'COM(2021) 9999 final', [], { kind: 'not_held' }],
    [
      'resolves the act that initiated the procedure',
      '2021/0106(COD)',
      [dossier('d1', '52021PC0206')],
      { kind: 'one', celex: '52021PC0206' },
    ],
    [
      'names the initiating act of every dossier holding the reference',
      '2000/0247(ACC)',
      [
        dossier('d1', '52000PC0641'),
        dossier('d2', '52000PC0609'),
        dossier('d3', '52000PC0640'),
        dossier('d4', '52000PC0616'),
      ],
      { kind: 'several', celex: ['52000PC0609', '52000PC0616', '52000PC0640', '52000PC0641'] },
    ],
    [
      'reads the one initiating act when another dossier has none',
      '2023/0077B(COD)',
      [dossier('d1'), dossier('d2', '52023PC0177')],
      { kind: 'one', celex: '52023PC0177' },
    ],
    [
      'reports a dossier with no initiating act',
      '2021/0053(COD)',
      [dossier('d1')],
      { kind: 'no_initiating_act' },
    ],
    ['is a miss when no dossier holds the reference', '2021/2040(INI)', [], { kind: 'not_held' }],
  ])('%s', async (_label, text, rows, expected) => {
    const reference = parsePreparatoryReference(text);
    if (!reference) throw new Error(`not a reference: ${text}`);
    const { svc, query } = fakeService(() => rows);

    await expect(resolvePreparatoryReference(svc, reference, createMockContext())).resolves.toEqual(
      expected,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain(
      reference.kind === 'document'
        ? 'cdm:work_id_document'
        : 'cdm:procedure_code_interinstitutional_reference_procedure',
    );
  });
});

/**
 * The parser runs on every identifier_type "auto" value. Each shape is timed in
 * thread CPU at every doubling from 5k to 320k characters, bounded at each size
 * before the next runs, with the full 64× span held under 256×: the two line-break
 * shapes, repeated `COM(` and `2021/` openers, a whitespace run the normalizer
 * collapses, a run of trailing words, and digit runs where each pattern reads its
 * number.
 */
describe('parsePreparatoryReference runs in linear time', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: [string, (n: number) => string][] = [
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ['a repeated COM( opener', (n) => 'COM('.repeat(n / 4)],
    ['a repeated year-and-slash run', (n) => '2021/'.repeat(n / 5)],
    ['a whitespace run before final', (n) => `COM(2021) 206${' '.repeat(n)}final`],
    ['a run of trailing finals', (n) => `COM(2021) 206${' final'.repeat(n / 6)}`],
    ['a digit run as the document number', (n) => `COM(2021) ${'1'.repeat(n)}`],
    ['a digit run as the procedure number', (n) => `2021/${'0'.repeat(n)}(COD)`],
  ];
  it.each(shapes)(
    '%s',
    async (_label, shape) => {
      const timings: number[] = [];
      for (const size of SIZES) {
        const text = shape(size);
        const cpu = await bestCpuMs(() => parsePreparatoryReference(text));
        expect(cpu, `${size} characters: ${cpu.toFixed(3)} ms CPU`).toBeLessThan(100);
        timings.push(cpu);
      }
      const [first = 0] = timings;
      const last = timings.at(-1) ?? 0;
      expect(last / Math.max(first, 0.01), JSON.stringify(timings)).toBeLessThan(256);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});
