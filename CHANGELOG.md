# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-07-03

eurlex_get_cases case_type filtering now tests CDM resource-type instead of a CELEX substring, case titles are parsed into structured parties/subject_matter/case_reference fields, and the parser handles CELLAR's plural joined-case reference form

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-07-03

sparql_error responses now carry their declared recovery hint, eurlex_search_documents/eurlex_get_cases/eurlex_browse_subjects disclose capped-list truncation, and reader-/config-specific phrasing is trimmed from two tool descriptions

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-07-03

eurlex_search_documents gains include_consolidated/is_consolidated to surface consolidated texts, and both search tools reject or ignore whitespace-only keywords instead of running an unbounded corpus scan

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-07-03

eurlex_get_document accepts CELLAR work URIs, surfaces every co-legislating author institution instead of just the first, and flags base acts with a newer consolidated version via is_superseded/current_consolidated_celex, with an opt-in resolve=current_consolidated to serve it directly

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-07-03

eurlex_get_relations gains repeals/repealed_by/implicitly_repeals/implicitly_repealed_by relation types, and consolidated_version now filters out CELEX-less and cross-act rows so the list holds only genuine consolidations of the requested act

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-07-01

eurlex_get_document gains outline mode and structural section selectors (reach Article 17 by number, not character offset), and assembles multi-part Formex 4 so the xml format returns the full act for multi-part OJ acts such as the GDPR

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-06-30

eurlex_search_documents and eurlex_get_cases now match keywords via the CELLAR full-text index instead of a corpus-wide title scan (broad queries no longer risk the query timeout), and collapse distinct works that share one CELEX so a page of N returns N distinct results

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-06-30

Four result-interpretation bug fixes: eurlex_get_relations amended_by/consolidated_version resolve (were zero-triple CDM predicates), eurlex_get_document in_force parses xsd:boolean 1/0, eurlex_lookup_celex returns found:false instead of throwing, eurlex_query_sparql reports SELECT variables on empty result sets

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-06-30 · 🛡️ Security

eurlex_get_document adds an opt-in markdown format — server-side HTML→Markdown of the act body with GFM data tables — and bumps @cyanheads/mcp-ts-core to ^0.10.10, refreshing the lockfile to clear transitive advisories in hono, js-yaml, and esbuild

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-06-30

eurlex_get_document re-sources act text from the EU Publications Office CELLAR resolver and refuses AWS WAF bot-challenge stubs (previously surfaced as content); adds content_mode/offset/limit body pagination with content_* navigation fields and removes the 8,000-char text cut

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-30

eurlex_search_documents and eurlex_get_cases return one row per work, so multi-resource-type works (corrigenda) no longer duplicate or miscount LIMIT/total; constrained optional filters now accept empty string from form-based clients

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-30

eurlex_get_document accepts eli_uri and eurlex_get_relations accepts work_uri as functional identifier alternatives (exactly one of the pair required); eurlex_browse_subjects restricts results to EuroVoc concepts so every concept_uri is usable as an eurovoc_concept filter

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-30

eurlex_lookup_celex now resolves ELI URIs via an exact cdm:resource_legal_eli match, with bare work-level ELIs retrying once with /oj; the never-functional oj identifier_type is removed

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-30

eurlex_search_documents author_institution now constrains results via a required skos:prefLabel/bif:contains filter, and eurlex_get_document plus the document resource return English titles through the expression-level CELLAR traversal

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-30

eurlex_query_sparql enforces its read-only contract (non-SELECT queries rejected locally) and honors the previously-ignored timeout_hint parameter

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

Framework upgrade to mcp-ts-core ^0.10.9 (ctx.content media collector, sharper Canvas SQL-gate errors, fresh-scaffold devcheck guards), new dependency-specifier devcheck step, plugin-manifest lint, re-synced skills + scripts

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-11

Framework upgrade to mcp-ts-core ^0.10.6, server identity pair, SPARQL errors reclassified to ValidationError, bundle cleaner, Dockerfile hardening

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Keyword title search, case number resolution, filter echo, and human-readable type labels across CELLAR tools

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint — server.json remotes + README hosted instance docs

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 7 tools, 2 resources, 1 prompt over CELLAR SPARQL + EUR-Lex content API; SPARQL-injection hardening across all user-controlled inputs
