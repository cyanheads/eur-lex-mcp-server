/**
 * @fileoverview Heading markup of Regulation (EU) 2024/1689 (`32024R1689`) in each
 * of the 24 EUR-Lex languages, copied from the CELLAR XHTML of each language
 * version: the inner HTML of the first two article headings (`oj-ti-art`), of the
 * Chapter I and Chapter IV headings, of the first section heading, and of the
 * Annex I heading. Chapter IV rather than II because the Greek version writes it
 * with a Greek capital iota (`ΚΕΦΑΛΑΙΟ ΙV`), as it does Annex I (`ΠΑΡΑΡΤΗΜΑ Ι`).
 * {@link actHtml} lays them out as CONVEX does, one heading per line with the
 * section keyword on its own line inside an `oj-italic` span. A recorded snapshot,
 * not refreshed against the live network.
 * @module tests/fixtures/eurlex-act-headings
 */

import type { EurLexLanguage } from '@/services/eurlex-content/eurlex-content-service.js';

/** One language version's heading markup, as served. */
export interface ActHeadingMarkup {
  annex1: string;
  article1: string;
  article2: string;
  chapter1: string;
  chapter4: string;
  section1: string;
}

export const AI_ACT_HEADINGS: Record<EurLexLanguage, ActHeadingMarkup> = {
  EN: {
    article1: 'Article 1',
    article2: 'Article 2',
    chapter1: 'CHAPTER I',
    chapter4: 'CHAPTER IV',
    section1: 'SECTION 1',
    annex1: 'ANNEX I',
  },
  FR: {
    article1: 'Article premier',
    article2: 'Article 2',
    chapter1: 'CHAPITRE I',
    chapter4: 'CHAPITRE IV',
    section1: 'SECTION 1',
    annex1: 'ANNEXE I',
  },
  DE: {
    article1: 'Artikel 1',
    article2: 'Artikel 2',
    chapter1: 'KAPITEL I',
    chapter4: 'KAPITEL IV',
    section1: 'ABSCHNITT 1',
    annex1: 'ANHANG I',
  },
  ES: {
    article1: 'Artículo 1',
    article2: 'Artículo 2',
    chapter1: 'CAPÍTULO I',
    chapter4: 'CAPÍTULO IV',
    section1: 'SECCIÓN 1',
    annex1: 'ANEXO I',
  },
  IT: {
    article1: 'Articolo 1',
    article2: 'Articolo 2',
    chapter1: 'CAPO I',
    chapter4: 'CAPO IV',
    section1: 'SEZIONE 1',
    annex1: 'ALLEGATO I',
  },
  PL: {
    article1: 'Artykuł 1',
    article2: 'Artykuł 2',
    chapter1: 'ROZDZIAŁ I',
    chapter4: 'ROZDZIAŁ IV',
    section1: 'SEKCJA 1',
    annex1: 'ZAŁĄCZNIK I',
  },
  PT: {
    article1: 'Artigo 1.<span class="oj-super">o</span>',
    article2: 'Artigo 2.<span class="oj-super">o</span>',
    chapter1: 'CAPÍTULO I',
    chapter4: 'CAPÍTULO IV',
    section1: 'SECÇÃO 1',
    annex1: 'ANEXO I',
  },
  NL: {
    article1: 'Artikel 1',
    article2: 'Artikel 2',
    chapter1: 'HOOFDSTUK I',
    chapter4: 'HOOFDSTUK IV',
    section1: 'AFDELING 1',
    annex1: 'BIJLAGE I',
  },
  CS: {
    article1: 'Článek 1',
    article2: 'Článek 2',
    chapter1: 'KAPITOLA I',
    chapter4: 'KAPITOLA IV',
    section1: 'ODDÍL 1',
    annex1: 'PŘÍLOHA I',
  },
  DA: {
    article1: 'Artikel 1',
    article2: 'Artikel 2',
    chapter1: 'KAPITEL I',
    chapter4: 'KAPITEL IV',
    section1: 'AFDELING 1',
    annex1: 'BILAG I',
  },
  EL: {
    article1: 'Άρθρο 1',
    article2: 'Άρθρο 2',
    chapter1: 'ΚΕΦΑΛΑΙΟ I',
    chapter4: 'ΚΕΦΑΛΑΙΟ ΙV',
    section1: 'ΤΜΗΜΑ 1',
    annex1: 'ΠΑΡΑΡΤΗΜΑ Ι',
  },
  ET: {
    article1: 'Artikkel 1',
    article2: 'Artikkel 2',
    chapter1: 'I PEATÜKK',
    chapter4: 'IV PEATÜKK',
    section1: '1. JAGU',
    annex1: 'I LISA',
  },
  FI: {
    article1: '1 artikla',
    article2: '2 artikla',
    chapter1: 'I LUKU',
    chapter4: 'IV LUKU',
    section1: '1 JAKSO',
    annex1: 'LIITE I',
  },
  HU: {
    article1: '1. cikk',
    article2: '2. cikk',
    chapter1: 'I. FEJEZET',
    chapter4: 'IV. FEJEZET',
    section1: '1. SZAKASZ',
    annex1: 'I. MELLÉKLET',
  },
  LT: {
    article1: '1 straipsnis',
    article2: '2 straipsnis',
    chapter1: 'I SKYRIUS',
    chapter4: 'IV SKYRIUS',
    section1: '1 SKIRSNIS',
    annex1: 'I PRIEDAS',
  },
  LV: {
    article1: '1. pants',
    article2: '2. pants',
    chapter1: 'I NODAĻA',
    chapter4: 'IV NODAĻA',
    section1: '1. IEDAĻA',
    annex1: 'I PIELIKUMS',
  },
  MT: {
    article1: 'Artikolu 1',
    article2: 'Artikolu 2',
    chapter1: 'KAPITOLU I',
    chapter4: 'KAPITOLU IV',
    section1: 'TAQSIMA 1',
    annex1: 'ANNESS I',
  },
  RO: {
    article1: 'Articolul 1',
    article2: 'Articolul 2',
    chapter1: 'CAPITOLUL I',
    chapter4: 'CAPITOLUL IV',
    section1: 'SECȚIUNEA 1',
    annex1: 'ANEXA I',
  },
  SK: {
    article1: 'Článok 1',
    article2: 'Článok 2',
    chapter1: 'KAPITOLA I',
    chapter4: 'KAPITOLA IV',
    section1: 'ODDIEL 1',
    annex1: 'PRÍLOHA I',
  },
  SL: {
    article1: 'Člen 1',
    article2: 'Člen 2',
    chapter1: 'POGLAVJE I',
    chapter4: 'POGLAVJE IV',
    section1: 'ODDELEK 1',
    annex1: 'PRILOGA I',
  },
  SV: {
    article1: 'Artikel 1',
    article2: 'Artikel 2',
    chapter1: 'KAPITEL I',
    chapter4: 'KAPITEL IV',
    section1: 'AVSNITT 1',
    annex1: 'BILAGA I',
  },
  BG: {
    article1: 'Член 1',
    article2: 'Член 2',
    chapter1: 'ГЛАВА I',
    chapter4: 'ГЛАВА IV',
    section1: 'РАЗДЕЛ 1',
    annex1: 'ПРИЛОЖЕНИЕ I',
  },
  HR: {
    article1: 'Članak 1.',
    article2: 'Članak 2.',
    chapter1: 'POGLAVLJE I.',
    chapter4: 'POGLAVLJE IV.',
    section1: 'ODJELJAK 1.',
    annex1: 'PRILOG I.',
  },
  GA: {
    article1: 'Airteagal 1',
    article2: 'Airteagal 2',
    chapter1: 'CAIBIDIL I',
    chapter4: 'CAIBIDIL IV',
    section1: 'ROINN 1',
    annex1: 'IARSCRÍBHINN I',
  },
};

/**
 * A miniature act in one language: two preamble recitals, Chapter I holding
 * Section 1 and Articles 1–2, Chapter IV, and Annex I. Body lines are unique so a
 * selection's text shows which sections it spans.
 */
export function actHtml(h: ActHeadingMarkup): string {
  return [
    '<html><body>',
    '<p class="oj-doc-ti">REGULATION (EU) 2024/1689</p>',
    '<p class="oj-normal">(1)</p>',
    '<p class="oj-normal">Recital one.</p>',
    '<p class="oj-normal">(2)</p>',
    '<p class="oj-normal">Recital two.</p>',
    `<p class="oj-ti-section-1">${h.chapter1}</p>`,
    '<p class="oj-ti-section-2">General provisions</p>',
    '<p class="oj-ti-section-1">',
    `<span class="oj-italic">${h.section1}</span>`,
    '</p>',
    '<p class="oj-ti-section-2">Classification</p>',
    `<p class="oj-ti-art">${h.article1}</p>`,
    '<p class="oj-sti-art">Subject matter</p>',
    '<p class="oj-normal">Body one.</p>',
    `<p class="oj-ti-art">${h.article2}</p>`,
    '<p class="oj-sti-art">Scope</p>',
    '<p class="oj-normal">Body two.</p>',
    `<p class="oj-ti-section-1">${h.chapter4}</p>`,
    '<p class="oj-ti-section-2">Transparency</p>',
    '<p class="oj-normal">Body four.</p>',
    `<p class="oj-doc-ti">${h.annex1}</p>`,
    '<p class="oj-doc-ti">List of legislation</p>',
    '<p class="oj-normal">Annex body.</p>',
    '</body></html>',
  ].join('\n');
}
