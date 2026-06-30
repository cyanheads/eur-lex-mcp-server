# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
