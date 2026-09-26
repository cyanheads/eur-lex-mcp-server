/**
 * @fileoverview eurlex_get_document on case law (#117): the ECLI and the parsed
 * title in both channels, and the heading/operative-part outline and selection in
 * html, Markdown, and Formex, read through the real content service. CELLAR SPARQL
 * is mocked and `fetch` serves trimmed live bodies; no test touches the network.
 * @module tests/tools/eurlex-get-document.case-law.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurlex_get_document } from '@/mcp-server/tools/definitions/eurlex-get-document.tool.js';
import { parseCaseLawTitle } from '@/services/cellar-sparql/cdm-labels.js';
import { initEurLexContentService } from '@/services/eurlex-content/eurlex-content-service.js';
import { isResolutionQuery, resolutionRows } from '../fixtures/cellar-works.js';
import { AI_ACT_HEADINGS, actHtml } from '../fixtures/eurlex-act-headings.js';
import {
  AG_OPINION_COJ,
  JUDGMENT_CONVEX_DE,
  JUDGMENT_CONVEX_EN,
  JUDGMENT_CONVEX_FR,
  JUDGMENT_FORMEX,
  LEGACY_JUDGMENT,
  ORDER_WORD,
} from '../fixtures/eurlex-case-law.js';

const mockSparqlQuery = vi.fn();

vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({ query: mockSparqlQuery }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
    parseBoolean: () => undefined,
  },
}));

type Row = Record<string, { type: string; value: string }>;
const literal = (value: string) => ({ type: 'literal', value });

/** CELLAR's English title of `62012CJ0131`, read live. */
const GOOGLE_SPAIN_TITLE =
  'Judgment of the Court (Grand Chamber), 13 May 2014.#Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.#Request for a preliminary ruling from the Audiencia Nacional.#Personal data — Protection of individuals with regard to the processing of such data — Directive 95/46/EC — Articles 2, 4, 12 and 14 — Material and territorial scope — Internet search engines — Processing of data contained on websites — Searching for, indexing and storage of such data — Responsibility of the operator of the search engine — Establishment on the territory of a Member State — Extent of that operator’s obligations and of the data subject’s rights — Charter of Fundamental Rights of the European Union — Articles 7 and 8.#Case C‑131/12.';

/**
 * The leading segments of CELLAR's French title of `62012CJ0131`, read live (the
 * subject list is cut short). None has an English shape the parser reads.
 */
const GOOGLE_SPAIN_TITLE_FR =
  "Arrêt de la Cour (grande chambre) du 13 mai 2014.#Google Spain SL et Google Inc. contre Agencia Española de Protección de Datos (AEPD) et Mario Costeja González.#Demande de décision préjudicielle, introduite par l'Audiencia Nacional.#Données à caractère personnel – Protection des personnes physiques à l’égard du traitement de ces données – Directive 95/46/CE";

const GOOGLE_SPAIN_HEADINGS = [
  'Legal context',
  'The dispute in the main proceedings and the questions referred for a preliminary ruling',
  'Consideration of the questions referred',
  'Costs',
];

/** Bodies served per CELEX, keyed by the ISO 639-2/T language and the wire format. */
const BODIES: Record<string, Record<string, string>> = {
  '62012CJ0131': {
    'eng html': JUDGMENT_CONVEX_EN,
    'fra html': JUDGMENT_CONVEX_FR,
    'deu html': JUDGMENT_CONVEX_DE,
    'eng xml': JUDGMENT_FORMEX,
  },
  '62023CO0141': { 'eng html': ORDER_WORD },
  '62023CC0135': { 'eng html': AG_OPINION_COJ },
  '61962CJ0026': { 'eng html': LEGACY_JUDGMENT },
  '62024CJ0001': {
    'eng html': `<html><body>${'<p>A judgment body with no section markup at all.</p>'.repeat(4)}</body></html>`,
  },
  '32024R1689': { 'eng html': actHtml(AI_ACT_HEADINGS.EN) },
};

describe('eurlex_get_document on case law (#117)', () => {
  const mockFetch = vi.fn();
  /** The core metadata row the next call's CELLAR answers with. */
  let core: Row;

  beforeEach(() => {
    core = {};
    mockSparqlQuery.mockReset();
    mockSparqlQuery.mockImplementation(async (q: string) => {
      if (isResolutionQuery(q)) return resolutionRows(q);
      return q.includes('cdm:expression_belongs_to_work') ? [core] : [];
    });
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string, init: { headers: Record<string, string> }) => {
      const celex = decodeURIComponent(url.split('/').at(-1) ?? '');
      const wire = init.headers.Accept?.includes('fmx4') ? 'xml' : 'html';
      const body = BODIES[celex]?.[`${init.headers['Accept-Language']} ${wire}`];
      return Promise.resolve(
        body ? new Response(body, { status: 200 }) : new Response('not found', { status: 404 }),
      );
    });
    vi.stubGlobal('fetch', mockFetch);
    initEurLexContentService({} as AppConfig, {} as StorageService, {
      cellarSparqlEndpoint: 'http://publications.europa.eu/webapi/rdf/sparql',
      eurLexContentBaseUrl: 'http://publications.europa.eu',
      sparqlQueryTimeoutMs: 5_000,
      maxSparqlResults: 100,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = async (args: Record<string, unknown>) => {
    const response = await runToolContract(eurlex_get_document, args);
    const text = response.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    return { text, result: eurlex_get_document.output.parse(response.structuredContent) };
  };
  const coreQuery = () =>
    mockSparqlQuery.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes('cdm:expression_belongs_to_work')) ?? '';

  describe('metadata', () => {
    it('returns the ECLI and the title parsed into parties and fields, in both channels', async () => {
      core = {
        title: literal(GOOGLE_SPAIN_TITLE),
        date: literal('2014-05-13'),
        ecli: literal('ECLI:EU:C:2014:317'),
      };
      const { result, text } = await call({
        celex_number: '62012CJ0131',
        content_mode: 'metadata_only',
      });

      expect(result).toMatchObject({
        ecli: 'ECLI:EU:C:2014:317',
        title:
          'Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.',
        formation: 'Grand Chamber',
        referring_court: 'Audiencia Nacional',
        case_reference: 'Case C‑131/12.',
      });
      expect(result.subject_matter).toMatch(/^Personal data — Protection of individuals/);
      expect(text).toContain('## 62012CJ0131 — Google Spain SL and Google Inc. v Agencia Española');
      expect(text).toContain('**ECLI:** ECLI:EU:C:2014:317');
      expect(text).toContain('**Formation:** Grand Chamber');
      expect(text).toContain('**Referring court:** Audiencia Nacional');
      expect(text).toContain('**Subject matter:** Personal data — Protection');
      expect(text).toContain('**Case reference:** Case C‑131/12.');
      expect(text).not.toContain('#Google Spain');
    });

    it('reads the ECLI of the resolved work, else the lowest of any work of the CELEX', async () => {
      core = { anyEcli: literal('ECLI:EU:C:2014:317') };
      const { result } = await call({ celex_number: '62012CJ0131', content_mode: 'metadata_only' });
      expect(result.ecli).toBe('ECLI:EU:C:2014:317');

      const query = coreQuery();
      expect(query).toContain('cdm:case-law_ecli ?ownEcli');
      expect(query).toContain('?celexWork cdm:resource_legal_id_celex "62012CJ0131"^^xsd:string');
      expect(query).toContain('(MIN(STR(?celexEcli)) AS ?anyEcli)');
    });

    it('parses the English title in any language, since the parser reads English shapes only (#133)', async () => {
      expect(parseCaseLawTitle(GOOGLE_SPAIN_TITLE_FR, '2014-05-13')).toMatchObject({
        complete: false,
      });
      expect(parseCaseLawTitle(GOOGLE_SPAIN_TITLE_FR, '2014-05-13')).not.toHaveProperty(
        'formation',
      );
      expect(parseCaseLawTitle(GOOGLE_SPAIN_TITLE_FR, '2014-05-13')).not.toHaveProperty(
        'referringCourt',
      );

      core = {
        title: literal(GOOGLE_SPAIN_TITLE),
        languageTitle: literal(GOOGLE_SPAIN_TITLE_FR),
        date: literal('2014-05-13'),
      };
      const { result } = await call({
        celex_number: '62012CJ0131',
        language: 'fr',
        content_mode: 'metadata_only',
      });

      expect(result).toMatchObject({
        title:
          'Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.',
        formation: 'Grand Chamber',
        referring_court: 'Audiencia Nacional',
        case_reference: 'Case C‑131/12.',
      });
      expect(coreQuery()).toContain('/language/FRA>');
    });

    it('leaves a French case title raw and unparsed when CELLAR records no English one', async () => {
      core = { languageTitle: literal(GOOGLE_SPAIN_TITLE_FR), date: literal('2014-05-13') };
      const { result } = await call({
        celex_number: '62012CJ0131',
        language: 'fr',
        content_mode: 'metadata_only',
      });

      expect(result.title).toBe(GOOGLE_SPAIN_TITLE_FR);
      for (const field of ['formation', 'referring_court', 'subject_matter', 'case_reference']) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it('keeps the raw title when the parse is incomplete, and still fills the fields', async () => {
      core = { title: literal(GOOGLE_SPAIN_TITLE), date: literal('2014-05-14') };
      const { result } = await call({ celex_number: '62012CJ0131', content_mode: 'metadata_only' });
      expect(result.title).toBe(GOOGLE_SPAIN_TITLE);
      expect(result.formation).toBe('Grand Chamber');
      expect(result.case_reference).toBe('Case C‑131/12.');
    });

    it('asks legislation for no ECLI and leaves its title as CELLAR stores it', async () => {
      core = { title: literal('Regulation (EU) 2024/1689#of the European Parliament') };
      const { result, text } = await call({
        celex_number: '32024R1689',
        content_mode: 'metadata_only',
      });
      expect(coreQuery()).not.toContain('case-law_ecli');
      expect(result.title).toBe('Regulation (EU) 2024/1689#of the European Parliament');
      for (const field of [
        'ecli',
        'formation',
        'referring_court',
        'subject_matter',
        'case_reference',
      ]) {
        expect(result).not.toHaveProperty(field);
      }
      expect(text).not.toContain('**ECLI:**');
    });
  });

  describe('outline', () => {
    const OUTLINE = [
      ...GOOGLE_SPAIN_HEADINGS.map((label, i) => ({
        kind: 'heading',
        number: String(i + 1),
        label,
      })),
      { kind: 'operative_part', number: '', label: 'Operative part' },
    ];

    it.each(['html', 'markdown', 'xml'])(
      'lists the headings and the operative part of 62012CJ0131 in %s',
      async (format) => {
        const { result, text } = await call({ celex_number: '62012CJ0131', format, outline: true });
        expect(result.outline).toMatchObject(OUTLINE);
        expect(result.structure_detected).toBe(true);
        expect(text).toContain('] Legal context');
        expect(text).toMatch(
          /\[heading 4\] Costs\n- `offset \d+` — \[operative_part\] Operative part/,
        );
      },
    );

    it.each([
      [
        'FR',
        [
          'Le cadre juridique',
          'Le litige au principal et les questions préjudicielles',
          'Sur les questions préjudicielles',
          'Sur les dépens',
        ],
        'Par ces motifs, la Cour (grande chambre) dit pour droit:',
      ],
      [
        'DE',
        [
          'Rechtlicher Rahmen',
          'Ausgangsverfahren und Vorlagefragen',
          'Zu den Vorlagefragen',
          'Kosten',
        ],
        'Aus diesen Gründen hat der Gerichtshof (Große Kammer) für Recht erkannt:',
      ],
    ])(
      'reads the %s body in its own words, in html and Markdown',
      async (language, labels, ruling) => {
        for (const format of ['html', 'markdown']) {
          const { result } = await call({
            celex_number: '62012CJ0131',
            language,
            format,
            outline: true,
          });
          expect(result.language).toBe(language);
          expect(result.outline?.map((h) => h.label)).toEqual([...labels, 'Operative part']);
        }
        const { result } = await call({
          celex_number: '62012CJ0131',
          language,
          format: 'markdown',
          select: { operative_part: true },
        });
        expect(result.content?.startsWith(ruling)).toBe(true);
      },
    );

    it('lists an order’s operative part alone', async () => {
      const { result } = await call({ celex_number: '62023CO0141', outline: true });
      expect(result.outline).toMatchObject([{ kind: 'operative_part', label: 'Operative part' }]);
      const { result: ruling } = await call({
        celex_number: '62023CO0141',
        select: { operative_part: true },
      });
      expect(ruling.content).toMatch(
        /^<P class="C41DispositifIntroduction">On those grounds, the Vice-President of the Court of Justice hereby orders:/,
      );
    });

    it('gives an AG opinion its headings and no operative part', async () => {
      const { result } = await call({
        celex_number: '62023CC0135',
        format: 'markdown',
        outline: true,
      });
      expect(result.outline?.map((h) => h.label)).toEqual([
        'Introduction',
        'Legal context',
        'Facts, procedure and question referred for a preliminary ruling',
        'Analysis',
        'Conclusion',
      ]);
    });

    it('places the legacy operative part at its section, not its contents link', async () => {
      const { result } = await call({ celex_number: '61962CJ0026', outline: true });
      const operative = result.outline?.at(-1);
      expect(operative?.kind).toBe('operative_part');
      expect(LEGACY_JUDGMENT.slice(operative!.offset)).toMatch(/^<a name="DI"\/><h2>/);
    });

    it('says so in the text channel when a case-law body carries no structure', async () => {
      const { result, text } = await call({ celex_number: '62024CJ0001', outline: true });
      expect(result.outline).toEqual([]);
      expect(result.structure_detected).toBe(false);
      expect(text).toContain('*No section headings or operative part detected in the');
      expect(text).not.toContain('No act structure detected');
    });
  });

  describe('select', () => {
    it('returns the ruling without the costs paragraph, on both surfaces', async () => {
      const { result, text } = await call({
        celex_number: '62012CJ0131',
        select: { operative_part: true },
      });
      expect(result.selection).toEqual({
        requested: ['Operative part'],
        matched: ['Operative part'],
        missed: [],
      });
      expect(result.content).toContain('On those grounds, the Court (Grand Chamber) hereby rules:');
      expect(result.content).not.toContain('Since these proceedings');
      expect(result.selected_sections?.[0]).toMatchObject({ label: 'Operative part' });
      expect(text).toContain('Returned: Operative part.');
    });

    it('ends a headed section before the next heading, in Markdown', async () => {
      const { result } = await call({
        celex_number: '62012CJ0131',
        format: 'markdown',
        select: { headings: '2' },
      });
      expect(result.selection).toEqual({
        requested: ['Heading 2'],
        matched: [GOOGLE_SPAIN_HEADINGS[1]],
        missed: [],
      });
      expect(result.content?.startsWith(GOOGLE_SPAIN_HEADINGS[1]!)).toBe(true);
      expect(result.content).not.toContain('Consideration of the questions referred');
    });

    it('reports a missed case-law section in the document’s terms', async () => {
      const { result, text } = await call({
        celex_number: '62023CC0135',
        select: { headings: '9', operative_part: true },
      });
      expect(result.selection?.missed).toEqual(['Heading 9', 'Operative part']);
      expect(text).toContain(
        'Not found: Heading 9, Operative part — no such section in this document',
      );
    });

    it('leaves an act’s selection as it was', async () => {
      const { result, text } = await call({
        celex_number: '32024R1689',
        select: { articles: '1', headings: '1', operative_part: true },
      });
      expect(result.selection).toEqual({
        requested: ['Article 1', 'Heading 1', 'Operative part'],
        matched: ['Article 1'],
        missed: ['Heading 1', 'Operative part'],
      });
      expect(text).toContain('no such section in this act');
    });
  });
});
