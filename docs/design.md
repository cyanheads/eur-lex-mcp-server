# EUR-Lex MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eurlex_search_documents` | Search EU legislation, case law, treaties, and preparatory acts across the CELLAR corpus. Filters by document type, date range, EuroVoc subject concept, author institution, and in-force status. Returns CELEX numbers, work URIs, document types, and dates — use these with `eurlex_get_document` to fetch full content. | `keyword?`, `document_type?`, `date_from?`, `date_to?`, `eurovoc_concept?`, `in_force?`, `offset?` (default `0`), `limit` (default `20`, max `100`) | `readOnlyHint: true` |
| `eurlex_get_document` | Fetch the notice (metadata) and full text of a work by CELEX number or ELI URI. Returns structured metadata (title, date, document type, author institution, legal basis, EuroVoc subjects) plus the HTML, Markdown, or Formex4 XML content in the requested language. Large bodies are paged (`content_mode`/`offset`/`limit`) or reachable in full; `outline` returns a structural heading list and `select` returns specific sections by number. Defaults to English; not all works have content in all 24 official languages. | `celex_number` or `eli_uri`, `language?` (default `"EN"`), `format?` (`"html"` default, `"markdown"`, `"xml"` Formex4), `content_mode?` (`"paged"` default, `"full"`, `"metadata_only"`), `offset?`/`limit?`, `outline?`, `select?` (`{ articles?, chapters?, recitals?, annexes? }`) | `readOnlyHint: true, idempotentHint: true` |
| `eurlex_lookup_celex` | Resolve an EU legal citation — a CELEX number or an ELI URI — to the canonical CELLAR work. Returns the work URI, confirmed CELEX number, document type, date, and whether the work exists in the corpus. The EUR-Lex analog of `courtlistener_lookup_citation`. | `identifier` (CELEX / ELI), `identifier_type?` (`"celex"` \| `"eli"` \| `"auto"`, default `"auto"`) | `readOnlyHint: true, idempotentHint: true` |
| `eurlex_get_cases` | Search CJEU and General Court case law — judgments, orders, and Advocate General opinions — by case number, party name, subject, or date range. Primary records only by default; derivative information notices, abstracts, and summaries are excluded unless `include_derivative` opts in. Returns case identifier, court, date, document type, and the parties. Distinct from `eurlex_search_documents` because case law has its own CELEX sector (`6`) and practitioners search it differently. | `case_number?`, `keyword?`, `court?` (`"CJEU"` \| `"GC"`), `case_type?` (`"judgment"` \| `"order"` \| `"ag_opinion"`), `include_derivative?` (default `false`), `date_from?`, `date_to?`, `offset?` (default `0`), `limit` (default `20`, max `100`) | `readOnlyHint: true` |
| `eurlex_get_relations` | Traverse CELLAR relationship graph for a given work: what amends it, what it amends, the current consolidated version, its legal basis, works that cite it (cited-by), and national transposition measures. This is CELLAR's core value over HTML scraping — the graph traversal that exposes the lifecycle and dependencies of an EU act. | `celex_number` or `work_uri`, `relation_types?` (default: all) | `readOnlyHint: true, idempotentHint: true` |
| `eurlex_browse_subjects` | Search the EuroVoc multilingual thesaurus to resolve a human-readable term or keyword into EuroVoc concept IDs. Required before using the `eurovoc_concept` filter in `eurlex_search_documents` — agents cannot guess numeric EuroVoc concept IDs. Returns concept URI, preferred label (English), concept code, and broader/narrower hierarchy hints. | `keyword`, `language?` (default `"en"`), `limit` (default `20`, max `50`) | `readOnlyHint: true, openWorldHint: true` |
| `eurlex_query_sparql` | Execute a raw SPARQL SELECT query against the CELLAR Virtuoso endpoint. The server caps all queries at 100 results — include an explicit LIMIT in your query to control the count; if omitted or above 100 it will be injected/capped. Use only when the curated tools don't cover the needed relationship traversal. Requires familiarity with the CDM ontology (`cdm:` prefix = `http://publications.europa.eu/ontology/cdm#`). | `sparql_query` (LIMIT injected/capped at 100 by service layer), `timeout_hint?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `eurlex://document/{celexNumber}` | Metadata snapshot for a CELLAR work — type, date, title (where available), author institution, in-force flag. Read-only, stable-URI injectable context. | No |
| `eurlex://document/{celexNumber}/relations` | Relationship summary for a work: amendment chain, consolidations, legal basis, cited-by count. | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `eurlex_comparative_analysis` | Frames a comparative legal analysis across EU and US law for a given policy domain. Structures the inquiry to use `eurlex_search_documents` + `eurlex_get_document` for the EU side, and `courtlistener_search_opinions` for the US counterpart. | `domain` (e.g., `"data privacy"`), `focus?` (e.g., `"enforcement mechanisms"`) |

---

## Overview

EUR-Lex MCP server wraps the **CELLAR** semantic repository operated by the EU Publications Office — the authoritative, machine-readable database of European Union law covering 2.7M+ works: treaties, regulations, directives, decisions, CJEU/General Court judgments, Advocate General opinions, and preparatory acts.

Access paths: the **CELLAR SPARQL endpoint** (`http://publications.europa.eu/webapi/rdf/sparql`) for metadata and relationship graph queries, and the **EUR-Lex REST content API** (`https://eur-lex.europa.eu/legal-content/{LANG}/TXT/{FORMAT}/?uri=CELEX:{CELEX}`) for document full text.

Audience: EU and comparative-law practitioners, regulatory and policy analysts, academics, journalists, and AI agents answering "what does EU law say about X", tracing an EU act's lifecycle, or composing EU ↔ US cross-jurisdiction comparisons.

---

## Requirements

- All queries are read-only; no authenticated or registered-user paths required
- Every SPARQL query MUST include `LIMIT` (max 100) and support `OFFSET` for pagination; Virtuoso enforces a 60-second query timeout
- Document content retrieved via EUR-Lex REST (`legal-content` URL), not CELLAR content negotiation (CELLAR work URIs return 400 on direct GET)
- CELEX number is the primary document identifier; ELI URIs are the secondary
- Multilingual corpus: default to English (`EN`), expose a `language` parameter; some older acts lack EN translations
- Keyless: no API key, no registration required; both endpoints are publicly accessible
- Relationship graph is the server's primary value differentiator — `eurlex_get_relations` must traverse `cdm:work_cites_work`, amendments, consolidations, and legal basis
- EuroVoc concept IDs are required for subject-filtered searches; `eurlex_browse_subjects` is the prerequisite tool
- `bif:contains` multi-word full-text search is not available in Virtuoso; keyword search uses `FILTER(CONTAINS(LCASE(?title), ...))` on title or CELEX string patterns
- `eurlex_query_sparql` is an escape hatch; LIMIT is injected or capped at 100 by the service layer — if the input query omits LIMIT or sets it above 100, the service rewrites it before executing

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CellarSparqlService` | CELLAR SPARQL endpoint (`publications.europa.eu/webapi/rdf/sparql`) | All tools except `eurlex_get_document` text fetch |
| `EurLexContentService` | EUR-Lex REST content API (`eur-lex.europa.eu/legal-content/...`) | `eurlex_get_document`, `eurlex_lookup_celex` (metadata enrichment) |

Both services are HTTP-only, no auth. `CellarSparqlService` POSTs `application/x-www-form-urlencoded` with `Accept: application/sparql-results+json`. `EurLexContentService` GETs `text/html` or `application/xml`.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CELLAR_SPARQL_ENDPOINT` | No | `http://publications.europa.eu/webapi/rdf/sparql` | SPARQL endpoint override (e.g., for local Virtuoso mirror) |
| `EURLEX_CONTENT_BASE_URL` | No | `https://eur-lex.europa.eu` | EUR-Lex content API base URL override |
| `SPARQL_QUERY_TIMEOUT_MS` | No | `55000` | Request timeout for SPARQL calls (slightly under Virtuoso's 60s hard limit) |
| `MAX_SPARQL_RESULTS` | No | `100` | Enforced ceiling on LIMIT in all generated SPARQL queries |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema for the four env vars above
2. **`CellarSparqlService`** — SPARQL POST client, result-binding mapper (`binding.value` extraction), LIMIT enforcement, retry on transient 5xx; CDM PREFIX declarations built in
3. **`EurLexContentService`** — GET client for `legal-content` URL pattern; handles language fallback when EN is unavailable
4. **`eurlex_lookup_celex`** — the foundational tool; validates CELEX/ELI input, resolves to work URI + confirmed CELEX
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

| Noun | CELEX Sector | CDM Type URI | Operations |
|:-----|:-------------|:-------------|:-----------|
| Regulation | `3` + `R` | `resource-type/REG` | search, get, get-relations, lookup |
| Directive | `3` + `L` | `resource-type/DIR` | search, get, get-relations, lookup |
| Decision | `3` + `D` | `resource-type/DEC` | search, get, get-relations, lookup |
| Treaty | `1` | `resource-type/TREATY` | search, get, lookup |
| CJEU Judgment | `6` + `CJ` | `resource-type/JUDG` | get-cases, get, lookup |
| General Court Judgment | `6` + `TJ` | `resource-type/JUDG` | get-cases, get, lookup |
| AG Opinion | `6` + `CC` / `6` + `CX` | `resource-type/OPIN_AG` | get-cases, get, lookup |
| Preparatory Act | `5` | Various | search, get, lookup |
| EuroVoc Concept | — | `skos:Concept` | browse-subjects |

---

## Workflow Analysis

### `eurlex_get_document` (2 upstream calls)

| # | Call | Service | Purpose |
|:--|:-----|:--------|:--------|
| 1 | SPARQL: work metadata by CELEX | `CellarSparqlService` | Title, date, type, author institution, EuroVoc concepts, in-force flag |
| 2 | GET `legal-content/{LANG}/TXT/HTML/?uri=CELEX:{celex}` | `EurLexContentService` | Full HTML text of the act in requested language |

If step 2 returns non-200 for the requested language, retry with `EN`. If `EN` also fails, return metadata only with a note that content is unavailable.

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
- `cdm:act_consolidated_consolidates_resource_legal` — `consolidated_version` (incoming: the consolidated act points back to the base)

---

## Design Decisions

**Tool split: `eurlex_search_documents` vs `eurlex_get_cases`**
Case law is a distinct sub-audience (litigation practitioners, academics, agents tracking precedent) with different search parameters (case number, court, party, AG opinion type). Merging into one tool with a `document_type` filter buries the case-law-specific parameters. The split mirrors how EUR-Lex itself separates legislation from case law browsing.

**No full-text search across document body text**
Virtuoso's `bif:contains` with multi-word phrases throws errors (confirmed by probe). CELLAR SPARQL search is metadata-and-title only; full-text body search is not available via the public SPARQL endpoint. The `keyword` parameter on `eurlex_search_documents` and `eurlex_get_cases` uses `FILTER(CONTAINS(LCASE(?title), ...))` on the work title and CELEX string. This is a real limitation — document the constraint clearly in tool descriptions.

**Content via EUR-Lex REST, not CELLAR content negotiation**
Direct `Accept: text/html` GET on CELLAR resource URIs returns 400 (confirmed by probe). The canonical content path is `https://eur-lex.europa.eu/legal-content/{LANG}/TXT/HTML/?uri=CELEX:{celex}`, which returned HTTP 200 with full HTML content (1MB for GDPR). HTML is the primary format; XML/Formex is the secondary for structured processing.

**`eurlex_query_sparql` as escape hatch (included)**
CELLAR's CDM ontology has ~200+ predicates; the curated tools cover the 80% case. A raw SPARQL tool is warranted given the wikidata-server precedent and CELLAR's depth. Server-side LIMIT injection (cap to 100) prevents timeout abuse. The tool earns its keep.

**EuroVoc predicate is `cdm:work_is_about_concept_eurovoc`**
Not `cdm:work_is_about_subject_matter` (that's a separate EU subject-matter authority) and not `cdm:work_is_about_subject` (the correct name is `work_is_about_concept_eurovoc`). Confirmed by inspecting GDPR's predicate set via SPARQL. The wrong predicate was in the idea doc sketch — this was caught by live API probing.

**No `bif:contains` multi-word search**
`bif:contains(?title, "data protection")` throws a Virtuoso syntax error. Single-word `bif:contains` may work but is unreliable and undocumented. Use `FILTER(CONTAINS(LCASE(?title), "data"))` instead, and for multi-word, require the agent to supply a single dominant keyword and narrow further with other filters.

**Resources are supplementary**
`eurlex://document/{celexNumber}` covers the `tools/list`-stable URI use case; the content is fully reachable through `eurlex_get_document`. No unique data lives only in resources.

---

## Error Contracts

Typed error contracts for each tool — these become the literal `errors: [{ reason, code, when }]` entries during implementation. Baseline infrastructure errors (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`) bubble freely from the service layer and don't need declaring per tool.

**`eurlex_search_documents` / `eurlex_get_cases`**
| reason | code | when |
|:-------|:-----|:-----|
| `no_results` | `NotFound` | Query returned zero bindings — no matching documents in CELLAR |
| `sparql_error` | `ServiceUnavailable` | Virtuoso returned HTTP 200 with `Virtuoso 37000 Error` body; query is malformed or timed out |

**`eurlex_get_document`**
| reason | code | when |
|:-------|:-----|:-----|
| `not_found` | `NotFound` | CELEX/ELI not found in CELLAR — work does not exist in the corpus |
| `language_unavailable` | `NotFound` | Requested language has no content in EUR-Lex; retry with `language: "en"` |
| `content_fetch_failed` | `ServiceUnavailable` | EUR-Lex content API returned non-200 after language fallback attempts |

**`eurlex_lookup_celex`**
| reason | code | when |
|:-------|:-----|:-----|
| `not_found` | `NotFound` | Identifier resolves to no CELLAR work — check the CELEX/ELI format |
| `ambiguous_identifier` | `InvalidParams` | `identifier_type: "auto"` could not determine format — supply `identifier_type` explicitly |

> **OJ references dropped as an identifier type (#5).** Live CELLAR research found no resolvable path: an OJ reference like "OJ L 119" has no literal in CELLAR (the journal issue appears only as cellar-UUID and `oj:JOL_…` token forms), the issue-level resource maps to multiple acts (OJ L 119/2016 → GDPR + the Police and PNR Directives), and the reference carries no year. Resolution is CELEX (`cdm:resource_legal_id_celex`) and ELI (`cdm:resource_legal_eli`, an `xsd:anyURI` literal) only.

> **Bare work-level ELIs resolve via `/oj` normalization (#5).** CELLAR stores only the OJ-manifestation literal (`…/{number}/oj`), so the common bare citation form (`http://data.europa.eu/eli/reg/2016/679`) misses on exact match. A bare work-level ELI (`{type}/{year}/{number}`, no manifestation suffix) that returns no rows retries once with `/oj` appended — deterministic and one-to-one (verified live across regulation `32016R0679`, directive `32016L0680`, decision `32013D1313`, each `COUNT(DISTINCT ?work) = 1`). Manifestation-suffixed ELIs (e.g. a `/YYYY-MM-DD` consolidated version) are excluded from the retry, so a missing consolidated version never silently falls back to the original act.

**`eurlex_get_relations`**
| reason | code | when |
|:-------|:-----|:-----|
| `not_found` | `NotFound` | Work URI/CELEX not found — resolve with `eurlex_lookup_celex` first |
| `no_relations` | `NotFound` | Work exists but has no CDM relations of the requested types — try other `relation_types` or omit to get all |

**`eurlex_browse_subjects`**
| reason | code | when |
|:-------|:-----|:-----|
| `no_concepts` | `NotFound` | No EuroVoc concepts matched the keyword — try a broader or English-language term |

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
- **Consolidation**: the "current consolidated text" is a separate CELEX-numbered work, not a flag on the original. `eurlex_get_relations` surfaces it via the incoming `cdm:act_consolidated_consolidates_resource_legal` edge (the forward `…has_consolidated_version…` predicate carries zero triples); fetching the consolidated text requires a follow-up `eurlex_get_document` call.
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
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ?work cdm:work_has_resource-type ?type .
  OPTIONAL { ?work cdm:work_date_document ?date . }
  FILTER(?celexNumber = "32016R0679")
} LIMIT 5
```

Search by type + date:
```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?work ?celexNumber ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex ?celexNumber .
  ?work cdm:work_has_resource-type ?type .
  ?work cdm:work_date_document ?date .
  FILTER(?date >= "2023-01-01"^^xsd:date)
  FILTER(?type = <http://publications.europa.eu/resource/authority/resource-type/REG>)
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
| `6` | CJEU case law | `CJ` (judgment), `CC` (AG opinion) | `62024CJ0629` |

Format: `{sector}{year}{type}{number}` — e.g., `3` (sector) + `2016` (year) + `R` (regulation) + `0679` (serial) = `32016R0679` (GDPR).

### EUR-Lex Content API

- **HTML**: `https://eur-lex.europa.eu/legal-content/{LANG}/TXT/HTML/?uri=CELEX:{celex}` → HTTP 200, `Content-Type: text/html`
- **XML**: `https://eur-lex.europa.eu/legal-content/{LANG}/TXT/XML/?uri=CELEX:{celex}` → HTTP 200, XML/Formex
- **ELI**: `https://eur-lex.europa.eu/eli/{type}/{year}/{number}/oj` → HTML (content negotiation to JSON-LD does NOT work on public paths)
- Language codes: `EN`, `FR`, `DE`, `ES`, `IT`, `PL`, `PT`, `NL`, `CS`, `DA`, `EL`, `ET`, `FI`, `HU`, `LT`, `LV`, `MT`, `RO`, `SK`, `SL`, `SV`, `BG`, `HR`, `GA`
