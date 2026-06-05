---
name: eur-lex-mcp-server
description: "EU law via EUR-Lex/CELLAR — legislation, CJEU case law, and treaties, addressable by CELEX/ELI over a keyless SPARQL + REST endpoint."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/eur-lex-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: deep single-source (semantic / SPARQL)
complexity: high
api-deps: EUR-Lex CELLAR — public SPARQL endpoint (publications.europa.eu/webapi/rdf/sparql) + RESTful content API; keyless
api-cost: free (keyless public SPARQL + REST; Virtuoso triple store, 60s query timeout — enforce LIMIT/OFFSET)
hostable: true
composes-with: courtlistener-mcp-server, eurostat-mcp-server, wikidata-mcp-server
---

# eur-lex-mcp-server

EU law via [EUR-Lex](https://eur-lex.europa.eu/) and its backing semantic repository, **CELLAR** (operated by the Publications Office of the EU) — 2.7M+ works covering treaties, regulations, directives, decisions, CJEU/General Court judgments and Advocate General opinions, and preparatory acts, exposed as RDF over a keyless public SPARQL endpoint plus a RESTful content API.

The fleet's legal coverage is **entirely US** — `courtlistener` (case law), `congressgov` (federal legislation), `openstates` (state legislation). EUR-Lex is the other major legal system: the canonical, authoritative database of European Union law. This closes the international-law gap with the single largest, best-structured non-US legal corpus available keyless.

**Audience:** EU and comparative-law practitioners, regulatory/policy analysts, academics, journalists, and agents answering "what does EU law say about X" or tracing how an EU act has been amended, consolidated, or transposed.

## Why this is a high-complexity build

Unlike a REST-mirror server, EUR-Lex's value lives in **semantic relationships** (RDF graph: amendments, consolidations, legal basis, citations, national transposition). The lift is SPARQL + the Common Data Model (CDM) ontology, not endpoint plumbing. The fleet already has SPARQL prior art — `wikidata_sparql_query` — so the query plumbing, result shaping, and timeout handling can be lifted from there.

## User Goals

- Find EU legislation or case law by topic, type, date, institution, or subject (EuroVoc)
- Read the text of a specific act or judgment in a chosen language
- Resolve a citation (CELEX, ELI, OJ reference) to the canonical work
- Trace an act's lifecycle — what amended it, the current consolidated version, its legal basis
- Pull CJEU / General Court case law (judgments, orders, AG opinions) on a question
- Cross-jurisdiction comparison — chain with `courtlistener` for the US counterpart

## Data Model (CELLAR)

CELLAR stores every EUR-Lex work as RDF triples addressable by stable identifiers. Querying is code- and URI-driven, like FAOSTAT's domains or Census's variables.

| Concept | What it is |
|:--------|:-----------|
| **CELEX number** | The canonical document ID — sector digit + year + type + number (e.g. `32016R0679` = GDPR). Primary lookup key. |
| **ELI** | European Legislation Identifier — persistent URI scheme for legal acts. |
| **EuroVoc** | Multilingual thesaurus for subject filtering — resolve human terms to concept IDs. |
| **CDM** | The OWL/RDFS ontology defining works, expressions, manifestations, and their relationships. |
| **Resource types** | Legislation (`REG`, `DIR`, `DEC`) and case law (`JUDG`, `ORDER`, `OPIN_AG`, `OPIN_JUR`, `RULING`). |

Access: **SPARQL** (`publications.europa.eu/webapi/rdf/sparql`, content-negotiable JSON/XML/CSV) for metadata and relationship queries; **REST** for fetching notices and document content (HTML, XML, Formex, PDF) per language.

## Tool Surface (sketch)

Organized around the legal-research workflow, not the RDF mechanics. SPARQL is a service-layer detail; agents see legal verbs.

```
eurlex_search_documents   — the 80% entry point. Full-text + metadata search across
                            legislation, case law, treaties, and preparatory acts.
                            Filters: document type, date range, EuroVoc subject, author
                            institution, in-force status. Backed by SPARQL over CELLAR.

eurlex_get_document       — fetch a single work by CELEX number or ELI URI: notice
                            (metadata) + content in a chosen language (HTML/XML/Formex).
                            Language param defaults to English (like wikipedia).

eurlex_lookup_celex       — resolve a citation/identifier (CELEX, ELI, OJ reference) to
                            the canonical work. The EU analog of
                            courtlistener_lookup_citation.

eurlex_get_cases          — CJEU and General Court case law specifically — judgments,
                            orders, AG opinions — by case number, party, or subject.
                            Case law is a distinct sub-audience worth a focused tool
                            rather than burying it behind a type filter.

eurlex_get_relations      — given a work, traverse CELLAR relationships: amendments,
                            consolidated versions, legal basis, cited-by, national
                            transposition. CELLAR's superpower — the thing a scraper
                            can't do. "What's the current consolidated text of the GDPR
                            and what amended it?"

eurlex_browse_subjects    — list or search EuroVoc concept IDs by human-readable term
                            or keyword. Required before filtering eurlex_search_documents
                            by subject — agents cannot guess numeric EuroVoc concept IDs.
                            Analog of libofcongress_search_subjects.

eurlex_query_sparql       — raw SPARQL escape hatch over the CELLAR endpoint for queries
                            the curated tools don't cover. Prior art: wikidata_sparql_query.
```

## Design Notes

- **Lift the SPARQL plumbing from `wikidata`.** Virtuoso triple store, 60s timeout — every query needs `LIMIT`/`OFFSET` and tight graph patterns to avoid full scans. The wikidata server already solved result shaping and timeout handling.
- **CELEX is the spine.** Most lookups key on the CELEX number; `eurlex_lookup_celex` (CELEX/ELI/OJ → canonical work) is mandatory, not optional — the corpus is hard to navigate without it. `eurlex_browse_subjects` is the prerequisite for EuroVoc-filtered searches — concept IDs are opaque numerics agents can't guess.
- **Multilingual (24 official languages).** Default to English, expose a `language` param. Content manifestations vary by language; some older acts aren't in all 24.
- **Relationship traversal is the moat.** Lean into amendments / consolidation / legal-basis / transposition — that graph is why CELLAR beats scraping EUR-Lex HTML, and why this earns "high complexity" rather than "another REST wrapper."
- **Skip the registered-user paths.** The SOAP "expert search" web service and the bulk RDF dumps both need an EU login — the public SPARQL + REST are keyless and sufficient for a hosted, multi-tenant server. Stay on those.
- **Composes with** `courtlistener` (US ↔ EU case law for comparative work), `eurostat` (EU statistics alongside EU law), `wikidata` (entity resolution — institutions, treaties, member states → QIDs; shared SPARQL patterns).
- **Moonshot:** a cross-jurisdiction workflow — "compare how the EU and the US regulate X" — chaining `eur-lex` ↔ `courtlistener` / the federal-regulations server, surfacing the EU act, the US analog, and the divergences in one call.
- README one-liner: "EU law from EUR-Lex — legislation, CJEU case law, and treaties for the European Union, by CELEX or ELI."
