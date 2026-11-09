/**
 * @fileoverview CDM resource-type URI → human-readable label map and resolvers, the
 * case-law authority tables (country, procedure type and outcome, subject matter) and
 * the subject-label matcher, plus a parser for CELLAR's `#`-delimited case-law
 * expression titles. Used by tool handlers that normalise raw CDM URIs and titles
 * before returning results. Authors are not labelled here: work-agents.ts reads each
 * authority code's English `skos:prefLabel` in its agent query.
 * @module services/cellar-sparql/cdm-labels
 */

/** CELLAR's language authority table; a language's URI appends its upper-case ISO 639-2/T code. */
export const LANGUAGE_AUTHORITY_URI = 'http://publications.europa.eu/resource/authority/language/';

/** English language URI used in expression-level title queries. */
export const ENG_LANGUAGE_URI = `${LANGUAGE_AUTHORITY_URI}ENG`;

/**
 * Namespace of actual EuroVoc concepts, the only concepts
 * `cdm:work_is_about_concept_eurovoc` binds. CELLAR's skos:Concept space also holds
 * other Publications Office authority concepts (class-sum-leg, fd_*, …) that no work
 * is about under that predicate (#11), so eurlex_browse_subjects returns only this
 * namespace and the `eurovoc_concept` filter of eurlex_search_documents accepts only
 * this namespace.
 */
export const EUROVOC_CONCEPT_NAMESPACE = 'http://eurovoc.europa.eu/';

/**
 * The EuroVoc namespace as a caller may spell it: either scheme, any letter case in
 * the scheme and host. Scheme and host are case-insensitive, and every EuroVoc object
 * in CELLAR sits under the http form, so each spelling maps one-to-one onto
 * {@link EUROVOC_CONCEPT_NAMESPACE}. The trailing `/` keeps a lookalike host
 * (`eurovoc.europa.eu.example`) out, and the lookahead requires a concept after it:
 * no work is about the bare namespace.
 */
const EUROVOC_NAMESPACE_SPELLING = /^https?:\/\/eurovoc\.europa\.eu\/(?=.)/i;

/**
 * `value` with its EuroVoc namespace rewritten to the canonical
 * {@link EUROVOC_CONCEPT_NAMESPACE}, or undefined when it names no concept in that
 * namespace. The path is kept as given.
 */
export function canonicalEurovocConceptUri(value: string): string | undefined {
  return EUROVOC_NAMESPACE_SPELLING.test(value)
    ? value.replace(EUROVOC_NAMESPACE_SPELLING, EUROVOC_CONCEPT_NAMESPACE)
    : undefined;
}

/**
 * CDM resource-type URI → human-readable label, for every resource-type a work with a
 * CELEX carries (206 types, 2026-11-09). A label is the authority concept's English
 * `skos:prefLabel` in Title Case: every word is capitalized, as is each part of a
 * hyphenated word and the first word after `(` or an em dash; elsewhere `a`, `an`,
 * `the`, `and`, `or`, and the prepositions `at`, `between`, `by`, `for`, `in`, `of`,
 * `on`, `to`, `with`, `without` are lowercased; acronyms, ordinals, and punctuation are
 * kept as written (`EU`, `1st`, `’`, `—`). Codes the authority labels alike share the
 * label (`DEC` / `DEC_ENTSCHEID` "Decision", `NOTICE` / `NOTICE_INFO` "Notice"). Ten
 * labels are curated rather than prefLabels and are kept: `INFO_JUDICIAL`, `INFO_JUR`,
 * `ABSTRACT_JUR`, `SUM_JUR`, `OPIN_AG`, `VIEW_AG`, `MEAS_NATION_IMPL`, and the three
 * `*_ADOPT_INTERNATION` types. A type absent from the map, such as one CELLAR adds
 * later, falls back to its code, the last URI path segment.
 */
const RESOURCE_TYPE_LABEL_ENTRIES: Record<string, string> = {
  'http://publications.europa.eu/resource/authority/resource-type/REG': 'Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/REG_ADOPT_INTERNATION':
    'Regulation Adopted by International Bodies',
  'http://publications.europa.eu/resource/authority/resource-type/REG_FINANC':
    'Financial Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/DIR': 'Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DIR_DEL': 'Delegated Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DIR_IMPL':
    'Implementing Directive',
  'http://publications.europa.eu/resource/authority/resource-type/DEC': 'Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_ADOPT_INTERNATION':
    'Decision Adopted by International Bodies',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_DEL': 'Delegated Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_ENTSCHEID': 'Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_FRAMW': 'Framework Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_IMPL':
    'Implementing Decision',
  'http://publications.europa.eu/resource/authority/resource-type/TREATY': 'Treaty',
  'http://publications.europa.eu/resource/authority/resource-type/JUDG': 'Judgment',
  'http://publications.europa.eu/resource/authority/resource-type/ORDER': 'Order',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_AG': 'AG Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/VIEW_AG': 'AG View',
  'http://publications.europa.eu/resource/authority/resource-type/RULING': 'Ruling',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP': 'Amended Proposal',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP_DEC':
    'Amended Proposal for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP_DIR':
    'Amended Proposal for a Directive',
  'http://publications.europa.eu/resource/authority/resource-type/AMEND_PROP_REG':
    'Amended Proposal for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_PROP_DEC':
    'Joint Proposal for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_PROP_REG':
    'Joint Proposal for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_ACT': 'Proposal for an Act',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DEC':
    'Proposal for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DEC_IMPL':
    'Proposal for an Implementing Decision',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DEC_NO_ADDRESSEE':
    'Proposal for a Decision without Addressee',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DIR':
    'Proposal for a Directive',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_DRAFT': 'Draft Proposal',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_JOINT_ACTION':
    'Proposal for a Joint Action',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_OPIN':
    'Proposal for an Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_RECO':
    'Proposal for a Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_REG':
    'Proposal for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_REG_IMPL':
    'Proposal for an Implementing Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_RES':
    'Proposal for a Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/RECO': 'Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_ADOPT_INTERNATION':
    'Recommendation Adopted by International Bodies',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_DEC':
    'Recommendation for a Decision',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_RECO':
    'Recommendation for a Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_REG':
    'Recommendation for a Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/RES': 'Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_INTERNATION':
    'International Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/REG_IMPL':
    'Implementing Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/REG_DEL': 'Delegated Regulation',
  // Derivative sector-6 case-law records. Excluded from the default eurlex_get_cases
  // search but reachable via include_derivative, so map them to labels rather than
  // raw codes (the same raw-code gap #43 fixed for REG_IMPL / REG_DEL).
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL':
    'Judicial Information Notice',
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUR': 'Information Notice',
  'http://publications.europa.eu/resource/authority/resource-type/ABSTRACT_JUR': 'Case Abstract',
  'http://publications.europa.eu/resource/authority/resource-type/SUM_JUR': 'Case Summary',
  // Types the server's own headline flows return by default, so the raw-code
  // fallback was the common case rather than a long-tail one: CONS_TEXT is what
  // every `resolve: "current_consolidated"` call yields, MEAS_NATION_IMPL what
  // every national-transposition CELEX resolves to, and CORRIGENDUM co-types a
  // large share of a document-search page (the same raw-code gap #43 closed for
  // REG_IMPL / REG_DEL).
  'http://publications.europa.eu/resource/authority/resource-type/CONS_TEXT': 'Consolidated Text',
  'http://publications.europa.eu/resource/authority/resource-type/MEAS_NATION_IMPL':
    'National Implementing Measure',
  'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM': 'Corrigendum',
  // The remaining resource-types sector-6 works carry, plus DEC_NC — the national-
  // court decision type (sector 8) eurlex_lookup_celex resolves. Each label is the
  // authority register's English skos:prefLabel in the map's Title Case, e.g.
  // JUDG_EXTRACT "Judgment (extracts)" and DEC_NC "Decision by national courts in
  // the field of European Union law". JUDG_EXTRACT / ORDER_EXTRACT sit on the default
  // eurlex_get_cases path, co-typed with the base judgment or order.
  'http://publications.europa.eu/resource/authority/resource-type/JUDG_EXTRACT':
    'Judgment (Extracts)',
  'http://publications.europa.eu/resource/authority/resource-type/ORDER_EXTRACT':
    'Order (Extracts)',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_JUR': 'Opinion of the Court',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_NC':
    'Decision by National Courts in the Field of European Union Law',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_REVIEW': 'Decision to Review',
  'http://publications.europa.eu/resource/authority/resource-type/GARNISHEE_ORDER':
    'Attachment Order',
  'http://publications.europa.eu/resource/authority/resource-type/THIRDPARTY_PROCEED':
    'Third-Party Proceedings',
  'http://publications.europa.eu/resource/authority/resource-type/DATPRO': 'Provisional Data',
  // Every other type a work with a CELEX carries (#192): preparatory, Commission,
  // Council, and Parliament documents, budgets, notices, and questions. The Commission
  // document lookup lands on these (COMMUNIC, IMPACT_ASSESS, JOINT_COMMUNIC), and
  // QUEST_WRITTEN alone types 173,681 works (2026-11-09).
  'http://publications.europa.eu/resource/authority/resource-type/ACKNOWLEDGE_RECP':
    'Acknowledgement Receipt',
  'http://publications.europa.eu/resource/authority/resource-type/ACT': 'Act',
  'http://publications.europa.eu/resource/authority/resource-type/ACT_DRAFT': 'Draft Act',
  'http://publications.europa.eu/resource/authority/resource-type/ACT_OTHER': 'Other Acts',
  'http://publications.europa.eu/resource/authority/resource-type/ACT_PREP': 'Preparatory Act',
  'http://publications.europa.eu/resource/authority/resource-type/ADD': 'Addendum',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE': 'Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_AMEND':
    'Amendment to an Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_EUMS':
    'Agreement between Member States',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_INTERINSTIT':
    'Interinstitutional Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_INTERINSTIT_DRAFT':
    'Draft Interinstitutional Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_INTERNAL':
    'Internal Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/AGREE_PROT':
    'Protocol to the Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/AID_STATE': 'State Aid',
  'http://publications.europa.eu/resource/authority/resource-type/ANNEX': 'Annex',
  'http://publications.europa.eu/resource/authority/resource-type/ANNOUNC': 'Announcements',
  'http://publications.europa.eu/resource/authority/resource-type/ARRANG': 'Arrangement',
  'http://publications.europa.eu/resource/authority/resource-type/ASSENT': 'Assent',
  'http://publications.europa.eu/resource/authority/resource-type/ASSENT_REQ': 'Request for Assent',
  'http://publications.europa.eu/resource/authority/resource-type/BALANCE': 'Balance',
  'http://publications.europa.eu/resource/authority/resource-type/BUDGET': 'Budget',
  'http://publications.europa.eu/resource/authority/resource-type/BUDGET_DRAFT': 'Draft Budget',
  'http://publications.europa.eu/resource/authority/resource-type/BUDGET_DRAFT_PRELIM':
    'Preliminary Draft Budget',
  'http://publications.europa.eu/resource/authority/resource-type/BUDGET_DRAFT_PRELIM_SUPPL':
    'Preliminary Draft Supplementary Budget',
  'http://publications.europa.eu/resource/authority/resource-type/BUDGET_DRAFT_SUPPL_AMEND':
    'Draft Supplementary and Amending Budget',
  'http://publications.europa.eu/resource/authority/resource-type/BUDGET_SUPPL_AMEND':
    'Supplementary and Amending Budget',
  'http://publications.europa.eu/resource/authority/resource-type/CALL_EXPR_INTEREST':
    'Call for Expression of Interest',
  'http://publications.europa.eu/resource/authority/resource-type/CALL_PROP': 'Call for Proposals',
  'http://publications.europa.eu/resource/authority/resource-type/CENSURE_RJ':
    'Rejected Motion of Censure',
  'http://publications.europa.eu/resource/authority/resource-type/CENSURE_WDW':
    'Withdrawn Motion of Censure',
  'http://publications.europa.eu/resource/authority/resource-type/COMMUNIC': 'Communication',
  'http://publications.europa.eu/resource/authority/resource-type/COMMUNIC_DRAFT':
    'Draft Communication',
  'http://publications.europa.eu/resource/authority/resource-type/COMMUNIC_POSIT':
    'Communication of the Commission on Council’s Position at 1st Reading',
  'http://publications.europa.eu/resource/authority/resource-type/COMPOS': 'Common Position',
  'http://publications.europa.eu/resource/authority/resource-type/COMPOS_ACCEPT':
    'Acceptance of Common Position',
  'http://publications.europa.eu/resource/authority/resource-type/COMPOS_AMEND':
    'Amendment to Common Position',
  'http://publications.europa.eu/resource/authority/resource-type/COMPOS_RJ':
    'Rejection of the Common Position',
  'http://publications.europa.eu/resource/authority/resource-type/CONCL': 'Council Conclusions',
  'http://publications.europa.eu/resource/authority/resource-type/CONVENTION': 'Convention',
  'http://publications.europa.eu/resource/authority/resource-type/DECLAR': 'Declaration',
  'http://publications.europa.eu/resource/authority/resource-type/DECLAR_DRAFT':
    'Draft Declaration',
  'http://publications.europa.eu/resource/authority/resource-type/DEC_DRAFT': 'Draft Decision',
  'http://publications.europa.eu/resource/authority/resource-type/DIR_DRAFT': 'Draft Directive',
  'http://publications.europa.eu/resource/authority/resource-type/EVL': 'Evaluation',
  'http://publications.europa.eu/resource/authority/resource-type/EVL_SUM_EXE':
    'Executive Summary of the Evaluation',
  'http://publications.europa.eu/resource/authority/resource-type/EXCH_LET': 'Exchange of Letters',
  'http://publications.europa.eu/resource/authority/resource-type/EXCH_RATE': 'Exchange Rate',
  'http://publications.europa.eu/resource/authority/resource-type/EXCH_RATE_MRO':
    'Interest Rate — Euro Exchange Rates',
  'http://publications.europa.eu/resource/authority/resource-type/EXPL_MEMORANDUM':
    'Explanatory Memorandum',
  'http://publications.europa.eu/resource/authority/resource-type/FC': 'Fitness Check',
  'http://publications.europa.eu/resource/authority/resource-type/FC_SUM_EXE':
    'Executive Summary of the Fitness Check',
  'http://publications.europa.eu/resource/authority/resource-type/GUIDELINE': 'Guideline',
  'http://publications.europa.eu/resource/authority/resource-type/GUIDELINE_GEN':
    'General Guidelines',
  'http://publications.europa.eu/resource/authority/resource-type/GUIDELINE_LIGNES': 'Guideline',
  'http://publications.europa.eu/resource/authority/resource-type/IMPACT_ASSESS':
    'Impact Assessment',
  'http://publications.europa.eu/resource/authority/resource-type/IMPACT_ASSESS_SUM':
    'Summary of Impact Assessment',
  'http://publications.europa.eu/resource/authority/resource-type/IMPL_PLAN': 'Implementation Plan',
  'http://publications.europa.eu/resource/authority/resource-type/INFO': 'Information',
  'http://publications.europa.eu/resource/authority/resource-type/INFO_COMMUNIC': 'Information',
  'http://publications.europa.eu/resource/authority/resource-type/INI': 'Initiative',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_ACTION': 'Joint Action',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_COMMUNIC':
    'Joint Communication',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_DEC': 'Joint Decision',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_IMPACT_ASSESS':
    'Joint Impact Assessment',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_IMPACT_ASSESS_SUM':
    'Joint Impact Assessment Summary',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_PAPER_WHITE':
    'Joint White Paper',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_REPORT': 'Joint Report',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_SWD':
    'Joint Staff Working Document',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_SYNOPSIS_REPORT_CONSULT':
    'Joint Synopsis Report of the Public Consultation',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_TEXT': 'Joint Text',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_TEXT_APR':
    'Approved Joint Text',
  'http://publications.europa.eu/resource/authority/resource-type/JOINT_TEXT_RJ':
    'Rejected Joint Text',
  'http://publications.europa.eu/resource/authority/resource-type/LET': 'Letter',
  'http://publications.europa.eu/resource/authority/resource-type/LET_AMEND': 'Letter of Amendment',
  'http://publications.europa.eu/resource/authority/resource-type/LIST': 'List',
  'http://publications.europa.eu/resource/authority/resource-type/MEMORANDUM': 'Memorandum',
  'http://publications.europa.eu/resource/authority/resource-type/MEMORANDUM_UNDERST':
    'Memorandum of Understanding',
  'http://publications.europa.eu/resource/authority/resource-type/MINUTES': 'Minutes',
  'http://publications.europa.eu/resource/authority/resource-type/NOTE': 'Note',
  'http://publications.europa.eu/resource/authority/resource-type/NOTE_COVER': 'Cover Note',
  'http://publications.europa.eu/resource/authority/resource-type/NOTE_GUID': 'Guidance Note',
  'http://publications.europa.eu/resource/authority/resource-type/NOTICE': 'Notice',
  'http://publications.europa.eu/resource/authority/resource-type/NOTICE_AWARD': 'Award Notice',
  'http://publications.europa.eu/resource/authority/resource-type/NOTICE_CONTRACT':
    'Contract Notice',
  'http://publications.europa.eu/resource/authority/resource-type/NOTICE_INFO': 'Notice',
  'http://publications.europa.eu/resource/authority/resource-type/NOTICE_READER':
    'Notice to Readers',
  'http://publications.europa.eu/resource/authority/resource-type/NOTIF': 'Notification',
  'http://publications.europa.eu/resource/authority/resource-type/OJ': 'Official Journal',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN': 'Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_ADDIT': 'Additional Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_AMEND_EP':
    'Opinion on the European Parliament’s Amendments',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_DISPUT_LB':
    'Opinion Disputing a Legal Base',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_DRAFT_NATION_LEGIS':
    'Opinion on Draft National Legislation',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_EVL':
    'Opinion on Evaluation',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_EXPLOR':
    'Exploratory Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_FC':
    'Opinion on Fitness Check',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_IMPACT_ASSESS':
    'Opinion on Impact Assessment',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_NO_PROP_AMEND':
    'Opinion Not Proposing Amendment',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_NO_REPORT':
    'Opinion without Report',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_PROP_AMEND':
    'Opinion Proposing Amendment',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_PROP_RJ':
    'Opinion Proposing Rejection',
  'http://publications.europa.eu/resource/authority/resource-type/OPIN_QUAL_APR':
    'Opinion with Qualified Approval',
  'http://publications.europa.eu/resource/authority/resource-type/OWNINI_OPIN':
    'Own-Initiative Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/OWNINI_OPIN_ADDIT':
    'Additional Own-Initiative Opinion',
  'http://publications.europa.eu/resource/authority/resource-type/OWNINI_OPIN_DRAFT_NATION_LEGIS':
    'Own-Initiative Opinion on Draft National Legislation',
  'http://publications.europa.eu/resource/authority/resource-type/OWNINI_REPORT':
    'Own-Initiative Report',
  'http://publications.europa.eu/resource/authority/resource-type/OWNINI_RES':
    'Own-Initiative Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/PAPER_GREEN': 'Green Paper',
  'http://publications.europa.eu/resource/authority/resource-type/PAPER_REFLEC': 'Reflection Paper',
  'http://publications.europa.eu/resource/authority/resource-type/PAPER_WHITE': 'White Paper',
  'http://publications.europa.eu/resource/authority/resource-type/POSIT': 'Position',
  'http://publications.europa.eu/resource/authority/resource-type/PROCEED_MINUTES':
    'Minutes of Proceeding',
  'http://publications.europa.eu/resource/authority/resource-type/PROC_ADMIN':
    'Administrative Procedures',
  'http://publications.europa.eu/resource/authority/resource-type/PROC_INTERNAL':
    'Rules of Procedure',
  'http://publications.europa.eu/resource/authority/resource-type/PROC_RULES': 'Rules of Procedure',
  'http://publications.europa.eu/resource/authority/resource-type/PROGRAM': 'Programme',
  'http://publications.europa.eu/resource/authority/resource-type/PROP_AMEND':
    'Amendments to the Proposal',
  'http://publications.europa.eu/resource/authority/resource-type/PROT': 'Protocol',
  'http://publications.europa.eu/resource/authority/resource-type/QUEST_ORAL': 'Oral Question',
  'http://publications.europa.eu/resource/authority/resource-type/QUEST_TIME':
    'Question at Question Time',
  'http://publications.europa.eu/resource/authority/resource-type/QUEST_WRITTEN':
    'Written Question',
  'http://publications.europa.eu/resource/authority/resource-type/RECO_DRAFT':
    'Draft Recommendation',
  'http://publications.europa.eu/resource/authority/resource-type/RECRUIT': 'Recruitment',
  'http://publications.europa.eu/resource/authority/resource-type/REG_DRAFT': 'Draft Regulation',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT': 'Report',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT_ANNUAL': 'Annual Report',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT_ANNUAL_BUDGET':
    'Annual Report on the EU General Budget',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT_ANNUAL_DAS':
    'Annual Report with the Statement of Assurance',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT_ANNUAL_EDF':
    'Annual Report on the Activities Funded by the European Development Fund',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT_ANNUAL_SPECIF':
    'Specific Annual Report',
  'http://publications.europa.eu/resource/authority/resource-type/REPORT_SPECIAL': 'Special Report',
  'http://publications.europa.eu/resource/authority/resource-type/RES_DRAFT': 'Draft Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/RES_LEGIS':
    'Legislative Resolution',
  'http://publications.europa.eu/resource/authority/resource-type/STAT': 'Statement',
  'http://publications.europa.eu/resource/authority/resource-type/STATUTE': 'Statute',
  'http://publications.europa.eu/resource/authority/resource-type/STAT_REASON':
    'Statement of Reasons',
  'http://publications.europa.eu/resource/authority/resource-type/STRATEGY_COMMON':
    'Common Strategy',
  'http://publications.europa.eu/resource/authority/resource-type/SUM': 'Summary',
  'http://publications.europa.eu/resource/authority/resource-type/SWD': 'Staff Working Document',
  'http://publications.europa.eu/resource/authority/resource-type/SYNOPSIS_REPORT_CONSULT':
    'Synopsis Report of the Public Consultation',
  'http://publications.europa.eu/resource/authority/resource-type/TRANSFER_APPROPR':
    'Transfer of Appropriations',
  'http://publications.europa.eu/resource/authority/resource-type/TREATY_DRAFT': 'Draft Treaty',
  'http://publications.europa.eu/resource/authority/resource-type/VERBATIM_REPORT':
    'Verbatim Report',
  'http://publications.europa.eu/resource/authority/resource-type/WARN': 'Warning',
  'http://publications.europa.eu/resource/authority/resource-type/WITHD_AGREE':
    'Withdrawal Agreement',
  'http://publications.europa.eu/resource/authority/resource-type/WORK_DOC': 'Working Document',
};

/**
 * Lookup view of {@link RESOURCE_TYPE_LABEL_ENTRIES}. A `Map`, not the object
 * literal, so an upstream URI such as `constructor` cannot resolve through the
 * prototype chain.
 */
export const RESOURCE_TYPE_LABELS: ReadonlyMap<string, string> = new Map(
  Object.entries(RESOURCE_TYPE_LABEL_ENTRIES),
);

/**
 * Derivative sector-6 resource-types: information notices (INFO_JUDICIAL, INFO_JUR),
 * case-law abstracts (ABSTRACT_JUR), case summaries (SUM_JUR), and standalone
 * corrigenda (CORRIGENDUM). Each is a separate CELLAR work with its own CELEX
 * (`…_RES`, `…_SUM`, `…R(nn)`, the `CN`/`CA`/`TN`… notices) that restates or
 * announces a primary judgment, order, or AG opinion rather than being one.
 *
 * eurlex_get_cases excludes them from its default search, where at a page limit they
 * crowd distinct primary cases off the page (issue #44). eurlex_lookup_celex skips
 * them when one ECLI reaches several works, since an `_RES`/`_SUM` sibling carries
 * its parent's ECLI.
 *
 * CORRIGENDUM covers the standalone correction works, all carrying the CELEX `…R(nn)`
 * corrigendum marker (issue #55). No primary judgment/order/AG opinion is typed
 * CORRIGENDUM, so excluding the type drops only the correction record and never the
 * corrected case, which is a distinct CELEX. Listing it explicitly also makes the
 * exclusion robust: sector-6 corrigenda are currently co-typed INFO_JUDICIAL (already
 * listed), but a corrigendum typed CORRIGENDUM alone would otherwise leak.
 * JUDG_EXTRACT/ORDER_EXTRACT are deliberately NOT here: an OJ extract can be the sole
 * published record of an older case, so excluding it would cost recall.
 */
export const DERIVATIVE_RESOURCE_TYPES = [
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUDICIAL',
  'http://publications.europa.eu/resource/authority/resource-type/INFO_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/ABSTRACT_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/SUM_JUR',
  'http://publications.europa.eu/resource/authority/resource-type/CORRIGENDUM',
] as const;

/** Resolve a CDM resource-type URI to a human-readable label. Falls back to last path segment. */
export function resolveResourceTypeLabel(uri: string): string {
  return RESOURCE_TYPE_LABELS.get(uri) ?? uri.split('/').pop() ?? uri;
}

/**
 * Resolve a whitespace-separated list of CDM resource-type URIs into a single
 * human-readable label string. Search queries collapse each work's resource-types
 * into one row via `GROUP_CONCAT(DISTINCT STR(?type))`, so a work carrying several
 * types (e.g. a corrigendum classified as both CORRIGENDUM and a base type) arrives
 * as space-separated URIs. Each URI is resolved, de-duplicated, sorted for stable
 * output, and joined with ", ". Returns undefined when no type URI is present.
 */
export function resolveResourceTypeLabels(concatenated: string | undefined): string | undefined {
  if (!concatenated) return;
  const labels = [
    ...new Set(concatenated.split(/\s+/).filter(Boolean).map(resolveResourceTypeLabel)),
  ].sort();
  return labels.length > 0 ? labels.join(', ') : undefined;
}

/**
 * CELLAR's country authority table, the values of `cdm:case-law_originates_in_country`;
 * a country's URI appends its upper-case ISO 3166-1 alpha-3 code (`…/country/BGR`).
 */
export const COUNTRY_AUTHORITY_URI = 'http://publications.europa.eu/resource/authority/country/';

/**
 * CELLAR's procedure authority table (`fd_100`), the values of
 * `cdm:case-law_has_type_procedure_concept_type_procedure`. A code is a procedure
 * root, optionally followed by the outcome after an `=` the IRI stores encoded:
 * `…/fd_100/ANNU%3DOB` is "Action for annulment - successful".
 */
export const PROCEDURE_AUTHORITY_URI = 'http://publications.europa.eu/resource/authority/fd_100/';

/** The `=` between a procedure root and its outcome, as a procedure IRI stores it. */
export const PROCEDURE_OUTCOME_SEPARATOR = '%3D';

/**
 * CELLAR's case-law subject-matter scheme, the `skos:inScheme` of every value of
 * `cdm:case-law_is-about_case-law-subject-matter` (186 concepts, each with an English
 * label, 2026-11-03).
 */
export const CASE_LAW_SUBJECT_MATTER_SCHEME =
  'http://publications.europa.eu/resource/authority/case-law-subject-matter';

/**
 * True for the "Provisional data" placeholder (`OP_DATPRO`) CELLAR keeps in its
 * country, procedure, and subject-matter tables. It records no fact about a case, so
 * no case-law field reports it and no subject resolves to it.
 */
export function isProvisionalData(authorityUri: string): boolean {
  return authorityUri.endsWith('/OP_DATPRO');
}

/**
 * The `procedure_type` members of eurlex_get_cases: every procedure root heading at
 * least 300 primary case-law records (2026-11-03), the rest staying visible in each
 * row's procedure types.
 */
export const PROCEDURE_TYPES = [
  'preliminary_ruling',
  'annulment',
  'staff_case',
  'appeal',
  'failure_to_fulfil_obligations',
  'damages',
  'interim_measures',
  'appeal_against_penalty',
  'failure_to_act',
  'arbitration_clause',
] as const;

export type ProcedureType = (typeof PROCEDURE_TYPES)[number];

/**
 * The `fd_100` roots each procedure type covers. A case matches a root when one of
 * its codes is the root or the root plus an outcome, never a longer root sharing its
 * start: `REFE` (interim measures) must not take `REFER_PREL_URG`, the urgent
 * preliminary references, which belong to `preliminary_ruling`.
 */
export const PROCEDURE_TYPE_ROOTS = {
  preliminary_ruling: ['PREJ', 'REFER_PREL_URG'],
  annulment: ['ANNU'],
  staff_case: ['FONC'],
  appeal: ['PVOI'],
  failure_to_fulfil_obligations: ['CONS'],
  damages: ['RESP'],
  interim_measures: ['REFE'],
  appeal_against_penalty: ['SANC'],
  failure_to_act: ['CARE'],
  arbitration_clause: ['COMP'],
} as const satisfies Record<ProcedureType, readonly string[]>;

/** The `outcome` members of eurlex_get_cases: every outcome on at least 1,000 records. */
export const PROCEDURE_OUTCOMES = [
  'successful',
  'unfounded',
  'inadmissible',
  'decision_unnecessary',
] as const;

export type ProcedureOutcome = (typeof PROCEDURE_OUTCOMES)[number];

/** The code each outcome carries after {@link PROCEDURE_OUTCOME_SEPARATOR}. */
export const PROCEDURE_OUTCOME_CODES = {
  successful: 'OB',
  unfounded: 'RF',
  inadmissible: 'RI',
  decision_unnecessary: 'NL',
} as const satisfies Record<ProcedureOutcome, string>;

/** A run of letters and digits: one word of a subject phrase. */
const SUBJECT_WORD = /[\p{L}\p{N}]+/gu;

/**
 * The distinct words of a subject phrase, lowercased: its runs of letters and digits,
 * every other character a separator. Empty when the phrase holds no letter or digit.
 */
export function subjectWords(subject: string): string[] {
  return [...new Set(Array.from(subject.matchAll(SUBJECT_WORD), ([word]) => word.toLowerCase()))];
}

/**
 * True when `label` contains every one of `words` ({@link subjectWords}), in any case
 * and also inside a longer word: "trade mark" matches "Trade marks", "tax" matches
 * "Taxation".
 */
export function labelHoldsEveryWord(label: string, words: readonly string[]): boolean {
  const lower = label.toLowerCase();
  return words.every((word) => lower.includes(word));
}

/**
 * Structured decomposition of a CELLAR case-law expression title. Every field but
 * `complete` is optional — a real title may carry fewer segments, empty segments,
 * or no `#` delimiter at all, and no field is ever fabricated from missing data.
 */
export interface ParsedCaseTitle {
  /** Advocate General named by an opinion's leading segment, e.g. "Jääskinen". */
  advocateGeneral?: string;
  /** Case reference, e.g. "Case C-97/23 P." or "Joined Cases C-443/14 and C-444/14.". */
  caseReference?: string;
  /**
   * True when the fields hold everything the raw title carries: every non-empty
   * segment was assigned to a field (the leading court/AG descriptor counts as
   * assigned when it parses and marks no publication by extracts), and the
   * descriptor's date equals the record's date. A caller may drop the raw title
   * only when this is true.
   */
  complete: boolean;
  /** Clean human-readable title for display: the parties, or the court/AG descriptor when there are none. */
  displayTitle?: string;
  /**
   * The formation named in the leading segment, verbatim: the parenthetical after
   * the court ("Grand Chamber", "Fourth Chamber, Extended Composition"), or the
   * issuing office of an order so titled ("President", "Vice-President",
   * "President of the Second Chamber"). Never "(Extracts)", never inferred.
   */
  formation?: string;
  /** The parties segment, e.g. "Google Spain SL v AEPD". */
  parties?: string;
  /** National court that referred a preliminary ruling, e.g. "Audiencia Nacional" or "Tariefcommissie - Netherlands". */
  referringCourt?: string;
  /** Subject-matter keyword summary — the en-dash-delimited keyword list. */
  subjectMatter?: string;
}

const MONTH_NUMBERS: ReadonlyMap<string, string> = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((month, i) => [month, String(i + 1).padStart(2, '0')]),
);

/** `{day} {Month} {year}` as three groups, the date form every leading segment uses. */
const TITLE_DATE = String.raw`(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})`;
const TITLE_COURT =
  '(?:Court of First Instance|General Court|Court(?: of Justice)?|(?:European Union )?Civil Service Tribunal)';

/**
 * Leading segment of a judgment or order: the court, an optional formation
 * parenthetical, the date (after "of" or a comma, or neither in the upper-case
 * Civil Service Tribunal form), and an optional trailing extracts marker, captured
 * last ("(Extracts)", 62014TJ0353).
 */
const JUDGMENT_OR_ORDER_DESCRIPTOR = new RegExp(
  String.raw`^(?:Judgment|Order)\s+of\s+the\s+${TITLE_COURT}(?:\s*\(([^)]+)\))?,?\s+(?:of\s+)?${TITLE_DATE}(\s*\((?:Extracts?|publication by extracts)\))?\.?$`,
  'i',
);

/** Leading segment of an order issued by a court's President, Vice-President, or a chamber President. */
const PRESIDENT_ORDER_DESCRIPTOR = new RegExp(
  String.raw`^Order\s+of\s+the\s+((?:Vice-)?President(?:\s+of\s+the\s+\w+\s+Chamber)?)\s+of\s+the\s+${TITLE_COURT},?\s+(?:of\s+)?${TITLE_DATE}\.?$`,
  'i',
);

/** Leading segment of an AG opinion: "[Joined] Opinion of [Mr] [First] Advocate General X delivered on DATE." */
const AG_OPINION_DESCRIPTOR = new RegExp(
  String.raw`^(?:Joined\s+)?Opinion\s+of\s+(?:(?:Mr|Mrs|Ms)\s+)?(?:First\s+)?Advocate\s+General\s+(.+?)\s+delivered\s+on\s+${TITLE_DATE}\.?$`,
  'i',
);

/**
 * Referral segment of a preliminary ruling: "Request(s)/Reference(s) for a
 * preliminary ruling from [the] X." or the older "…: X - Country.". The first word
 * is any word, since CELLAR carries typos of it ("Reqeust"). The dash form
 * ("Reference for a preliminary ruling – VAT – …") is a keyword list, not a
 * referral, and does not match.
 */
const REFERRAL_SEGMENT = /^\p{L}+ for a preliminary ruling(?: from (?:the )?|\s*:\s*)(.+?)\.?$/iu;

/** Trailing case-reference segment: "Case …", "Cases …", or "Joined Case(s) …", in either capitalization. */
const CASE_REFERENCE_SEGMENT = /^(?:Joined\s+)?Cases?\b/i;

/** ISO `YYYY-MM-DD` from a matched day, English month name, and year; undefined for an unknown month. */
function titleDateIso(day = '', month = '', year = ''): string | undefined {
  const monthNumber = MONTH_NUMBERS.get(month.toLowerCase());
  return monthNumber ? `${year}-${monthNumber}-${day.padStart(2, '0')}` : undefined;
}

/** What a leading court/AG descriptor of a known shape carries. */
interface TitleDescriptor {
  advocateGeneral?: string | undefined;
  /** ISO date; undefined when the month name is not an English one. */
  date: string | undefined;
  /**
   * True when the descriptor marks the text as published by extracts, which no
   * field carries: the trailing "(Extracts)", or an extracts parenthetical where
   * the formation sits.
   */
  extracts?: boolean;
  formation?: string;
}

/** What the leading court/AG descriptor carries, or undefined when it has none of the known shapes. */
function parseDescriptor(segment: string): TitleDescriptor | undefined {
  const judgmentOrOrder = JUDGMENT_OR_ORDER_DESCRIPTOR.exec(segment);
  if (judgmentOrOrder) {
    const [, formation, day, month, year, trailingExtracts] = judgmentOrOrder;
    const extractsFormation = formation !== undefined && /extract/i.test(formation);
    return {
      date: titleDateIso(day, month, year),
      extracts: trailingExtracts !== undefined || extractsFormation,
      ...(formation && !extractsFormation ? { formation } : {}),
    };
  }
  const presidentOrder = PRESIDENT_ORDER_DESCRIPTOR.exec(segment);
  if (presidentOrder) {
    const [, office = '', day, month, year] = presidentOrder;
    return {
      date: titleDateIso(day, month, year),
      formation: office.charAt(0).toUpperCase() + office.slice(1),
    };
  }
  const opinion = AG_OPINION_DESCRIPTOR.exec(segment);
  if (opinion) {
    const [, advocateGeneral, day, month, year] = opinion;
    return { advocateGeneral, date: titleDateIso(day, month, year) };
  }
  return;
}

/**
 * Parse a CELLAR case-law expression title into structured fields. This is the one
 * parser every tool that reads a case-law title shares, so each field and the
 * `complete` verdict mean the same thing wherever a title is decomposed.
 *
 * Case-law titles pack several segments into one `#`-delimited string, roughly
 *   `{court + formation + date}#{parties}#[referral]#{subject-matter keywords}#{case reference}`
 * e.g. `Judgment of the Court (Grand Chamber) of 10 February 2026.#WhatsApp
 * Ireland Ltd v European Data Protection Board.#Appeal – … .#Case C-97/23 P.`
 *
 * The segment count is not fixed: preliminary-ruling titles insert a referral
 * segment naming the national court before the subject matter, and AG opinions
 * leave the parties/subject/reference segments empty (`Opinion of Advocate General
 * … .###`). Rather than assume a fixed layout, this anchors on the reliable
 * positions:
 * - the leading segment is the court/AG descriptor, read for the formation, the
 *   Advocate General, and the date — a pre-chamber "Judgment of the Court of DATE."
 *   names no formation, and none is inferred. A descriptor marking publication by
 *   extracts ("… of 15 September 2016 (Extracts).") is read the same way but left
 *   unassigned, since no field says the text is an extract;
 * - the parties are the second segment, unless that segment is the referral, as it
 *   is in a title that names no parties;
 * - the case reference is the trailing "Case …", "Cases …", or "Joined Cases …"
 *   segment past the second;
 * - the referring court is the first referral segment between the descriptor and
 *   the case reference;
 * - the subject matter is the segment immediately before the case reference (or
 *   the trailing segment when there is none) that is not the referral.
 * Absent or empty segments are left unset, never invented.
 *
 * `date` is the record's own date (`YYYY-MM-DD`, any time or zone suffix ignored).
 * The parse is `complete` only when every non-empty segment was assigned and the
 * descriptor's date equals it — so a caller that drops the raw title on a complete
 * parse loses nothing the fields and the record's date do not already carry. A
 * title with no `#` (a plain title, or an older sparse record) yields only
 * `complete: false`, so the caller keeps the raw title untouched.
 */
export function parseCaseLawTitle(raw: string | undefined, date?: string): ParsedCaseTitle {
  if (!raw?.includes('#')) return { complete: false };
  const segments = raw.split('#').map((s) => s.trim());
  const assigned = new Set<number>();
  const result: ParsedCaseTitle = { complete: false };

  const descriptor = parseDescriptor(segments[0] ?? '');
  if (descriptor) {
    if (!descriptor.extracts) assigned.add(0);
    if (descriptor.formation) result.formation = descriptor.formation;
    if (descriptor.advocateGeneral) result.advocateGeneral = descriptor.advocateGeneral;
  }

  // Parties: the second segment — the reliable display-name position — unless it is
  // the referral, as in a title that names no parties (62023CJ0002).
  const parties = segments[1];
  if (parties && !REFERRAL_SEGMENT.test(parties)) {
    result.parties = parties;
    assigned.add(1);
  }

  // Case reference: the trailing non-empty segment, only when it has the case
  // shape and sits past the second segment (index ≥ 2). The optional "s" matches the plural
  // joined-case form (issue #42), and the optional "Joined" its long form.
  const lastIdx = segments.findLastIndex((s) => s !== '');
  let end = lastIdx;
  const last = segments[lastIdx];
  if (lastIdx >= 2 && last && CASE_REFERENCE_SEGMENT.test(last)) {
    result.caseReference = last;
    assigned.add(lastIdx);
    end = lastIdx - 1;
  }

  for (let i = result.parties ? 2 : 1; i <= end; i++) {
    const court = REFERRAL_SEGMENT.exec(segments[i] ?? '')?.[1];
    if (court) {
      result.referringCourt = court;
      assigned.add(i);
      break;
    }
  }

  // Subject matter: the keyword list right before the case reference, unless that
  // segment is the referral itself.
  const subject = segments[end];
  if (end >= 2 && subject && !assigned.has(end)) {
    result.subjectMatter = subject;
    assigned.add(end);
  }

  // Display title: the parties for contested cases, else the leading court/AG descriptor.
  const displayTitle = result.parties ?? segments[0];
  if (displayTitle) result.displayTitle = displayTitle;

  const everySegmentAssigned = segments.every((s, i) => s === '' || assigned.has(i));
  result.complete =
    everySegmentAssigned &&
    descriptor?.date !== undefined &&
    descriptor.date === date?.slice(0, 10);
  return result;
}
