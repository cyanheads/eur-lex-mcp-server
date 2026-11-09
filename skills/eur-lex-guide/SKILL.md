---
name: eur-lex-guide
description: Identifier chains, conclusion gates, and CELLAR SPARQL vocabulary for the eurlex_* tools. Use when tracing an EU act's amendments, consolidated text, repeal, or national transposition; finding CJEU rulings on an article or by member state, procedure, outcome, or subject; resolving a CELEX, ELI, ECLI, case number, or Official Journal citation; filtering by EuroVoc subject; or writing an eurlex_query_sparql query.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.2"
---

## Scope

EU law as the Publications Office's CELLAR repository holds it, keyless: treaties and Charter articles, regulations, directives, decisions, preparatory acts, Court of Justice, General Court, and Civil Service Tribunal records, consolidated texts, and member-state transposition notifications.

Not covered:

- **Member-state law itself.** A transposition row records a national measure a member state notified, with its national journal citation. Its `notification_date` does not prove the directive was fully transposed.
- **Search inside act bodies.** Keywords match English titles and CELEX strings only. To find acts about a concept, go through EuroVoc or title words, then read the bodies.

## Identifiers

| Identifier | Shape | Comes from |
|:--|:--|:--|
| CELEX, legislation | `3` + year + type + number: `R` regulation, `L` directive, `D` decision (`32016R0679`) | `eurlex_lookup_celex` from a citation; every search and relation row |
| CELEX, treaty or Charter article | sector `1` (`12012E016` TFEU Art. 16, `12007P008` Charter Art. 8) | `legal_basis` and `interprets` rows |
| CELEX, case law | `6` + year + court letter (`C` Court of Justice, `T` General Court, `F` Civil Service Tribunal) + document letter (`J` judgment, `O` order, `C` AG opinion, `P` AG view) + number. C-131/12 is `62012CJ0131`, its AG opinion `62012CC0131` | `eurlex_get_cases` |
| CELEX, consolidated text | `0` + the base act's core + `-YYYYMMDD` (`02016R0679-20160504`). The base CELEX cannot always be derived from it: read `base_act_celex`. A consolidated CELEX with no date or a date no version carries fails `not_found` naming the act's current version and, for a dated one, the version in effect on that date (`data.held_celex`); `resolve: "current_consolidated"` serves the current one | `consolidated_version` rows; `current_consolidated_celex` |
| CELEX, corrigendum | base CELEX + `R(nn)` (`32016R0679R(02)`) | `eurlex_search_documents` with `include_corrigenda` |
| CELEX, national measure | `7` + the directive's year, type, and number + member-state alpha-3 + `_` + measure number (`72016L0680DEU_261768`) | `national_transposition` rows |
| Case number | `C-131/12`, `T-…`, `F-…`. One case number covers several records (judgment, orders, AG opinion), so it is not one work | the input of `eurlex_get_cases` |
| ECLI | `ECLI:EU:C:2014:317`, case law only | `eurlex_get_cases` rows; `eurlex_lookup_celex` resolves it back |
| Commission document number | `COM(2021) 206 final`, also `SEC`, `SWD`, `JOIN`. It does not give the CELEX away (`COM(2017) 10` is a proposal, `52017PC0010`; `COM(2020) 66` a communication, `52020DC0066`), and up to 2009 one number can name several works | `eurlex_lookup_celex` resolves it; several works return `found: false` naming each CELEX |
| Procedure reference | `2021/0106(COD)`: year, number, type. It names the dossier, not an act | `procedures` of `eurlex_get_document` on a proposal or the act it produced. `eurlex_lookup_celex` resolves it to the act that initiated the procedure; the act it produced is that act's `adopted_by` on `eurlex_get_relations` and in `procedures[].adopted_acts`. When CELLAR records no initiating act, the lookup returns `found: false` with the notice naming the acts the procedure produced, if any |
| ELI | `http://data.europa.eu/eli/reg/2016/679` for the act; a consolidated text has a dated one (`…/2016-05-04`); case law has none | `eurlex_get_document` `eli` |
| Work URI | `http://publications.europa.eu/resource/cellar/{uuid}` | every tool. Several works can carry one CELEX (`62012CJ0131` has two). The tools pick the canonical one; a SPARQL query must deduplicate on the CELEX |
| EuroVoc concept | `http://eurovoc.europa.eu/{id}` | `eurlex_browse_subjects`; `eurovoc_subjects` of `eurlex_get_document` |

## Gates

- **Cite the act, not the consolidation.** A consolidated text is an unofficial reading aid that merges later amendments into the act. Read it, but cite the base act and the amending acts, each by its `oj_reference`. `is_superseded: true` only means a newer consolidation exists. It is not a repeal signal.
- **Do not read an absent in-force flag as false.** Only a minority of works carry the flag. A consolidated text reports its base act's flag. `in_force: true` on `eurlex_search_documents` silently drops every untagged act, so it cannot list "every act in force". Report that the status is not recorded.
- **"Repealed" needs both repeal relations.** `repealed_by` on `eurlex_get_document` lists explicit repeals only. Implicit repeals come from `implicitly_repealed_by` on `eurlex_get_relations`. A repeal edge can target only some provisions (some acts still in force are partial-repeal targets), so read the edge's `provisions` before calling the whole act repealed.
- **An act can apply in stages.** In `dates_of_effect` on `eurlex_get_document`, the `application` entry is the general date of application, and each `partial_application` entry is a date from which only some provisions apply. That entry's `provision` names the clause listing them (the AI Act's 2025-02-02 date is set by `Article 113(a)`), so read that clause before saying what applies when. `provision` keeps CELLAR's numbering: `Article 93.1` in an EU act is Article 93(1). The dates are what CELLAR records on the act and can lag an amending act that moves one: when the `notice` names an amending act and an article, confirm a date in that article's clause in the current consolidated text (`current_consolidated_celex`) before stating it, and in the amending act itself for an amendment that text does not merge yet.
- **A proposal with no `adopted_by` is not pending.** A withdrawn proposal has no adoption edge either: the ePrivacy proposal `52017PC0010` reads like one still in negotiation, yet its procedure was withdrawn on 2025-10-06. Read `procedures[].status` on `eurlex_get_document` (`adopted`, `withdrawn`, `pending`, `not_adopted`) before saying where a proposal stands. An absent `status` means CELLAR flags none or contradicts itself, not "pending"; say the status is not recorded.
- **A member state with no recorded measure has not necessarily failed to transpose.** `member_states_without_measures` lists the states CELLAR holds no notified measure for, and CELLAR lacks some: it records none for Italy or Malta under Directive 95/46/EC, which both transposed. Without a `member_states` filter the list covers today's 27 whatever date each joined, so a state that acceded after the deadline appears too. Report "no measure recorded in EUR-Lex", not "not transposed".
- **No ruling on an article is a claim to check before reporting.** The `article` filter of `eurlex_get_relations` leaves out rulings that CELLAR records no provision for. Before reporting that no ruling interprets an article, repeat `interpreted_by` without `article` and check the remaining rulings' `subject_matter` or operative parts.
- **Check corrigenda before quoting final wording.** A corrigendum is a separate work: the GDPR has three. Search the act's whole CELEX as `keyword` with `include_corrigenda`, and read any that cover the provision you are quoting.
- **A EuroVoc filter matches one concept, not its narrower ones.** Acts indexed only under a narrower concept are not returned: 2,318 works carry "protection of privacy" (`2828`), and 2,719 carry it or a concept below it. For full coverage, search each narrower concept in turn, or use `skos:broader*` in SPARQL ([references/sparql-cdm.md](references/sparql-cdm.md)).
- **An empty EuroVoc search for case law is not "no case law".** CELLAR indexes no judgment, order, or AG opinion of the Court of Justice or General Court by EuroVoc concept; only EFTA Court judgments carry one. `eurovoc_concept` with `document_type` `JUDG` or `OPIN_AG` therefore finds EFTA Court judgments at most. Search rulings by subject with the `subject` input of `eurlex_get_cases`.
- **A case's country depends on its procedure.** `member_state` and `countries` carry the state CELLAR says the case originates in: the referring court's state on a preliminary reference, the defendant state on an action for failure to fulfil obligations, the applicant's state (seat or nationality) or the member-state party on a direct action such as annulment, damages, or failure to act. Staff cases usually carry none. "Cases from Germany" under `preliminary_ruling` are references from German courts; under `failure_to_fulfil_obligations` they are actions against Germany. Pair `member_state` with `procedure_type` and say which one you searched.
- **The case-law filters see only what CELLAR classified.** `member_state`, `procedure_type`, `outcome`, and `subject` never match a case CELLAR records no value of that fact for: about a fifth of primary records carry no country (every Civil Service Tribunal staff case), preliminary references rarely record an outcome, and records published in the last few weeks often carry no country, procedure, or subject yet. Before reporting that no case exists, repeat the search without the fact filter, using `keyword`, `case_number`, or a date window. A `subject` word also matches inside longer labels ("tax" reaches "Value added tax" and "Common corporate tax regime"), so read `query_echo.subject_labels` before saying what a subject search covered.
- **Confirm the language served before attributing text to it.** A body falls back to English when the requested language has none. Read `language` and `language_fallback` before presenting text as a given language version. The `keyword` of `eurlex_search_documents` and `eurlex_get_cases` matches English titles only, whatever language you read in.

## Core chains

**An act's amendment history to its current text.** Resolve the citation with `eurlex_lookup_celex`, then call `eurlex_get_relations` on the CELEX with `amended_by`, `repealed_by`, `implicitly_repealed_by`, and `consolidated_version`. Read the in-force text with `eurlex_get_document` and `resolve: "current_consolidated"`, adding `select` to read one article. Each amending act's row names the provisions it changes. For amendments of those amending acts, or any chain longer than one hop, use SPARQL.

**The case law on a provision.** Call `eurlex_get_relations` with `interpreted_by` and `article`, then apply the article gate above. Read a ruling with `eurlex_get_document`: `outline: true` locates its operative part, and `select` reads just that part. To start from a case number instead, use `eurlex_get_cases`, which returns each record's CELEX and ECLI.

**Case law by member state, procedure, and subject.** Call `eurlex_get_cases` with any of `member_state` (`DEU` or `DE`), `procedure_type` (`preliminary_ruling`, `annulment`, `failure_to_fulfil_obligations`, `appeal`, `staff_case`, …), `outcome` (`successful`, `unfounded`, `inadmissible`, `decision_unnecessary`; with `procedure_type` both hold on the same procedure, so `annulment` with `successful` finds annulment actions that succeeded), and `subject`, a phrase matched against CELLAR's case-law subject labels ("data protection" reaches "Protection of personal data", "trade mark" "Trade marks"). Each row lists its own `countries`, `procedure_types` (outcome included), `subjects`, and `procedure_languages`; `procedure_languages` are the codes `eurlex_get_document` takes as `language`. A search matching more than 10,000 cases stops at row 10,000: follow the notice's date windows. Apply the two case-law gates above before reporting counts or absences.

**Acts on a subject.** Turn the term into concept URIs with `eurlex_browse_subjects`. Pass each URI to `eurlex_search_documents` as `eurovoc_concept`, adding a `document_type` and a date window. Results run newest first, so a foundational act can sit several pages down. Rulings are not reached this way (gate above): pass the term to `eurlex_get_cases` as `subject`. To list the Judicial Information Notices that announce cases under a concept, drop `document_type` and pass `keyword` `Case`; each notice title names the case number `eurlex_get_cases` takes.

**Transposition of a directive.** Get the deadlines from `eurlex_get_document` (`transposition_deadlines`). Call `eurlex_get_relations` with `national_transposition`: the first page's `transposition_summary` counts every member state's measures, with its newest document date, and names the member states with none (apply the transposition gate above). Page one state's measures with `member_states`. Read a measure's national journal citation with `eurlex_get_document`.

**Questions the curated tools cannot express.** Use `eurlex_query_sparql` for a chain longer than one hop, an aggregate (counts per year, per author, per concept), or a predicate no tool exposes, such as listing directives by transposition deadline. Before writing a query, read [references/sparql-cdm.md](references/sparql-cdm.md): CELLAR identifiers are typed literals, titles hang off language expressions, and several CDM relations are stored in one direction only.

## References

- [references/sparql-cdm.md](references/sparql-cdm.md): prefixes and typed literals, the predicate map with directions, provision axioms, EuroVoc paths, case-law facts and procedure codes, Virtuoso quirks, and live-checked example queries.
