# EUR-Lex MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eurlex_search_documents` | Search EU legislation, case law, treaties, and preparatory acts across the CELLAR corpus. Filters by document category, date range, EuroVoc subject concept, author institution, and in-force status (`false` covers repealed, expired, and not-yet-in-force acts). Each category maps to an explicit family of CELLAR authority types; consolidated texts remain excluded unless requested, then qualify through the type of their basic act. Corrigenda are excluded unless `include_corrigenda` opts in, since they are co-typed into every category and sort ahead of the acts they correct. Returns CELEX numbers, work URIs, document types, and dates — use these with `eurlex_get_document` to fetch full content. | `keyword?`, `document_type?`, `include_consolidated?` (default `false`), `include_corrigenda?` (default `false`), `date_from?`, `date_to?`, `eurovoc_concept?`, `author_institution?`, `in_force?`, `offset?` (default `0`), `limit` (default `20`, max `100`) | `readOnlyHint: true` |
| `eurlex_get_document` | Fetch the notice (metadata) and full text of a work by CELEX number, ELI URI, or CELLAR work URI. Returns structured metadata (title, date, document type, author institution, Advocates General, legal basis, EuroVoc subjects) plus the HTML, Markdown, or Formex4 XML content in the requested language. Every body returned in one call is capped at 100,000 characters; `paged` is the complete-content floor, and `full` is the first capped window from offset zero. `outline` returns a structural heading list and no body text; `select` returns specific sections by number under the same cap, each source character once (a section inside another selected section rides in the enclosing one), with `selected_sections` giving each matched section, nested ones included, its own `offset`/`chars` in place of a contiguous window. Language is constrained to the 24 EUR-Lex codes, accepted case-insensitively and normalized to uppercase. `is_superseded`, `current_consolidated_celex`, and `consolidated_as_of` place the served text among its act's consolidated versions; a consolidated text reports its base act as `base_act_celex`, with that act's authors, in-force flag, legal bases, and EuroVoc subjects. An act not in force names why: `repealed_by`, `end_of_validity`, or a pending `entry_into_force`. A `work_uri` carrying several CELEX numbers serves its lowest, with a `notice` giving the count. | Exactly one of `celex_number`, `eli_uri`, or `work_uri`; `resolve?` (`"as_requested"` default, `"current_consolidated"`), `language?` (default `"EN"`), `format?` (`"html"` default, `"markdown"`, `"xml"` Formex4), `content_mode?` (`"paged"` default, `"full"`, `"metadata_only"`), `offset?`/`limit?`, `outline?`, `select?` (`{ articles?, chapters?, recitals?, annexes? }`) | `readOnlyHint: true, idempotentHint: true` |
| `eurlex_lookup_celex` | Resolve an EU legal citation — a CELEX number, an ELI URI, or an ECLI — to the canonical CELLAR work. Returns the work URI, confirmed CELEX number, document type, date, the ECLI of a case that carries one, and whether the work exists in the corpus. The EUR-Lex analog of `courtlistener_lookup_citation`. | `identifier` (CELEX / ELI / ECLI), `identifier_type?` (`"celex"` \| `"eli"` \| `"ecli"` \| `"auto"`, default `"auto"`) | `readOnlyHint: true, idempotentHint: true` |
| `eurlex_get_cases` | Search CJEU and General Court case law — judgments, orders, and Advocate General opinions — by case number, party name, subject, or date range. A case number (`C-`, `T-`, `F-`, or a pre-1989 Court of Justice number) reaches every primary record the court filed under it; `court` selects by the CELEX court letter. Primary records only by default; derivative information notices, abstracts, summaries, and corrigenda are excluded unless `include_derivative` opts in. Returns each case's CELEX number (its sixth character names the court), work URI, ECLI, date, and document type, plus the parties, subject matter, and case reference parsed from its title. Distinct from `eurlex_search_documents` because case law has its own CELEX sector (`6`) and practitioners search it differently. | `case_number?`, `keyword?`, `court?` (`"CJEU"` \| `"GC"`), `case_type?` (`"judgment"` \| `"order"` \| `"ag_opinion"`), `include_derivative?` (default `false`), `date_from?`, `date_to?`, `offset?` (default `0`), `limit` (default `20`, max `100`) | `readOnlyHint: true` |
| `eurlex_get_relations` | Traverse CELLAR relationship graph for a given work: what amends it, what it amends, the current consolidated version, its legal basis, works that cite it (cited-by), and national transposition measures, each tagged with the member state that notified it. This is CELLAR's core value over HTML scraping — the graph traversal that exposes the lifecycle and dependencies of an EU act. | `celex_number` or `work_uri`, `relation_types?` (default: all) | `readOnlyHint: true, idempotentHint: true` |
| `eurlex_browse_subjects` | Search the EuroVoc multilingual thesaurus to resolve a human-readable term or keyword into EuroVoc concept IDs. Required before using the `eurovoc_concept` filter in `eurlex_search_documents` — agents cannot guess numeric EuroVoc concept IDs. Returns concept URI, preferred label (English), concept code, and broader/narrower hierarchy hints. | `keyword`, `language?` (default `"en"`), `limit` (default `20`, max `50`) | `readOnlyHint: true, openWorldHint: true` |
| `eurlex_query_sparql` | Execute a raw SPARQL SELECT query against the CELLAR Virtuoso endpoint. The server caps all queries at 100 results — include an explicit LIMIT in your query to control the count; if omitted or above 100 it will be injected/capped. Use only when the curated tools don't cover the needed relationship traversal. Requires familiarity with the CDM ontology (`cdm:` prefix = `http://publications.europa.eu/ontology/cdm#`). | `sparql_query` (LIMIT injected/capped at 100 by service layer), `timeout_hint?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `eurlex://document/{celexNumber}` | Metadata snapshot for a CELLAR work — type, date, title (where available), author institution, Advocates General, in-force flag; a consolidated text adds `base_act_celex` and reads its act metadata from that base act. Read-only, stable-URI injectable context. | No |
| `eurlex://document/{celexNumber}/relations` | Relationship summary for a work: amendment chain, consolidations, legal basis, cited-by count. | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `eurlex_comparative_analysis` | Frames a comparative legal analysis across EU and US law for a given policy domain. Structures the inquiry to use `eurlex_search_documents` + `eurlex_get_document` for the EU side, and `courtlistener_search_opinions` for the US counterpart. | `domain` (e.g., `"data privacy"`), `focus?` (e.g., `"enforcement mechanisms"`) |

---

## Overview

EUR-Lex MCP server wraps the **CELLAR** semantic repository operated by the EU Publications Office — the authoritative, machine-readable database of European Union law covering 2.7M+ works: treaties, regulations, directives, decisions, CJEU/General Court judgments, Advocate General opinions, and preparatory acts.

Access paths, both served by the EU Publications Office: the **CELLAR SPARQL endpoint** (`http://publications.europa.eu/webapi/rdf/sparql`) for metadata and relationship graph queries, and **CELLAR content negotiation** (`http://publications.europa.eu/resource/celex/{CELEX}`, with `Accept` / `Accept-Language` request headers) for document full text.

Audience: EU and comparative-law practitioners, regulatory and policy analysts, academics, journalists, and AI agents answering "what does EU law say about X", tracing an EU act's lifecycle, or composing EU ↔ US cross-jurisdiction comparisons.

---

## Requirements

- All queries are read-only; no authenticated or registered-user paths required
- Every SPARQL query MUST include `LIMIT` (max 100) and support `OFFSET` for pagination; Virtuoso enforces a 60-second query timeout
- Document content retrieved via CELLAR content negotiation (`GET /resource/celex/{CELEX}` with `Accept` + `Accept-Language`), the same Publications Office host as the SPARQL metadata path; the legacy `eur-lex.europa.eu/legal-content` endpoint is now behind an AWS WAF bot-challenge and no longer serves act text (issue #16)
- CELEX number is the primary document identifier; ELI URIs are the secondary
- Multilingual corpus: default to English (`EN`), expose a `language` parameter; some older acts lack EN translations
- Keyless: no API key, no registration required; both endpoints are publicly accessible
- Relationship graph is the server's primary value differentiator — `eurlex_get_relations` must traverse `cdm:work_cites_work`, amendments, consolidations, and legal basis
- EuroVoc concept IDs are required for subject-filtered searches; `eurlex_browse_subjects` is the prerequisite tool
- Keyword search matches English expression titles through Virtuoso's `bif:contains` full-text phrase index (multi-word input is quoted as a single phrase), with a CELEX arm chosen by the keyword's shape: a whole CELEX matches its bounded family of exact literals (itself, `(01)`–`(20)`, `R(01)`–`R(20)`, and the `_INF`/`_RES`/`_SUM`/`_EXT` records) plus its linked corrigenda, a partial CELEX by substring, and a keyword with no digit or with a character no CELEX holds matches titles only; a keyword with no letter or digit is rejected as `invalid_keyword`; there is no full-text search of act body text
- `eurlex_query_sparql` is an escape hatch; LIMIT is injected or capped at 100 by the service layer — if the input query omits LIMIT or sets it above 100, the service rewrites it before executing

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CellarSparqlService` | CELLAR SPARQL endpoint (`publications.europa.eu/webapi/rdf/sparql`) | All tools except `eurlex_get_document` text fetch |
| `EurLexContentService` | CELLAR content-negotiation resolver (`publications.europa.eu/resource/celex/...`) | `eurlex_get_document`, `eurlex_lookup_celex` (metadata enrichment) |

Both services are HTTP-only, no auth. `CellarSparqlService` POSTs `application/x-www-form-urlencoded` with `Accept: application/sparql-results+json`. `EurLexContentService` GETs `/resource/celex/{CELEX}` under content negotiation — `Accept: application/xhtml+xml` / `text/html` for HTML, `application/xml;type=fmx4` for Formex 4 — with an `Accept-Language` ISO 639-2/T code.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CELLAR_SPARQL_ENDPOINT` | No | `http://publications.europa.eu/webapi/rdf/sparql` | SPARQL endpoint override (e.g., for local Virtuoso mirror) |
| `EURLEX_CONTENT_BASE_URL` | No | `http://publications.europa.eu` | EU Publications Office CELLAR content-resolver base URL override |
| `SPARQL_QUERY_TIMEOUT_MS` | No | `55000` | Request timeout for SPARQL calls (slightly under Virtuoso's 60s hard limit) |
| `MAX_SPARQL_RESULTS` | No | `100` | Enforced ceiling on LIMIT in all generated SPARQL queries |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema for the four env vars above
2. **`CellarSparqlService`** — SPARQL POST client, result-binding mapper (`binding.value` extraction), LIMIT enforcement, retry on transient 5xx; CDM PREFIX declarations built in
3. **`EurLexContentService`** — content-negotiation GET client for `/resource/celex/{CELEX}`; handles language fallback when EN is unavailable
4. **`eurlex_lookup_celex`** — the foundational tool; validates CELEX/ELI/ECLI input, resolves to work URI + confirmed CELEX
5. **`eurlex_browse_subjects`** — EuroVoc thesaurus search via SPARQL; prerequisite for subject-filtered workflows
6. **`eurlex_search_documents`** — parameterized SPARQL builder; keyword, type, date, EuroVoc, in-force filters
7. **`eurlex_get_cases`** — case law variant of search; CELEX sector 6 filter, court/case-type parameters
8. **`eurlex_get_document`** — metadata via SPARQL + content text via `EurLexContentService`; assembles full response
9. **`eurlex_get_relations`** — CDM relationship traversal; deduplicated relation type output
10. **`eurlex_query_sparql`** — escape hatch; server-side LIMIT injection if missing from input
11. **Resources** — `eurlex://document/{celexNumber}` and `.../relations`
12. **Prompt** — `eurlex_comparative_analysis`

---

## Domain Mapping

| Noun | CELEX Sector | Search authority family | Operations |
|:-----|:-------------|:------------------------|:-----------|
| Regulation | `3` + `R` | `REG`, `REG_ADOPT_INTERNATION`, `REG_DEL`, `REG_FINANC`, `REG_IMPL` | search, get, get-relations, lookup |
| Directive | `3` + `L` | `DIR`, `DIR_DEL`, `DIR_IMPL` | search, get, get-relations, lookup |
| Decision | `3` + `D` | `DEC`, `DEC_ADOPT_INTERNATION`, `DEC_DEL`, `DEC_ENTSCHEID`, `DEC_FRAMW`, `DEC_IMPL` | search, get, get-relations, lookup |
| Treaty | `1` | `TREATY` | search, get, lookup |
| CJEU Judgment | `6` + `CJ` | `JUDG` | get-cases, get, lookup |
| General Court / Civil Service Tribunal Judgment | `6` + `TJ` / `6` + `FJ` | `JUDG` | get-cases, get, lookup |
| Order | `6` + `CO` / `TO` / `FO` | `ORDER` | get-cases, get, lookup |
| AG Opinion / View | `6` + `CC` / `TC`, `6` + `CP` | `OPIN_AG`, `VIEW_AG` | get-cases, get, lookup |
| Proposal | `5` | `AMEND_PROP`, `AMEND_PROP_DEC`, `AMEND_PROP_DIR`, `AMEND_PROP_REG`, `JOINT_PROP_DEC`, `JOINT_PROP_REG`, `PROP_ACT`, `PROP_DEC`, `PROP_DEC_IMPL`, `PROP_DEC_NO_ADDRESSEE`, `PROP_DIR`, `PROP_DRAFT`, `PROP_JOINT_ACTION`, `PROP_OPIN`, `PROP_RECO`, `PROP_REG`, `PROP_REG_IMPL`, `PROP_RES` | search, get, lookup |
| Recommendation | `3` + `H` | `RECO`, `RECO_ADOPT_INTERNATION`, `RECO_DEC`, `RECO_RECO`, `RECO_REG` | search, get, lookup |
| EuroVoc Concept | — | `skos:Concept` | browse-subjects |

---

## Workflow Analysis

### `eurlex_get_document` (2 upstream calls)

| # | Call | Service | Purpose |
|:--|:-----|:--------|:--------|
| 1 | SPARQL: resolve the CELEX to its work and, concurrently, locate it among its act's consolidated versions; then read the metadata (core fields, agents, legal bases, EuroVoc concepts in parallel) | `CellarSparqlService` | Title, date, type, author institutions, Advocates General, legal bases, EuroVoc concepts, in-force flag and the reason an act is not in force, base act, current consolidated version |
| 2 | GET `/resource/celex/{celex}` with `Accept: text/html` (or `application/xhtml+xml`) + `Accept-Language` | `EurLexContentService` | Full HTML text of the act in requested language |

If step 2 cannot resolve usable content for the requested language, retry with `EN`. A successful fallback records both requested and effective language. If both attempts fail ordinarily, return metadata with `content_status: "unavailable"` and a typed cause (`no_representation`, `upstream_failure`, or `multipart_incomplete`). A WAF challenge on the primary representation remains a hard `content_challenge` error; sibling-part challenge failures during multipart assembly remain best-effort unavailability.

The exact shaped `content` string is shared by `structuredContent` and the formatter. HTML and XML are presented literally in `content[]` inside a dynamically safe tilde fence longer than any tilde run in the source; Markdown remains rendered Markdown. Every body returned in one call contains at most 100,000 characters. For the contiguous modes — offset-based `paged` and `full` — clients reconstruct larger bodies through sequential `paged` calls using the returned offsets and total. A `select` response is bounded the same way but is not a contiguous window: it is a set of disjoint slices, so `has_more` stays false (its `offset = content_offset + content_chars_returned` recipe cannot resume across them), `content_offset` is absent, and a cut is disclosed through the `truncated` enrichment. `selected_sections` carries each matched section's own `offset` and `chars`, which is both the navigation the response actually has and the address that keeps every section individually reachable through the paging floor. `outline` returns no body text, so its bound is vacuous; it reports `content_chars_returned: 0` and renders a structure line rather than a character range.

> **Consolidated versions follow the based-on link (#109, #110).** Every CELEX-bearing consolidated text carries exactly one `cdm:act_consolidated_based_on_resource_legal` link to its base act and one `cdm:act_consolidated_date`, and its CELEX is in sector `0` (33,126 of them on 2026-09-25). One lookup, keyed on the typed CELEX and run concurrently with CELEX resolution, reads an act's newest consolidation — the latest date on or before today, so a consolidation dated in the future never counts, and ordered by date rather than CELEX because one act's consolidations can be numbered differently (`32000O0007` → `02000X0776-…` and `02000O0007-…`). For a consolidated CELEX the same query also returns its own date and its base act's work and CELEX; a base act's request replaces the old staleness probe, so neither path adds a serial round trip. The former `…consolidates…` edge plus a `0{act}-YYYYMMDD` CELEX match missed 968 consolidations of 443 acts and also reaches amending acts. `is_superseded` describes the text served: `false` on the newest version and on a consolidated version dated after it (which does not apply yet), `true` otherwise, present whenever the act has a consolidated version in effect; the field name stays, since #49 ruled it is not a repeal signal. With no version in effect there is nothing to be stale against, yet a future-dated text must not read as applicable: a consolidated text dated after today with no version in effect (`02021D1442-20261001`) carries a `notice` that it does not apply yet, and a base act's lookup also reads one future-dated consolidation in an OPTIONAL arm of the same query, so `resolve: "current_consolidated"` on an act with only such versions (`32021D1442`) serves the base act with a `notice` naming the pending version. A consolidated text records its act's metadata nowhere — 59,668 name the Publications Office's provisional-data code as author, none carries an in-force flag, subjects, or a legal basis — so `eurlex_get_document` and `eurlex://document` read those from the linked base act and name it in `base_act_celex`; the base CELEX is not derivable from the consolidated one (`02003T0000-20040501` → `12003T/TXT`). A consolidated text with no link, or whose base carries no CELEX, reads its own metadata.

> **An act not in force names why (#111).** Of 82,203 works CELLAR marks not in force (2026-09-25), 13,400 are the target of an explicit repeal, 59,279 have a past end of validity and no repeal edge, and 56 have an earliest entry into force still ahead. `eurlex_get_document` reads all three in the core metadata query as aggregates — `MIN(STR())` of `cdm:resource_legal_date_entry-into-force`, `MAX(STR())` of `cdm:resource_legal_date_end-of-validity`, and a `GROUP_CONCAT` of the CELEX of every work whose `cdm:resource_legal_repeals_resource_legal` names the act — so no query is added; `STR()` sidesteps CELLAR's wrong grouped `MAX` over an `OPTIONAL` `xsd:date`. They are reported only when `in_force` is false, since 334 acts in force are the target of a partial repeal: `repealed_by` (the explicit relation; implicit repeals stay with `eurlex_get_relations`), `entry_into_force` only when after today (UTC), and `end_of_validity` except CELLAR's open-ended `9999-12-31`. That placeholder is filtered inside the end-of-validity `OPTIONAL`, not after the aggregate: 249 acts not in force carry several end dates, and two (`32000D0670`, `32020D1531`) record a real one beside `9999-12-31`, which a `MAX` over both would hide. An end of validity is not always past — an act not yet in force can already carry one ahead (`32026R1975`: in force from 2026-09-29, valid until 2030-12-31). Not every act not in force carries a reason: 1,527 with a CELEX record none of the three. A consolidated text reports its base act's.

> **A work_uri carrying several CELEX serves the lowest (#104).** 19,024 works carry more than one CELEX, up to 347 each, all national implementing measures (sector 7) holding one per directive they were notified against; each is an `owl:sameAs` alias of the same work, so none is canonical. The dereference reads `MIN(STR())` and the count in one query, the order `eurlex_get_relations` reads a work's CELEX in, and a `notice` names the count and the CELEX served. Failing the call was rejected — every CELEX names the same document — as was returning every CELEX, up to 347 per call.

> **Nested selections carry each source character once (#88).** A section ends at the next heading of the same or broader rank, so two selected spans are always nested or disjoint, never partially overlapping. `content` is built from the outermost spans only: an article selected alongside the chapter holding it adds no slice and no characters to the cap, and the `truncated` notice's pre-cap total counts each character once. Adjacent sections stay separate slices. The nested section keeps its own `selected_sections` entry, and `selection.matched` is unchanged; the text rendering counts the slices `content` carries and names how many nested sections ride inside them.

### `eurlex_get_relations` (1 SPARQL call, potentially 2)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | SPARQL UNION: all `?work ?rel ?target` and `?source ?rel ?work` where rel in CDM relation set | Get all incoming and outgoing CDM relations |
| 2 | SPARQL: resolve CELEX numbers for related work URIs (if not in first result) | Enrich relation targets with CELEX for human-readable output |

CDM relation predicates to traverse (as built — see `RELATION_SPECS` in `relation-traversal.ts`; CELLAR models amendment and consolidation one-directionally, so the "reverse" types are the incoming side of the forward predicate, and the dedicated `…amended_by…`/`…has_consolidated_version…` predicates carry zero triples):
- `cdm:work_cites_work` — citation graph (both directions)
- `cdm:resource_legal_amends_resource_legal` — `amends` (outgoing) and `amended_by` (incoming)
- `cdm:resource_legal_repeals_resource_legal` — `repeals`/`repealed_by`; `…implicitly_repeals…` likewise for the implicit pair
- `cdm:resource_legal_based_on_resource_legal` — legal basis
- `cdm:act_consolidated_based_on_resource_legal` — `consolidated_version` (incoming: each consolidated text points back to its one base act)

---

## Design Decisions

**Tool split: `eurlex_search_documents` vs `eurlex_get_cases`**
Case law is a distinct sub-audience (litigation practitioners, academics, agents tracking precedent) with different search parameters (case number, court, party, AG opinion type). Merging into one tool with a `document_type` filter buries the case-law-specific parameters. The split mirrors how EUR-Lex itself separates legislation from case law browsing.

**No full-text search across document body text**
CELLAR SPARQL search is metadata-and-title only; full-text search of act body text is not available via the public SPARQL endpoint. The `keyword` parameter on `eurlex_search_documents` and `eurlex_get_cases` matches English expression titles through Virtuoso's `bif:contains` full-text index (multi-word input quoted as a phrase) and CELEX numbers — by exact lookup for a whole CELEX and its bounded sibling family, by substring for a partial one, not at all for a keyword with no digit — never the act body. This is a real limitation — document the constraint clearly in tool descriptions.

**Content via CELLAR content negotiation, not EUR-Lex REST (issue #16)**
The `eur-lex.europa.eu/legal-content` endpoint is now fronted by an AWS WAF that returns a JavaScript bot-challenge stub instead of act text, so content is fetched from the CELLAR resolver at `http://publications.europa.eu/resource/celex/{CELEX}` — the same Publications Office host as the SPARQL metadata path — by content negotiation. `Accept` selects the representation (OJ legislation exposes `application/xhtml+xml`, CJEU judgments expose `text/html`, so the HTML path tries both; Formex 4 uses `application/xml;type=fmx4`) and `Accept-Language` carries an ISO 639-2/T code. Multi-part OJ acts return HTTP 300 (Multiple Choices) and are reassembled from their sibling Formex streams. HTML is the primary format; Markdown is rendered server-side from it. Any response carrying a WAF challenge signature is refused and raised as `ServiceUnavailable`, never surfaced as content.

**`eurlex_query_sparql` as escape hatch (included)**
CELLAR's CDM ontology has ~200+ predicates; the curated tools cover the 80% case. A raw SPARQL tool is warranted given the wikidata-server precedent and CELLAR's depth. Server-side LIMIT injection (cap to 100) prevents timeout abuse. The tool earns its keep.

**EuroVoc predicate is `cdm:work_is_about_concept_eurovoc`**
Not `cdm:work_is_about_subject_matter` (that's a separate EU subject-matter authority) and not `cdm:work_is_about_subject` (the correct name is `work_is_about_concept_eurovoc`). Confirmed by inspecting GDPR's predicate set via SPARQL. The wrong predicate was in the idea doc sketch — this was caught by live API probing.

**Title keyword search via the `bif:contains` full-text index (issue #17)**
The title match runs through Virtuoso's `bif:contains` full-text index rather than a `FILTER(CONTAINS(LCASE(?title), …))` scan: the scan forced the expression graph to be joined for every candidate work before the term was tested, so a broad keyword timed out. Multi-word input is quoted as a single phrase (`bif:contains "'data protection'"`), and the input is sanitised to letters, digits, and spaces so it cannot break out of the phrase. The CELEX arm is a UNION arm chosen from the uppercased keyword (#105), shared by both search tools: none when the keyword has no digit or a character outside `[0-9A-Z()/_-]` (a digit-free keyword could only hit type letters across every CELEX literal, and `privacy` went from 43 s to 0.7 s with identical rows); exact typed literals `"…"^^xsd:string` when a work carries the keyword as its whole CELEX (`32016R0679` went from 29 s to 0.5 s); otherwise the `CONTAINS` substring scan, so `2016R0679` still reaches `02016R0679-20160504`. Whether the keyword is whole is decided by a lookup rather than by pattern, since `02016R0679` and `72014L0056` are CELEX-shaped prefixes no work carries. That one lookup joins a `VALUES` list of the keyword's bounded family — itself, the numbered siblings `(01)`–`(20)`, the corrigenda `R(01)`–`R(20)`, and the `_INF`, `_RES`, `_SUM`, and `_EXT` records of the CELEX and of each numbered sibling, 125 literals — and returns the members CELLAR carries; when the keyword itself is among them, the search joins those members as a `VALUES` list, plus the works whose `cdm:resource_legal_corrects_resource_legal` points at the CELEX. The family keeps the recall the substring scan gave a whole CELEX (`62023CO0097` reaches its `(01)` and `(02)` orders, `32016R0679` its `R(01)`–`R(03)`) without scanning. The vocabulary and the bound come from a live survey of every CELEX (2026-09-25): past the base, sector 6 carries `(nn)` up to `(20)`, `_INF`, `_SUM`, `_RES`, `_EXT`, those four on a numbered sibling, and `R(01)`; sector 3 carries `R(nn)` up to `R(30)` and `(nn)` up to `(61)`, with under 1% of corrigenda and 8% of numbered siblings past 20. Longer forms, a corrigendum of a numbered sibling, and sector-3 `P…` parts stay out of the family. The 125-literal lookup ran in 0.37–0.58 s, and the widened search arm matched the plain exact arm (0.29–0.39 s against 0.29–0.31 s). `eurlex_get_cases` still admits the notice, abstract, and summary records only under `include_derivative`, through the derivative-type filter every row passes; an `_EXT` extract is typed `JUDG_EXTRACT`, a primary record. A keyword with no letter or digit can match no title and no CELEX, so both tools reject it as `invalid_keyword` before any CELLAR call rather than answer it with an empty page that drops every other filter. (The EuroVoc label search in `eurlex_browse_subjects` is a different path and still uses `FILTER(CONTAINS(LCASE(?label), …))`.)

**Document categories use explicit authority families; consolidations follow the basic-act edge**
The CELLAR resource-type authority publishes the variants as separate top concepts, without a hierarchy that can safely expand `REG`, `DIR`, or the other public categories. `eurlex_search_documents` therefore uses a reviewed exact-code family for each `document_type`; name-prefix matching is not part of the contract, and draft regulation/directive/decision/recommendation concepts remain proposal records rather than adopted-act family members. When `include_consolidated` is enabled, a `CONS_TEXT` work qualifies only when `cdm:act_consolidated_based_on_resource_legal` reaches a basic act in the selected family. The broader `cdm:act_consolidated_consolidates_resource_legal` relation is not used: it also points to amendments and prior consolidations, so `consolidated_version` traversal and `eurlex_get_document`'s consolidation lookup follow the based-on link too.

**Advocates General get their own field; authors are institutions only (#96)**
`cdm:work_created_by_agent` lists the Advocate General (a `cdm:person`) beside the court on case law, and the deciding court (a `cdm:court_national`) on sector-8 national decisions; both are CELLAR resources, not authority codes, so labelling them through the corporate-body table leaked UUIDs. `author_institution(s)` keep their "institution" contract: a national court is labelled by `cdm:court_national_name`, and person creators are dropped, since each is also that work's `cdm:case-law_delivered_by_advocate-general`. That predicate feeds `advocates_general`, surnames from `cdm:agent_name`, sorted, on `eurlex_get_document` and `eurlex://document/{celexNumber}`, both read through `work-agents.ts`. The query reads person and court names through separate `OPTIONAL` variables; one variable shared by two `OPTIONAL`s leaves the second unbound on CELLAR.

**Relation pages order by a string date, then work URI (#100)**
Each relation direction is grouped per related work and paged newest-first. CELLAR evaluates `MAX` over the `OPTIONAL` `xsd:date` wrongly in that grouped query, attaching other works' dates and not the same ones on every call, so pages were neither the newest works nor stable. The aggregate is `MAX(STR(?relatedDate))`, since ISO dates sort lexically in date order, and both the per-direction subquery and the outer `UNION` order by `DESC(?relatedDateMax) ?relatedWork`: the work URI is the `GROUP BY` key, so the order is total and consecutive offsets neither overlap nor skip. An undated work's aggregate stays unbound and sorts last. `has_more` counts a sentinel row and does not depend on the order.

**Search pages order by date, then CELEX (#102)**
`eurlex_search_documents` and `eurlex_get_cases` order by `DESC(?docDate) ?celexNumber`. Ordering by date alone left records that share a date in an order CELLAR varied between calls, so identical calls returned different pages and consecutive offsets could repeat one record and never return another. The tiebreak is the `GROUP BY` key `?celexNumber`, not the projected `?celex`: Virtuoso does not sort on a `SAMPLE` alias of a string, and a `?celex` tiebreak returned same-date rows in a different order on each call.

**Date-bounded searches page first (#98, #105)**
When `eurlex_get_cases` or `eurlex_search_documents` has a `date_from` or `date_to`, a subquery selects the page's CELEX keys in the same total order (`SAMPLE(?date) AS ?pageDate`, `LIMIT`/`OFFSET`), and the outer query repeats the row pattern and aggregates only those keys; the flat form aggregated every match before paging. The row date is `?pageDate`, and the date stays `SAMPLE` at both levels: a `MAX` over the ordered date lets Virtuoso pick a date-index TOP-k plan that drops the upper-bound filter. The outer query tests the keyword as `FILTER EXISTS`, because re-joining it re-ran the full-text and CELEX-substring arms over the corpus and made wide-range keyword searches slower than the flat form. In paired live runs against the tie-broken flat form, every shape returned identical rows and fields; a one-month range went from 9.5–46 s to 0.35–1.0 s, and a single `date_from` or `date_to` bound was faster too, so any bound selects the page-first form. A search with no date bound keeps the flat form: finding a broad browse's page keys costs about as much as the whole query. `eurlex_search_documents` also tests the author as `FILTER EXISTS` at the outer level, for the same full-text reason. Its date-bounded searches had passed the 55 s client timeout even for a single day; paged first, a month range, a single day, a single bound, and the keyword, EuroVoc, author, and consolidated-text combinations each returned identical rows in 0.6–1.6 s (a `REG` + half-month search went from 13.8 s to 1.4 s, a lone `date_from` from 110 s to 0.6 s). A keyword-only search stays flat, where it ran faster than paged first.

**Formex quotation marks render from their `CODE` (#99)**
Formex writes a quotation mark as `<QUOT.START CODE="2018"/>` / `<QUOT.END …>` (or an empty start/end pair), naming the character by its hex code point. `formexText()` turns a valid one into a character reference in place, which the single decoding pass renders with no padding, so XML outline titles match the HTML ones in every language; a missing, non-hex, out-of-range, surrogate, or control `CODE` is stripped as a tag, as before. Tag stripping matches `<[^<>]*>`, so a run of `<` with no `>` costs one pass.

**Resources are supplementary**
`eurlex://document/{celexNumber}` covers the `tools/list`-stable URI use case; the content is fully reachable through `eurlex_get_document`. No unique data lives only in resources.

---

## Error Contracts

Typed error contracts for each tool — these become the literal `errors: [{ reason, code, when }]` entries during implementation. Baseline infrastructure errors (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`) bubble freely from the service layer and don't need declaring per tool.

**`eurlex_search_documents` / `eurlex_get_cases`**
| reason | code | when |
|:-------|:-----|:-----|
| `no_filters` | `ValidationError` | `eurlex_search_documents` only: no narrowing filter was supplied, so the query would scan the whole corpus |
| `invalid_date_range` | `ValidationError` | `date_from`/`date_to` is not a real calendar date, or the range is inverted |
| `invalid_case_number` | `ValidationError` | `eurlex_get_cases` only: `case_number` is not a recognizable case number and holds characters no CELEX contains, names more than one case, or is a prefix-less number dated outside 1953–1988 |
| `invalid_author_institution` | `ValidationError` | `eurlex_search_documents` only: `author_institution` holds no letters or digits, so it can name no institution |
| `invalid_keyword` | `ValidationError` | `keyword` holds no letters or digits, so no title and no CELEX can match it |
| `sparql_error` | `ServiceUnavailable` | Virtuoso returned HTTP 200 with `Virtuoso 37000 Error` body; query is malformed or timed out |

> **Zero hits is an empty page, not an error (#112).** An empty first page from `eurlex_search_documents`, `eurlex_get_cases`, `eurlex_browse_subjects`, or `eurlex_get_relations` returns the same shape as an exhausted later page — `total: 0`, `has_more: false`, no `next_offset`, plus `query_echo` or `requested_relation_types`/`empty_relation_types` — with an enrichment `notice` naming what matched nothing and how to broaden it. A thrown `NotFound` read as a broken call and invited retrying the same query. A page past the end carries no notice. Only input the server can prove wrong stays an error: an `author_institution` with no letters or digits is `invalid_author_institution` and a `keyword` with none is `invalid_keyword`, while a well-formed author or keyword matching nothing is an empty page. A page with more rows carries a `notice` naming the next offset, alongside `truncated`/`shown`/`cap`. A notice quotes each filter value to at most 100 characters plus an ellipsis, as do the validation messages that quote one; `query_echo` keeps the whole value.

> **Case numbers match every document letter the court files (#81, #91).** A case-law CELEX reads `6{year}{court}{document}{number}`, and one case spans several document letters (judgment `CJ`, order `CO`, AG opinion `CC`, …). `case_number` fixes year, court letter, and number and matches the court's document letters — `C`: `J O C P S T D`, `T`: `J O C T`, `F`: `J O`, plus the notice letters `A B N` when `include_derivative` admits derivatives — as an unanchored `REGEX` (echoed as `celex_fragment`, e.g. `2023C*0097`). The Court of Justice's numbered Opinions and Rulings (`CV`, `CU`, `CG`, `CX`) are left out: they are cited as "Opinion 2/13" and their CELEX collides with the `C-n/yy` case of the same number. Text after the year is ignored as a procedural suffix unless it holds another case designation (a digit, `/` or a hyphen, a digit): "C-131/12 and C-132/12" is rejected as `invalid_case_number` rather than answered for C-131/12 alone. `court` keys on the court letter alone (`FILTER(SUBSTR(STR(?celexNumber), 6, 1) = "C")`), so every record a court filed stays reachable whatever its document letter, derivatives still only under `include_derivative`. A value that parses as no case number keeps the escaped CELEX-substring match only when made of CELEX characters `[0-9A-Za-z()_]` — every sector-6 CELEX is, so nothing else can ever match there and is rejected as `invalid_case_number` instead of answered with an empty page.

**`eurlex_get_document`**
| reason | code | when |
|:-------|:-----|:-----|
| `invalid_identifier_args` | `ValidationError` | Zero or more than one of `celex_number`, `eli_uri`, and `work_uri` were supplied — provide exactly one |
| `not_found` | `NotFound` | CELEX, ELI, or work URI not found in CELLAR — work does not exist in the corpus |
| `content_challenge` | `ServiceUnavailable` | The primary EUR-Lex representation returned a WAF challenge instead of act content; retry later or request `metadata_only` |

**`eurlex_lookup_celex`**
| reason | code | when |
|:-------|:-----|:-----|
| `ambiguous_identifier` | `ValidationError` | `identifier_type: "auto"` could not determine format — supply `identifier_type` explicitly |

A well-formed identifier that matches no work returns `found: false`, not an error.

> **OJ references dropped as an identifier type (#5).** Live CELLAR research found no resolvable path: an OJ reference like "OJ L 119" has no literal in CELLAR (the journal issue appears only as cellar-UUID and `oj:JOL_…` token forms), the issue-level resource maps to multiple acts (OJ L 119/2016 → GDPR + the Police and PNR Directives), and the reference carries no year. Resolution is CELEX (`cdm:resource_legal_id_celex`), ELI (`cdm:resource_legal_eli`, an `xsd:anyURI` literal), and ECLI (`cdm:case-law_ecli`) only.

> **ECLIs resolve by a typed exact match (#84).** `cdm:case-law_ecli` is an `xsd:string`-typed literal: an untyped literal matches nothing, and `FILTER(STR(?ecli) = …)` scans, so the lookup joins `VALUES ?ecli { "…"^^xsd:string }`. Every EU ECLI is uppercase (`^ECLI:EU:[CTF]:\d{4}:\d+$`), so the uppercased form is sent alongside the caller's spelling; national ECLIs keep mixed case (`ECLI:FI:HelHO:2015:1766`), so an exact-spelling row wins. One ECLI can reach several works — two work URIs sharing a CELEX, `_RES`/`_SUM` siblings, an `_EXT` extract, a joined AG opinion's second CELEX — so derivative-typed CELEX numbers are set aside and the lowest CELEX left wins; the work within that CELEX follows the canonical-work rule below (#97). No work carrying an ELI carries an ECLI, so the shared ELI query binds none. `eurlex_get_cases` binds each row's ECLI with an `OPTIONAL` in its grouped query (`MAX(?caseEcli)` per CELEX group), at the outer level when a date bound puts the page keys in a subquery (#98). An ECLI names the case, not one work: a CELEX lookup reports the resolved work's ECLI, else the lowest ECLI any other work of that CELEX records, since a canonical work can carry none while its `do_not_index` copies do (`62015TO0235(01)`).

> **CELEX lookups bind a typed literal (#92).** Every CELEX literal in CELLAR is `xsd:string`-typed (sampled across sectors 0–7, C, and E), so each query keyed on a caller's CELEX — `eurlex_lookup_celex`, the shared CELEX → work resolution, and `eurlex_get_document`'s consolidation query — writes the CELEX through `celexLiteral()`, either as the object of `?work cdm:resource_legal_id_celex "…"^^xsd:string` or in `VALUES ?celexNumber { "…"^^xsd:string }`. Both resolve from the index in well under a second and return the same works as `FILTER(STR(?c) = "…")`, which scans every CELEX literal and took seconds. An untyped literal matches nothing, so the datatype is load-bearing. Metadata and relation queries then key on the resolved work's IRI, not the CELEX.

> **A CELEX held by several works resolves to one canonical work (#97).** CELLAR holds 14,265 CELEX numbers under more than one work (2026-09-25): `cdm:do_not_index` copies on case law and preparatory acts, and on three General Court CELEX a work aliased `…_EXT`. Exactly one of them is `owl:sameAs <http://publications.europa.eu/resource/celex/{CELEX}>`, the IRI the content resolver serves the body from; `work-resolution.ts` picks that work, else the lowest work URI, independent of row order. The alias IRI is built in SPARQL with `ENCODE_FOR_URI` (CELLAR stores `(`/`)` as `%28`/`%29`, which `encodeURIComponent` leaves literal) inside a filtered `OPTIONAL` in an ungrouped query; a `VALUES` + `BIND(EXISTS …)` form returned the same rows in ~20 s, and the `OPTIONAL` inside a grouped query never binds. `eurlex_lookup_celex` carries the pattern in its own query; `eurlex_get_document`, both `eurlex://document` resources, and `eurlex_get_relations` resolve through `resolveCelexWorks` and then key every query on the resolved work, so a CELEX-keyed join can no longer read the union of all its works. `eurlex_get_cases` and `eurlex_search_documents` resolve a page's CELEX values in one follow-up `VALUES` query; their grouped `MAX(?titledWork)`/`SAMPLE(?work)` stay as the fallback. The other works are not reported.

> **Bare work-level ELIs resolve via `/oj` normalization (#5).** CELLAR stores only the OJ-manifestation literal (`…/{number}/oj`), so the common bare citation form (`http://data.europa.eu/eli/reg/2016/679`) misses on exact match. A bare work-level ELI (`{type}/{year}/{number}`, no manifestation suffix) that returns no rows retries once with `/oj` appended — deterministic and one-to-one (verified live across regulation `32016R0679`, directive `32016L0680`, decision `32013D1313`, each `COUNT(DISTINCT ?work) = 1`). Manifestation-suffixed ELIs (e.g. a `/YYYY-MM-DD` consolidated version) are excluded from the retry, so a missing consolidated version never silently falls back to the original act.

**`eurlex_get_relations`**
| reason | code | when |
|:-------|:-----|:-----|
| `not_found` | `NotFound` | CELEX not found — resolve with `eurlex_lookup_celex` first. A `work_uri` is used as given and not checked, so an unknown one returns an empty page whose notice points to `eurlex_get_document` |

A work with no edges of the requested types returns an empty page with a `notice`, not an error.

**`eurlex_browse_subjects`**

No typed errors: a keyword that matches no concept returns an empty page with a `notice` suggesting a broader term, and a retry in English when the search was in another language.

**`eurlex_query_sparql`**
| reason | code | when |
|:-------|:-----|:-----|
| `sparql_error` | `InvalidParams` | Virtuoso returned a syntax/semantic error — fix the SPARQL query |
| `sparql_timeout` | `ServiceUnavailable` | Query exceeded the 60s Virtuoso hard limit — add more specific filters or reduce scope |

**Virtuoso error classification note:** Virtuoso returns HTTP 200 even for errors; the response body starts with `Virtuoso 37000 Error SP030:`. The service layer must inspect the body and throw `ServiceUnavailable` (transient/timeout) or `InvalidParams` (syntax error) rather than treating any HTTP 200 as a success.

---

## Known Limitations

- **No full-text body search**: SPARQL keyword search applies to titles and CELEX strings only. Deep full-text search across act body text requires the EUR-Lex registered-user web service (SOAP, requires EU login) — out of scope.
- **Title sparsity**: `cdm:work_title` is populated for most legislative acts but absent for many CJEU judgments and older works. Tool outputs must treat title as optional.
- **Language availability**: older acts (pre-2004 accession) may lack EN translations. Some newer acts exist only in the language of the originating institution.
- **Relation graph depth**: `eurlex_get_relations` returns direct one-hop relations only. Multi-hop traversal (e.g., full amendment chain back to 1990) requires multiple calls or a `eurlex_query_sparql` query.
- **Consolidation**: the "current consolidated text" is a separate CELEX-numbered work, not a flag on the original. `eurlex_get_relations` surfaces it via the incoming `cdm:act_consolidated_based_on_resource_legal` edge (the forward `…has_consolidated_version…` predicate carries zero triples); fetching the consolidated text requires a follow-up `eurlex_get_document` call, or `resolve: "current_consolidated"` in one.
- **60-second Virtuoso timeout**: all generated SPARQL includes `LIMIT` enforcement at the service layer. Complex queries (deep relation traversal, large UNION blocks) can still time out. The `SPARQL_QUERY_TIMEOUT_MS` config gives a client-side abort before Virtuoso's hard cut.

---

## API Reference

### SPARQL Endpoint

- **URL**: `http://publications.europa.eu/webapi/rdf/sparql`
- **Method**: POST
- **Content-Type**: `application/x-www-form-urlencoded`
- **Body**: `query=<url-encoded SPARQL>` (or `query=...&format=application%2Fsparql-results%2Bjson`)
- **Accept**: `application/sparql-results+json`
- **Timeout**: 60 seconds (Virtuoso hard limit); enforce client-side at 55s
- **Error shape**: plain text `Virtuoso 37000 Error SP030: ...` (HTTP 200 status even on SPARQL errors — service must inspect the body and classify: syntax/semantic errors → `InvalidParams`; timeout messages (`SP031`) → `ServiceUnavailable`)

**Required PREFIX declarations:**
```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
```

**Result binding shape (JSON):**
```json
{
  "head": { "vars": ["work", "celexNumber", "date"] },
  "results": {
    "bindings": [
      {
        "work": { "type": "uri", "value": "http://publications.europa.eu/resource/cellar/3e485e15-..." },
        "celexNumber": { "type": "literal", "datatype": "http://www.w3.org/2001/XMLSchema#string", "value": "32016R0679" },
        "date": { "type": "literal", "datatype": "http://www.w3.org/2001/XMLSchema#date", "value": "2016-04-27" }
      }
    ]
  }
}
```

**SPARQL patterns (confirmed against live endpoint):**

CELEX lookup:
```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?work ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex "32016R0679"^^xsd:string .
  ?work cdm:work_has_resource-type ?type .
  OPTIONAL { ?work cdm:work_date_document ?date . }
} LIMIT 5
```

Search by type + date:
```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?work ?celexNumber ?type ?date WHERE {
  VALUES ?selectedType {
    <http://publications.europa.eu/resource/authority/resource-type/REG>
    <http://publications.europa.eu/resource/authority/resource-type/REG_ADOPT_INTERNATION>
    <http://publications.europa.eu/resource/authority/resource-type/REG_DEL>
    <http://publications.europa.eu/resource/authority/resource-type/REG_FINANC>
    <http://publications.europa.eu/resource/authority/resource-type/REG_IMPL>
  }
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ?work cdm:work_has_resource-type ?selectedType .
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
  ?work cdm:work_date_document ?date .
  FILTER(?date >= "2023-01-01"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 20 OFFSET 0
```

EuroVoc subject filter (correct predicate — NOT `work_is_about_subject_matter`):
```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?work ?celexNumber WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ?work cdm:work_is_about_concept_eurovoc <http://eurovoc.europa.eu/2828> .
} LIMIT 20 OFFSET 0
```

EuroVoc concept search:
```sparql
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?concept ?label ?code WHERE {
  ?concept a skos:Concept .
  ?concept skos:prefLabel ?label .
  ?concept skos:notation ?code .
  FILTER(LANG(?label) = "en")
  FILTER(CONTAINS(LCASE(STR(?label)), "privacy"))
} LIMIT 20
```

Relation traversal:
```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?relatedWork ?relatedCelex ?relationType WHERE {
  VALUES ?workUri { <http://publications.europa.eu/resource/cellar/3e485e15-...> }
  {
    ?relatedWork ?relationType ?workUri .
    ?relatedWork cdm:resource_legal_id_celex ?relatedCelex .
  } UNION {
    ?workUri ?relationType ?relatedWork .
    ?relatedWork cdm:resource_legal_id_celex ?relatedCelex .
  }
} LIMIT 50
```

### CELEX Number Format

| Sector | Domain | Type Examples | Example CELEX |
|:-------|:-------|:--------------|:--------------|
| `1` | Treaties | `CEE`, `UE` | `11957E` |
| `3` | Secondary legislation | `R` (Reg), `L` (Dir), `D` (Dec) | `32016R0679` |
| `5` | Preparatory acts | Various | `52016PC0467` |
| `6` | CJEU case law | court letter `C`/`T`/`F` + document letter: `J` (judgment), `O` (order), `C` (AG opinion), `P` (AG view), `A`/`B`/`N` (notices), … | `62024CJ0629` |
| `7` | National transposition measures | the transposed act's `{year}{type}{number}`, the notifying member state's ISO 3166-1 alpha-3 code (the 27 member states plus `GBR`), then `_` and the measure number | `72016L0680CZE_202505539` |

Format: `{sector}{year}{type}{number}` — e.g., `3` (sector) + `2016` (year) + `R` (regulation) + `0679` (serial) = `32016R0679` (GDPR). In sector 6 the type is two letters, the court (`C` Court of Justice, `T` General Court, `F` Civil Service Tribunal) then the document; the pairs in use are `CA CB CC CD CG CJ CN CO CP CS CT CU CV CX`, `TA TB TC TJ TN TO TT`, and `FA FB FJ FN FO`.

### CELLAR Content Negotiation

Act text is fetched from the EU Publications Office CELLAR resolver by content negotiation; the `eur-lex.europa.eu/legal-content` endpoint is now WAF-protected and no longer serves body text (issue #16).

- **URL**: `http://publications.europa.eu/resource/celex/{CELEX}` — format and language come from request headers, not the path
- **HTML**: `Accept: application/xhtml+xml` (OJ legislation) or `text/html` (CJEU judgments) → HTTP 200 with the act body; the HTML path tries both variants in order
- **Formex 4 XML**: `Accept: application/xml;type=fmx4` → HTTP 200 for a single-part act, or HTTP 300 (Multiple Choices) listing the sibling part streams, which are fetched and reassembled into one document
- **Language**: `Accept-Language` requires an ISO 639-2/T three-letter code (`eng`, `fra`, `deu`, …); bibliographic 639-2/B codes (`ger`, `fre`) return HTTP 400. EUR-Lex two-letter codes are mapped before the request, and the fetch falls back to English when the requested language has no content
- **Bot-challenge guard**: a response carrying an AWS WAF challenge signature is refused and raised as `ServiceUnavailable`, never reported as available content
- Language codes accepted (mapped to ISO 639-2/T): `EN`, `FR`, `DE`, `ES`, `IT`, `PL`, `PT`, `NL`, `CS`, `DA`, `EL`, `ET`, `FI`, `HU`, `LT`, `LV`, `MT`, `RO`, `SK`, `SL`, `SV`, `BG`, `HR`, `GA`
