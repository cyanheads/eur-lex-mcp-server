/**
 * @fileoverview Tests for CDM label resolvers and the case-law title parser.
 * @module tests/services/cdm-labels.test
 */

import { describe, expect, it } from 'vitest';
import {
  parseCaseLawTitle,
  resolveResourceTypeLabel,
  resolveResourceTypeLabels,
} from '@/services/cellar-sparql/cdm-labels.js';

/**
 * Fixtures are verbatim CELLAR `expression_title` strings captured from the live
 * SPARQL endpoint, chosen to cover the format drift the parser must survive:
 * modern 4-segment judgments, 5-segment preliminary-ruling judgments (with an
 * extra "Request for a preliminary ruling from …" provenance segment), sparse AG
 * opinions (empty trailing segments), and older 3/4-segment records.
 */

// Modern 4-segment judgment: {court+date}#{parties}#{subject}#{case reference}. (issue #40 example)
const WHATSAPP =
  'Judgment of the Court (Grand Chamber) of 10 February 2026.#WhatsApp Ireland Ltd v European Data Protection Board.#Appeal – Protection of natural persons with regard to the processing of personal data – Regulation (EU) 2016/679 – Article 63 – Consistency mechanism – Article 65 – Dispute resolution by the European Data Protection Board.#Case C-97/23 P.';

// 5-segment preliminary-ruling judgment: an extra provenance segment sits between
// parties and the subject-matter keyword list.
const PRELIMINARY_RULING =
  'Judgment of the Court (Grand Chamber) of 21 March 2024.#RL v Landeshauptstadt Wiesbaden.#Request for a preliminary ruling from the Verwaltungsgericht Wiesbaden.#Reference for a preliminary ruling – Regulation (EU) 2019/1157 – Strengthening the security of identity cards of EU citizens – Article 7 of the Charter of Fundamental Rights of the European Union.#Case C-61/22.';

// AG opinion: parties/subject/reference segments are all empty ("…delivered on DATE.###").
const AG_OPINION = 'Opinion of Advocate General Richard de la Tour delivered on 2 July 2026.###';

// Older 3-segment judgment: no subject-matter segment at all.
const OLD_3_SEGMENT =
  'Judgment of the Court of 10 December 1968.#Commission of the European Communities v Italian Republic.#Case 7-68.';

// Older 4-segment judgment: the middle segment is a referring-court provenance
// note (colon form), and the case number uses the legacy hyphen style.
const OLD_4_SEGMENT =
  'Judgment of the Court of 19 December 1968.#Giovanni de Cicco v Landesversicherungsanstalt Schwaben.#Reference for a preliminary ruling: Sozialgericht Augsburg - Germany.#Case 19-68.';

// Joined-cases judgment: CELLAR titles a judgment covering multiple joined cases
// with a PLURAL trailing reference ("Cases X and Y.") rather than the singular
// "Case …". Verbatim expression_title for CELEX 62024TJ0318 (issue #42).
const JOINED_CASES =
  'Judgment of the General Court (Tenth Chamber) of 3 December 2025.#WS v European Commission.#Processing of personal data – Protection of natural persons with regard to the processing of personal data by the Union institutions, bodies, offices and agencies – Regulation (EU) 2018/1725 – Requests made to EPSO concerning access to and processing of personal data – Error of law.#Cases T-318/24 and T-362/24.';

describe('parseCaseLawTitle', () => {
  it('parses a modern 4-segment judgment into parties, subject matter, and case reference', () => {
    const parsed = parseCaseLawTitle(WHATSAPP);
    expect(parsed.parties).toBe('WhatsApp Ireland Ltd v European Data Protection Board.');
    expect(parsed.displayTitle).toBe('WhatsApp Ireland Ltd v European Data Protection Board.');
    expect(parsed.caseReference).toBe('Case C-97/23 P.');
    expect(parsed.subjectMatter).toContain('Protection of natural persons');
    // The subject matter is the keyword segment, not the court/date descriptor.
    expect(parsed.subjectMatter).not.toContain('Judgment of the Court');
  });

  it('parses a plural joined-cases reference and the true subject matter (issue #42)', () => {
    const parsed = parseCaseLawTitle(JOINED_CASES);
    expect(parsed.parties).toBe('WS v European Commission.');
    expect(parsed.displayTitle).toBe('WS v European Commission.');
    // The trailing segment is the PLURAL "Cases …" joined-case reference — a
    // singular-only /^Case\b/ anchor missed it (\b never asserts between "Case"
    // and "s"), leaving case_reference unset and subject_matter holding the list.
    expect(parsed.caseReference).toBe('Cases T-318/24 and T-362/24.');
    // Subject matter resolves to the real legal-topic segment (immediately before
    // the case reference), NOT the joined-case list.
    expect(parsed.subjectMatter).toBe(
      'Processing of personal data – Protection of natural persons with regard to the processing of personal data by the Union institutions, bodies, offices and agencies – Regulation (EU) 2018/1725 – Requests made to EPSO concerning access to and processing of personal data – Error of law.',
    );
    expect(parsed.subjectMatter).not.toContain('Cases T-318/24');
  });

  it('skips the provenance segment in a 5-segment preliminary-ruling title', () => {
    const parsed = parseCaseLawTitle(PRELIMINARY_RULING);
    expect(parsed.parties).toBe('RL v Landeshauptstadt Wiesbaden.');
    expect(parsed.displayTitle).toBe('RL v Landeshauptstadt Wiesbaden.');
    expect(parsed.caseReference).toBe('Case C-61/22.');
    // Subject matter is the keyword list (immediately before the case reference),
    // NOT the "Request for a preliminary ruling from …" provenance segment.
    expect(parsed.subjectMatter).toContain('Reference for a preliminary ruling – Regulation');
    expect(parsed.subjectMatter).not.toContain('Request for a preliminary ruling from');
  });

  it('degrades gracefully on a sparse AG-opinion title (empty parties/subject/reference)', () => {
    const parsed = parseCaseLawTitle(AG_OPINION);
    // The parties, subject, and reference segments are empty — none are fabricated.
    expect(parsed.parties).toBeUndefined();
    expect(parsed.subjectMatter).toBeUndefined();
    expect(parsed.caseReference).toBeUndefined();
    // The display title falls back to the leading court/AG descriptor (clean, no "#").
    expect(parsed.displayTitle).toBe(
      'Opinion of Advocate General Richard de la Tour delivered on 2 July 2026.',
    );
  });

  it('leaves subject matter unset for a 3-segment title with no subject segment', () => {
    const parsed = parseCaseLawTitle(OLD_3_SEGMENT);
    expect(parsed.parties).toBe('Commission of the European Communities v Italian Republic.');
    expect(parsed.displayTitle).toBe('Commission of the European Communities v Italian Republic.');
    expect(parsed.caseReference).toBe('Case 7-68.');
    expect(parsed.subjectMatter).toBeUndefined();
  });

  it('parses parties and legacy-numbered case reference from an older 4-segment title', () => {
    const parsed = parseCaseLawTitle(OLD_4_SEGMENT);
    expect(parsed.parties).toBe('Giovanni de Cicco v Landesversicherungsanstalt Schwaben.');
    expect(parsed.displayTitle).toBe('Giovanni de Cicco v Landesversicherungsanstalt Schwaben.');
    expect(parsed.caseReference).toBe('Case 19-68.');
  });

  it('returns only an incomplete verdict for a plain title with no "#" delimiter', () => {
    expect(parseCaseLawTitle('Google Spain SL v AEPD')).toEqual({ complete: false });
  });

  it('returns only an incomplete verdict for empty or undefined input', () => {
    expect(parseCaseLawTitle('')).toEqual({ complete: false });
    expect(parseCaseLawTitle(undefined)).toEqual({ complete: false });
  });

  it('does not treat a trailing non-"Case" segment as a case reference', () => {
    // Only a segment with the "Case …" shape becomes the case reference; a stray
    // trailing segment is left as subject matter rather than mislabelled.
    const parsed = parseCaseLawTitle(
      'Judgment of the Court of 1 January 2020.#A v B.#Some subject – keywords.',
    );
    expect(parsed.parties).toBe('A v B.');
    expect(parsed.caseReference).toBeUndefined();
    expect(parsed.subjectMatter).toBe('Some subject – keywords.');
  });
});

/**
 * CELLAR titles and record dates (live, 2026-09-25; some keyword segments
 * shortened, every other segment verbatim) for the shared parser
 * contract of #116: formation, referring court, Advocate General, the joined-case
 * reference, and the complete-parse verdict that decides whether a caller may drop
 * the raw title.
 */
const GOOGLE_SPAIN_SUBJECT =
  'Personal data — Protection of individuals with regard to the processing of such data — Directive 95/46/EC — Articles 2, 4, 12 and 14 — Material and territorial scope — Internet search engines — Processing of data contained on websites — Searching for, indexing and storage of such data — Responsibility of the operator of the search engine — Establishment on the territory of a Member State — Extent of that operator’s obligations and of the data subject’s rights — Charter of Fundamental Rights of the European Union — Articles 7 and 8.';
const GOOGLE_SPAIN_PARTIES =
  'Google Spain SL and Google Inc. v Agencia Española de Protección de Datos (AEPD) and Mario Costeja González.';
const GOOGLE_SPAIN_TAIL = `#${GOOGLE_SPAIN_PARTIES}#Request for a preliminary ruling from the Audiencia Nacional.#${GOOGLE_SPAIN_SUBJECT}#Case C‑131/12.`;
/** 62012CJ0131, dated 2014-05-13 — the comma date form. */
const GOOGLE_SPAIN_JUDGMENT = `Judgment of the Court (Grand Chamber), 13 May 2014.${GOOGLE_SPAIN_TAIL}`;
/** 62012CC0131, dated 2013-06-25. */
const GOOGLE_SPAIN_OPINION = `Opinion of Advocate General Jääskinen delivered on 25 June 2013.${GOOGLE_SPAIN_TAIL}`;
/** 62014CJ0443, dated 2016-03-01. */
const ALO_JOINED =
  'Judgment of the Court (Grand Chamber) of 1 March 2016.#Kreis Warendorf v Ibrahim Alo and Amira Osso v and Region Hannover.#Requests for a preliminary ruling from the Bundesverwaltungsgericht.#Reference for a preliminary ruling — Convention relating to the Status of Refugees, signed in Geneva on 28 July 1951 — Articles 23 and 26 — Area of freedom, security and justice.#Joined Cases C-443/14 and C-444/14.';
/** 61985CO0082, dated 1985-04-22. */
const EURASIAN_ORDER =
  'Order of the President of the Court of 22 April 1985.#Eurasian Corporation Ltd v Commission of the European Communities.#Application for the adoption of interim measures.#Joined cases 82/85 R and 83/85 R.';
/** 62025TJ0069, dated 2026-02-25 — a General Court preliminary ruling. */
const GC_PRELIMINARY =
  'Judgment of the General Court (Fifth Chamber, Extended Composition) of 25 February 2026.#A GmbH v Hauptzollamt C.#Request for a preliminary ruling from the Bundesfinanzhof.#Reference for a preliminary ruling – Customs union – Common Customs Tariff – Tariff classification.#Case T-69/25.';
/** 61985CO0069, dated 1986-03-05 — a referral segment with no keyword segment after it. */
const WUNSCHE_ORDER =
  'Order of the Court of 5 March 1986.#Wünsche Handelsgesellschaft GmbH & Co. v Federal Republic of Germany.#Reference for a preliminary ruling: Verwaltungsgericht Frankfurt am Main - Germany.#Case 69/85.';
/** 61962CJ0026, dated 1963-02-05 — pre-chamber descriptor. */
const VAN_GEND =
  'Judgment of the Court of 5 February 1963.#NV Algemene Transport- en Expeditie Onderneming van Gend & Loos v Netherlands Inland Revenue Administration.#Reference for a preliminary ruling: Tariefcommissie - Netherlands.#Case 26-62.';
/** 62019CJ0130, dated 2021-09-30 — a direct action before the Full Court. */
const PINXTEN_FULL_COURT =
  'Judgment of the Court (Full Court) of 30 September 2021.#European Court of Auditors v Karel Pinxten.#Article 286(6) TFEU – Breach of obligations arising from the office of Member of the European Court of Auditors.#Case C-130/19.';
/** 62019CJ0470, dated 2021-04-15 — the dash form is a keyword list, not a referral. */
const DASH_REFERENCE =
  'Judgment of the Court (First Chamber) of 15 April 2021.#Friends of the Irish Environment Ltd v Commissioner for Environmental Information.#Reference for a preliminary ruling – Aarhus Convention – Directive 2003/4/EC.#Case C-470/19.';
/** 62014TJ0353, dated 2016-09-15 — "(Extracts)" after the date. */
const EXTRACTS =
  'Judgment of the General Court (Eighth Chamber) of 15 September 2016 (Extracts).#Italian Republic v European Commission.#Rules on languages — Notices of open competition.#Cases T-353/14 and T-17/15.';
/** 62014CO0078(01), dated 2014-04-08. */
const VICE_PRESIDENT_ORDER =
  'Order of the Vice-President of the Court, 8 April 2014.#European Commission v ANKO AE Antiprosopeion, Emporiou kai Viomichanias.#Application for interim measures — Appeals.#Case C‑78/14 P-R.';
/** 61985CO0074, dated 1985-03-29. */
const CHAMBER_PRESIDENT_ORDER =
  'Order of the President of the Second Chamber of the Court of 29 March 1985.#Jaqueline Remy v Commission of the European Communities.#Officials - Suspension of the operation of a decision.#Case 74/85 R.';
/** 62014CO0123, dated 2015-07-15 — CELLAR's own typo in the referral's first word. */
const REQEUST_TYPO =
  'Order of the Court (Tenth Chamber) of 15 July 2015.#"Itales" OOD v Direktor na Direktsia.#Reqeust for a preliminary ruling from the Administrativen sad - Varna.#Reference for a preliminary ruling — Taxation — VAT.#Case C-123/14.';
/** 62014CC0080, dated 2015-02-05 — a leading segment of no known shape. */
const USDAW_OPINION =
  'Advocate General’s Opinion - 5 February 2015#USDAW and Wilson#Case C-80/14#Advocate General: Wahl';
/** 62019CJ0793, a work dated 2022-10-27 whose title dates the judgment 20 September 2022. */
const SPACENET =
  'Judgment of the Court (Grand Chamber) of 20 September 2022.#Bundesrepublik Deutschland v SpaceNet AG and Telekom Deutschland GmbH.#Requests for a preliminary ruling from the Bundesverwaltungsgericht.#Reference for a preliminary ruling – Processing of personal data.#Joined Cases C-793/19 and C-794/19.';

describe('parseCaseLawTitle — shared contract (#116)', () => {
  it('decomposes the C-131/12 judgment completely, formation and referring court included', () => {
    expect(parseCaseLawTitle(GOOGLE_SPAIN_JUDGMENT, '2014-05-13')).toEqual({
      complete: true,
      formation: 'Grand Chamber',
      displayTitle: GOOGLE_SPAIN_PARTIES,
      parties: GOOGLE_SPAIN_PARTIES,
      referringCourt: 'Audiencia Nacional',
      subjectMatter: GOOGLE_SPAIN_SUBJECT,
      caseReference: 'Case C‑131/12.',
    });
  });

  it('reads the Advocate General of the C-131/12 opinion and names no formation', () => {
    const parsed = parseCaseLawTitle(GOOGLE_SPAIN_OPINION, '2013-06-25');
    expect(parsed.advocateGeneral).toBe('Jääskinen');
    expect(parsed.referringCourt).toBe('Audiencia Nacional');
    expect(parsed.formation).toBeUndefined();
    expect(parsed.complete).toBe(true);
  });

  it('reads the Advocate General of a "Mr" opinion and a sparse one', () => {
    expect(
      parseCaseLawTitle('Opinion of Mr Advocate General Lenz delivered on 12 March 1986.###')
        .advocateGeneral,
    ).toBe('Lenz');
    expect(parseCaseLawTitle(AG_OPINION, '2026-07-02')).toMatchObject({
      advocateGeneral: 'Richard de la Tour',
      complete: true,
    });
  });

  it('parses a "Joined Cases" reference and keeps the keyword segment as subject matter', () => {
    const parsed = parseCaseLawTitle(ALO_JOINED, '2016-03-01');
    expect(parsed.caseReference).toBe('Joined Cases C-443/14 and C-444/14.');
    expect(parsed.referringCourt).toBe('Bundesverwaltungsgericht');
    expect(parsed.subjectMatter).toMatch(
      /^Reference for a preliminary ruling — Convention relating to the Status of Refugees/,
    );
    expect(parsed.complete).toBe(true);
  });

  it('parses a lower-case "Joined cases" reference and a President order', () => {
    const parsed = parseCaseLawTitle(EURASIAN_ORDER, '1985-04-22');
    expect(parsed.caseReference).toBe('Joined cases 82/85 R and 83/85 R.');
    expect(parsed.formation).toBe('President');
    expect(parsed.subjectMatter).toBe('Application for the adoption of interim measures.');
    expect(parsed.complete).toBe(true);
  });

  it('names the Vice-President and a chamber President as the formation', () => {
    expect(parseCaseLawTitle(VICE_PRESIDENT_ORDER, '2014-04-08')).toMatchObject({
      formation: 'Vice-President',
      complete: true,
    });
    expect(parseCaseLawTitle(CHAMBER_PRESIDENT_ORDER, '1985-03-29')).toMatchObject({
      formation: 'President of the Second Chamber',
      complete: true,
    });
  });

  it('reads the referring court of a General Court preliminary ruling and an extended composition', () => {
    const parsed = parseCaseLawTitle(GC_PRELIMINARY, '2026-02-25');
    expect(parsed.referringCourt).toBe('Bundesfinanzhof');
    expect(parsed.formation).toBe('Fifth Chamber, Extended Composition');
    expect(parsed.complete).toBe(true);
  });

  it('takes a referral with no keyword segment after it as the referring court, not subject matter', () => {
    const parsed = parseCaseLawTitle(WUNSCHE_ORDER, '1986-03-05');
    expect(parsed.referringCourt).toBe('Verwaltungsgericht Frankfurt am Main - Germany');
    expect(parsed.subjectMatter).toBeUndefined();
    expect(parsed.complete).toBe(true);
  });

  it('infers no formation for a pre-chamber judgment and reads its colon-form referral', () => {
    const parsed = parseCaseLawTitle(VAN_GEND, '1963-02-05');
    expect(parsed.formation).toBeUndefined();
    expect(parsed.referringCourt).toBe('Tariefcommissie - Netherlands');
    expect(parsed.complete).toBe(true);
  });

  it('names no referring court on a direct action, and reads the Full Court', () => {
    const parsed = parseCaseLawTitle(PINXTEN_FULL_COURT, '2021-09-30');
    expect(parsed.referringCourt).toBeUndefined();
    expect(parsed.formation).toBe('Full Court');
    expect(parsed.complete).toBe(true);
    expect(parseCaseLawTitle(WHATSAPP, '2026-02-10').referringCourt).toBeUndefined();
  });

  it('keeps the dash form "Reference for a preliminary ruling – …" as subject matter', () => {
    const parsed = parseCaseLawTitle(DASH_REFERENCE, '2021-04-15');
    expect(parsed.referringCourt).toBeUndefined();
    expect(parsed.subjectMatter).toBe(
      'Reference for a preliminary ruling – Aarhus Convention – Directive 2003/4/EC.',
    );
    expect(parsed.complete).toBe(true);
  });

  it('never takes "(Extracts)" as the formation, and leaves an extracts title incomplete', () => {
    const parsed = parseCaseLawTitle(EXTRACTS, '2016-09-15');
    expect(parsed).toMatchObject({
      formation: 'Eighth Chamber',
      parties: 'Italian Republic v European Commission.',
      caseReference: 'Cases T-353/14 and T-17/15.',
      complete: false,
    });
    // Without its marker the same title parses completely: the marker alone keeps it.
    expect(parseCaseLawTitle(EXTRACTS.replace(' (Extracts)', ''), '2016-09-15').complete).toBe(
      true,
    );
  });

  it('keeps no formation and no complete verdict for an extracts parenthetical in the formation slot', () => {
    const parsed = parseCaseLawTitle(
      EXTRACTS.replace(
        '(Eighth Chamber) of 15 September 2016 (Extracts)',
        '(Extracts) of 15 September 2016',
      ),
      '2016-09-15',
    );
    expect(parsed.formation).toBeUndefined();
    expect(parsed.complete).toBe(false);
  });

  it('reads a referral in the parties position as the referring court of a title naming no parties', () => {
    // Shape of CELLAR's English title of 62023CJ0002, keyword list shortened.
    const title =
      'Judgment of the Court (Fifth Chamber) of 30 October 2025.#Request for a preliminary ruling from the Oberlandesgericht Wien.#Reference for a preliminary ruling – Competition – Article 101 TFEU.#Case C-2/23.';
    expect(parseCaseLawTitle(title, '2025-10-30')).toEqual({
      formation: 'Fifth Chamber',
      displayTitle: 'Judgment of the Court (Fifth Chamber) of 30 October 2025.',
      referringCourt: 'Oberlandesgericht Wien',
      subjectMatter: 'Reference for a preliminary ruling – Competition – Article 101 TFEU.',
      caseReference: 'Case C-2/23.',
      complete: true,
    });
  });

  it('reads a referral whose first word CELLAR misspells', () => {
    expect(parseCaseLawTitle(REQEUST_TYPO, '2015-07-15')).toMatchObject({
      referringCourt: 'Administrativen sad - Varna',
      complete: true,
    });
  });

  describe('complete-parse verdict', () => {
    it('is incomplete when the leading segment has no known shape', () => {
      const parsed = parseCaseLawTitle(USDAW_OPINION, '2015-02-05');
      expect(parsed.complete).toBe(false);
    });

    it('is incomplete when the leading date differs from the record date', () => {
      expect(parseCaseLawTitle(SPACENET, '2022-10-27').complete).toBe(false);
      expect(parseCaseLawTitle(SPACENET, '2022-09-20').complete).toBe(true);
    });

    it('is incomplete when the record has no date to confirm the leading one against', () => {
      expect(parseCaseLawTitle(SPACENET).complete).toBe(false);
    });

    it('compares only the date part of a record date', () => {
      expect(parseCaseLawTitle(SPACENET, '2022-09-20+02:00').complete).toBe(true);
    });

    it('is incomplete when a middle segment is left unassigned', () => {
      const withExtra = WHATSAPP.replace('#Appeal', '#An unplaced segment.#Appeal');
      expect(parseCaseLawTitle(withExtra, '2026-02-10').complete).toBe(false);
    });

    it('is incomplete for a title with no "#"', () => {
      expect(
        parseCaseLawTitle(
          'Opinion of Advocate General Cruz Villalón delivered on 8 September 2015.',
          '2015-09-08',
        ).complete,
      ).toBe(false);
    });
  });
});

/**
 * Resource-type fixtures are verbatim CELLAR `cdm:work_has_resource-type` URIs,
 * confirmed against the live Publications Office authority register: a Commission
 * Implementing Regulation (e.g. CELEX 32019R0947) carries `…/resource-type/REG_IMPL`
 * and a Commission Delegated Regulation (e.g. 32019R0945) carries `…/REG_DEL`. The
 * register codes are `REG_IMPL` / `REG_DEL`, not the transposed `IMPL_REG` / `DEL_REG`
 * the map keyed before issue #43 — the transposition made both fall through to the
 * raw last path segment across get_document, search_documents, and the resource.
 */
const RESOURCE_TYPE_BASE = 'http://publications.europa.eu/resource/authority/resource-type/';
const REG_URI = `${RESOURCE_TYPE_BASE}REG`;
const REG_IMPL_URI = `${RESOURCE_TYPE_BASE}REG_IMPL`;
const REG_DEL_URI = `${RESOURCE_TYPE_BASE}REG_DEL`;
const DIR_IMPL_URI = `${RESOURCE_TYPE_BASE}DIR_IMPL`;
const DEC_FRAMW_URI = `${RESOURCE_TYPE_BASE}DEC_FRAMW`;
const VIEW_AG_URI = `${RESOURCE_TYPE_BASE}VIEW_AG`;
const PROP_REG_URI = `${RESOURCE_TYPE_BASE}PROP_REG`;
const RECO_URI = `${RESOURCE_TYPE_BASE}RECO`;

/**
 * Derivative sector-6 case-law resource-types, verified against the live authority
 * register (English prefLabels "Judicial information" / "Information" / "Abstract" / "Summary").
 * eurlex_get_cases excludes these from the default search but can re-admit them via
 * include_derivative, so they must resolve to labels rather than raw codes (issue
 * #44 — the same raw-code gap #43 fixed for REG_IMPL / REG_DEL).
 */
const INFO_JUDICIAL_URI = `${RESOURCE_TYPE_BASE}INFO_JUDICIAL`;
const INFO_JUR_URI = `${RESOURCE_TYPE_BASE}INFO_JUR`;
const ABSTRACT_JUR_URI = `${RESOURCE_TYPE_BASE}ABSTRACT_JUR`;
const SUM_JUR_URI = `${RESOURCE_TYPE_BASE}SUM_JUR`;

/**
 * Resource-types the server's own headline flows return by default, each confirmed
 * live against the authority register: `resolve: "current_consolidated"` yields
 * CONS_TEXT (75,560 works), a national_transposition CELEX yields MEAS_NATION_IMPL
 * (200,789), and CORRIGENDUM (29,417) co-types roughly half the rows of a document
 * search page. None had a map entry before #86, so all three surfaced as raw codes.
 */
const CONS_TEXT_URI = `${RESOURCE_TYPE_BASE}CONS_TEXT`;
const MEAS_NATION_IMPL_URI = `${RESOURCE_TYPE_BASE}MEAS_NATION_IMPL`;
const CORRIGENDUM_URI = `${RESOURCE_TYPE_BASE}CORRIGENDUM`;

/**
 * Every resource-type a sector-6 (case-law) work carries that had no map entry
 * before #93, plus DEC_NC, the national-court decision type (sector 8) reachable
 * through eurlex_lookup_celex. Expected labels are the English skos:prefLabel of
 * each authority-register concept, in the map's Title Case: JUDG_EXTRACT "Judgment
 * (extracts)", ORDER_EXTRACT "Order (extracts)", OPIN_JUR "Opinion of the Court",
 * DEC_NC "Decision by national courts in the field of European Union law",
 * DEC_REVIEW "Decision to review", GARNISHEE_ORDER "Attachment order",
 * THIRDPARTY_PROCEED "Third-party proceedings", DATPRO "Provisional data".
 */
const CASE_LAW_LABELS_93: Record<string, string> = {
  JUDG_EXTRACT: 'Judgment (Extracts)',
  ORDER_EXTRACT: 'Order (Extracts)',
  OPIN_JUR: 'Opinion of the Court',
  DEC_NC: 'Decision by National Courts in the Field of European Union Law',
  DEC_REVIEW: 'Decision to Review',
  GARNISHEE_ORDER: 'Attachment Order',
  THIRDPARTY_PROCEED: 'Third-Party Proceedings',
  DATPRO: 'Provisional Data',
};

/**
 * Every resource-type carried by a sector-6 work, from a live survey of CELLAR
 * (works whose CELEX starts with "6", grouped by `cdm:work_has_resource-type`).
 */
const SECTOR_6_RESOURCE_TYPES = [
  'INFO_JUDICIAL',
  'JUDG',
  'OPIN_AG',
  'ORDER',
  'INFO_JUR',
  'SUM_JUR',
  'ABSTRACT_JUR',
  'JUDG_EXTRACT',
  'CORRIGENDUM',
  'VIEW_AG',
  'OPIN_JUR',
  'ORDER_EXTRACT',
  'DEC_REVIEW',
  'GARNISHEE_ORDER',
  'THIRDPARTY_PROCEED',
  'DATPRO',
  'RULING',
];

describe('resolveResourceTypeLabel', () => {
  it('resolves a Commission Implementing Regulation to its label, not the raw REG_IMPL code (issue #43)', () => {
    expect(resolveResourceTypeLabel(REG_IMPL_URI)).toBe('Implementing Regulation');
    // Regression guard: the real CELLAR code must not fall through to the raw path segment.
    expect(resolveResourceTypeLabel(REG_IMPL_URI)).not.toBe('REG_IMPL');
  });

  it('resolves a Commission Delegated Regulation to its label, not the raw REG_DEL code (issue #43)', () => {
    expect(resolveResourceTypeLabel(REG_DEL_URI)).toBe('Delegated Regulation');
    expect(resolveResourceTypeLabel(REG_DEL_URI)).not.toBe('REG_DEL');
  });

  it('resolves derivative case-law resource-types to labels, not raw codes (issue #44)', () => {
    expect(resolveResourceTypeLabel(INFO_JUDICIAL_URI)).toBe('Judicial Information Notice');
    expect(resolveResourceTypeLabel(INFO_JUR_URI)).toBe('Information Notice');
    expect(resolveResourceTypeLabel(ABSTRACT_JUR_URI)).toBe('Case Abstract');
    expect(resolveResourceTypeLabel(SUM_JUR_URI)).toBe('Case Summary');
    // Regression guard: the real CELLAR codes must not fall through to the raw segment.
    expect(resolveResourceTypeLabel(INFO_JUDICIAL_URI)).not.toBe('INFO_JUDICIAL');
    expect(resolveResourceTypeLabel(SUM_JUR_URI)).not.toBe('SUM_JUR');
  });

  it('resolves newly admitted document-family types to human-readable labels (#65)', () => {
    expect(resolveResourceTypeLabel(DIR_IMPL_URI)).toBe('Implementing Directive');
    expect(resolveResourceTypeLabel(DEC_FRAMW_URI)).toBe('Framework Decision');
    expect(resolveResourceTypeLabel(VIEW_AG_URI)).toBe('AG View');
    expect(resolveResourceTypeLabel(PROP_REG_URI)).toBe('Proposal for a Regulation');
    expect(resolveResourceTypeLabel(RECO_URI)).toBe('Recommendation');
  });

  it('resolves the consolidation, transposition, and corrigendum types (#86)', () => {
    expect(resolveResourceTypeLabel(CONS_TEXT_URI)).toBe('Consolidated Text');
    expect(resolveResourceTypeLabel(MEAS_NATION_IMPL_URI)).toBe('National Implementing Measure');
    expect(resolveResourceTypeLabel(CORRIGENDUM_URI)).toBe('Corrigendum');
    // Regression guard: none may fall through to the raw authority code.
    expect(resolveResourceTypeLabel(CONS_TEXT_URI)).not.toBe('CONS_TEXT');
    expect(resolveResourceTypeLabel(MEAS_NATION_IMPL_URI)).not.toBe('MEAS_NATION_IMPL');
    expect(resolveResourceTypeLabel(CORRIGENDUM_URI)).not.toBe('CORRIGENDUM');
  });

  it('labels the new types in Title Case, like every other map entry (#86)', () => {
    // Every word past the first is capitalised across the map, so "Consolidated
    // text" / "National implementing measure" would read as drift, not variety.
    for (const uri of [CONS_TEXT_URI, MEAS_NATION_IMPL_URI, CORRIGENDUM_URI]) {
      for (const word of resolveResourceTypeLabel(uri).split(' ')) {
        expect(word[0]).toBe(word[0]?.toUpperCase());
      }
    }
  });

  it('labels the case-law extract, opinion, and national-decision types from the authority register (#93)', () => {
    for (const [code, label] of Object.entries(CASE_LAW_LABELS_93)) {
      expect(resolveResourceTypeLabel(`${RESOURCE_TYPE_BASE}${code}`)).toBe(label);
    }
  });

  it('labels every resource-type a sector-6 work carries — none falls back to its code (#93)', () => {
    for (const code of SECTOR_6_RESOURCE_TYPES) {
      expect(resolveResourceTypeLabel(`${RESOURCE_TYPE_BASE}${code}`)).not.toBe(code);
    }
  });

  it('falls back to the last path segment for an unmapped resource-type URI', () => {
    expect(resolveResourceTypeLabel(`${RESOURCE_TYPE_BASE}UNKNOWN_TYPE`)).toBe('UNKNOWN_TYPE');
  });

  it('never resolves a key through the prototype chain', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(resolveResourceTypeLabel(key)).toBe(key);
    }
  });
});

describe('resolveResourceTypeLabels', () => {
  it('resolves REG_IMPL through the search path (space-concatenated multi-type)', () => {
    // eurlex_search_documents collapses a work's resource-types via GROUP_CONCAT,
    // so a work typed as both REG and REG_IMPL arrives space-separated. Both resolve,
    // dedupe, and sort — the implementing-regulation label must appear, not the code.
    expect(resolveResourceTypeLabels(`${REG_URI} ${REG_IMPL_URI}`)).toBe(
      'Implementing Regulation, Regulation',
    );
  });

  it('resolves a lone REG_DEL to the delegated-regulation label', () => {
    expect(resolveResourceTypeLabels(REG_DEL_URI)).toBe('Delegated Regulation');
  });

  it('resolves the derivative case-law types through the multi-type path (issue #44)', () => {
    expect(resolveResourceTypeLabels(ABSTRACT_JUR_URI)).toBe('Case Abstract');
    expect(resolveResourceTypeLabels(SUM_JUR_URI)).toBe('Case Summary');
    expect(resolveResourceTypeLabels(INFO_JUDICIAL_URI)).toBe('Judicial Information Notice');
    expect(resolveResourceTypeLabels(INFO_JUR_URI)).toBe('Information Notice');
  });

  it('resolves a co-typed corrigendum alongside each base type it carries (#86)', () => {
    // Corrigenda are genuinely co-typed — a correction work carries CORRIGENDUM
    // plus the base type of the act it corrects — so the multi-type path is where
    // the label is actually read, and every observed base type must resolve too.
    expect(resolveResourceTypeLabels(`${CORRIGENDUM_URI} ${REG_IMPL_URI}`)).toBe(
      'Corrigendum, Implementing Regulation',
    );
    expect(resolveResourceTypeLabels(`${CORRIGENDUM_URI} ${RESOURCE_TYPE_BASE}DEC_ENTSCHEID`)).toBe(
      'Corrigendum, Decision',
    );
    expect(resolveResourceTypeLabels(`${REG_URI} ${CORRIGENDUM_URI}`)).toBe(
      'Corrigendum, Regulation',
    );
  });

  it('resolves an OJ extract co-typed with its base judgment or order (#93)', () => {
    // A General Court extract carries JUDG_EXTRACT alongside JUDG (e.g. 62020TJ0022),
    // and the pair reached the caller as "JUDG_EXTRACT, Judgment".
    expect(
      resolveResourceTypeLabels(`${RESOURCE_TYPE_BASE}JUDG_EXTRACT ${RESOURCE_TYPE_BASE}JUDG`),
    ).toBe('Judgment, Judgment (Extracts)');
    expect(
      resolveResourceTypeLabels(`${RESOURCE_TYPE_BASE}ORDER ${RESOURCE_TYPE_BASE}ORDER_EXTRACT`),
    ).toBe('Order, Order (Extracts)');
    expect(resolveResourceTypeLabels(`${RESOURCE_TYPE_BASE}OPIN_JUR`)).toBe('Opinion of the Court');
  });

  it('resolves a lone CONS_TEXT and MEAS_NATION_IMPL through the multi-type path (#86)', () => {
    expect(resolveResourceTypeLabels(CONS_TEXT_URI)).toBe('Consolidated Text');
    expect(resolveResourceTypeLabels(MEAS_NATION_IMPL_URI)).toBe('National Implementing Measure');
  });
});
