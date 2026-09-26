<div align="center">
  <h1>@cyanheads/eur-lex-mcp-server</h1>
  <p><b>Search EU legislation, CJEU case law, and treaties; traverse the CELLAR relationship graph; resolve EuroVoc concepts via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.16.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eur-lex-mcp-server) [![MCP Server](https://img.shields.io/badge/MCP%20Server-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eur-lex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eur-lex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eur-lex-mcp-server/releases/latest/download/eur-lex-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eur-lex-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXVyLWxleC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eur-lex-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Feur-lex-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eur-lex.caseyjhand.com/mcp](https://eur-lex.caseyjhand.com/mcp)

</div>

---

## Overview

EU legislation, CJEU case law, and treaties over the EU Publications Office's CELLAR semantic repository and the EUR-Lex content API. Search documents and case law, fetch full text, resolve citations, traverse the amendment and citation graph, and browse the EuroVoc thesaurus from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `eurlex_search_documents` | Search EU legislation, treaties, and preparatory acts by type, date, EuroVoc subject, author institution, and in-force status |
| `eurlex_get_document` | Fetch metadata and full text (HTML, Markdown, or Formex4 XML) for an act by CELEX, ELI, or work URI |
| `eurlex_lookup_celex` | Resolve a CELEX number, ELI URI, or ECLI to its canonical CELLAR work |
| `eurlex_get_cases` | Search CJEU and General Court case law by case number, court, case type, and date range |
| `eurlex_get_relations` | Traverse the CELLAR relationship graph — amendments, repeals, consolidations, legal basis, citations, transpositions |
| `eurlex_browse_subjects` | Search the EuroVoc thesaurus to resolve terms to concept URIs |
| `eurlex_query_sparql` | Run a raw, read-only SPARQL SELECT against the CELLAR endpoint |

### Resources

| Resource | Description |
|:---|:---|
| `eurlex://document/{celexNumber}` | Metadata snapshot for a CELLAR work |
| `eurlex://document/{celexNumber}/relations` | One-hop relationship summary for a CELLAR work |

All resource data is also reachable via tools.

### Prompts

| Prompt | Description |
|:---|:---|
| `eurlex_comparative_analysis` | Frame a comparative EU/US legal analysis for a policy domain |

---

## Capability reference

### `eurlex_search_documents` <sub>tool</sub>

- At least one filter: `keyword` (English titles, plus CELEX numbers when it holds a digit: a whole CELEX with its `(01)`–`(20)` siblings and `R(01)`–`R(20)` corrigenda by exact lookup, a partial one by substring; no body search), `document_type` (`REG`, `DIR`, `DEC`, `TREATY`, `JUDG`, `OPIN_AG`, `PROP`, `REC`, each its full CELLAR authority family), `date_from`/`date_to`, `eurovoc_concept` (from `eurlex_browse_subjects`), `author_institution`, or `in_force` (`true`/`false`; `false` covers repealed, expired, and not-yet-in-force acts)
- Pages of up to 100 via `offset`/`limit`, newest first with the CELEX breaking date ties, so a page is the same on every call; each row flags `is_consolidated` and `is_corrigendum`, and corrigenda join only under `include_corrigenda`, consolidated texts of a `document_type` only under `include_consolidated`
- No match returns an empty page with a `notice` naming the filters and how to broaden them; typed errors: `no_filters`, `invalid_date_range`, `invalid_author_institution` and `invalid_keyword` (no letters or digits)

---

### `eurlex_get_document` <sub>tool</sub>

- Exactly one of `celex_number`, `eli_uri`, or `work_uri`, served as the work the CELEX resolves to (see `eurlex_lookup_celex`); a `work_uri` carrying several CELEX numbers (a national implementing measure) serves its lowest, with a `notice` giving the count; body as `html` (default), `markdown`, or `xml` (Formex4) in any of the 24 EUR-Lex languages, falling back to English; metadata names `author_institution(s)` and, for case law, `advocates_general`
- `content_mode` `"paged"` (default), `"full"`, or `"metadata_only"`, every body capped at 100,000 characters per call with `content_chars_total`/`has_more` to page on; `outline: true` lists chapter/section/article/annex headings with offsets, the preamble's recitals as one `Recitals 1–173` entry (`include_recitals: true` lists each), and `select` (e.g. `{ articles: "1,5,17" }`) returns just those sections, each source character once, under the same cap with no `offset`/`limit`, with `selected_sections` giving each one's own `offset`/`chars` for a `paged` read. Headings are read in the language served and labelled in English in every format (`Article 4`, `CHAPTER IV`); a selector number may carry an English kind word or the served language's (`Artikel 4`, `4. cikk`). Headings of text an amending act inserts into another act are not the act's own and are skipped
- `is_superseded` says whether a newer consolidated version than the text served is in effect (`false` on the newest one, and on a consolidated version dated after it that does not apply yet), with `current_consolidated_celex`/`consolidated_as_of` naming that version; `resolve: "current_consolidated"` serves it, for a base act or any of its consolidated texts; when no consolidated version is in effect yet, a `notice` says a future-dated consolidated text does not apply yet, or that `resolve` served the base act
- `in_force: false` comes with its reason where CELLAR records one: `repealed_by` (CELEX of the explicitly repealing acts), `end_of_validity` (omitted when open-ended; a future date on an act not yet in force), or `entry_into_force` (the earliest date, when still ahead)
- A consolidated text keeps its own title, date, and type and reports its base act as `base_act_celex`, with that act's authors, `in_force` and its reason, legal basis, and EuroVoc subjects; typed errors: `invalid_identifier_args`, `not_found`, `content_challenge` (a WAF bot-challenge in place of text)

---

### `eurlex_lookup_celex` <sub>tool</sub>

- A CELEX number, ELI URI, or ECLI; `identifier_type` auto-detects the format or sets it, and `ambiguous_identifier` fires when auto-detection can't classify the input
- Returns work URI, confirmed CELEX number, resource type, date, and the case's ECLI (recorded on any work holding the CELEX); `found: false` for a well-formed identifier that matches no work
- A CELEX held by several works resolves to the one `owl:sameAs` its `http://publications.europa.eu/resource/celex/{CELEX}` IRI, which EUR-Lex serves the text from, else the lowest work URI, and every CELEX-taking tool and resource resolves the same way; an ECLI shared by several records resolves to the primary record with the lowest CELEX

---

### `eurlex_get_cases` <sub>tool</sub>

- Filters: `case_number` (one case per value — `C-131/12`, `T-22/20`, `F-12/05`, or a pre-1989 `26/62` — reaching every judgment, order, and AG opinion filed under it), `court` (`CJEU` or `GC`, by CELEX court letter), `case_type` (`judgment`, `order`, `ag_opinion`), `keyword` (English titles, plus CELEX numbers: a whole CELEX with its `(01)`–`(20)` siblings and `_INF`/`_RES`/`_SUM`/`_EXT` records, a partial one by substring), and `date_from`/`date_to`; primary records only unless `include_derivative` adds notices, abstracts, summaries, and corrigenda
- Pages of up to 100 via `offset`/`limit`, newest first with the CELEX breaking date ties, so a page is the same on every call; each case carries its ECLI where CELLAR records one, plus `display_title`, `parties`, `subject_matter`, and `case_reference` parsed from the CELLAR title
- No match returns an empty page with a `notice` naming the filters and how to broaden them; typed errors: `invalid_case_number`, `invalid_date_range`, `invalid_keyword` (no letters or digits)

---

### `eurlex_get_relations` <sub>tool</sub>

- Exactly one of `celex_number` or `work_uri`; `relation_types` narrows to any of `cites`, `amends`, `amended_by`, `repeals`, `repealed_by`, `implicitly_repeals`, `implicitly_repealed_by`, `legal_basis`, `consolidated_version`, `national_transposition` (omit for all)
- One hop, paged per relation type and direction via `offset`/`limit` (max 100, default 100), newest first with the work URI breaking ties, so a page is the same on every call; undated works come last
- Each relation carries `relation_type`, `direction` (`outgoing`/`incoming`), `related_work_uri`, `related_celex_number` when known, and on `national_transposition` rows `related_member_state` (ISO 3166-1 alpha-3, `GBR` for the United Kingdom); `empty_relation_types` separates "no edges of this type" from "paged out", a work with no edges of the requested types returns an empty page with a `notice`, and typed errors are `invalid_identifier_args` and `not_found`

---

### `eurlex_browse_subjects` <sub>tool</sub>

- Matches preferred and alternative EuroVoc labels, so a common synonym resolves to its concept, in any EU official `language` (default English); `offset`/`limit` pagination (max 50)
- Returns concept URI, preferred label, code, broader (parent) label, and the alternative label that matched when one did; an empty page with a `notice` when nothing matches

---

### `eurlex_query_sparql` <sub>tool</sub>

- Read-only SELECT only — update forms and ASK/CONSTRUCT/DESCRIBE are rejected before execution; `cdm:`, `skos:`, and `xsd:` prefixes are auto-injected
- Results capped at 100 rows; optional `timeout_hint` (1000–55000 ms) under the endpoint's 60-second hard limit
- Typed errors: `not_read_only`, `sparql_error`, `sparql_timeout`

---

### `eurlex://document/{celexNumber}` <sub>resource</sub>

- Metadata snapshot as `application/json` — resource type, author institution(s), Advocates General, date, title, in-force flag, legal basis, EuroVoc subjects; a consolidated text adds `base_act_celex` and reads authors, in-force flag, legal basis, and subjects from that act
- `celexNumber` comes from `eurlex_search_documents`, `eurlex_get_cases`, or `eurlex_lookup_celex`

---

### `eurlex://document/{celexNumber}/relations` <sub>resource</sub>

- One-hop relationship summary — amendment chain, consolidations, national transposition (each measure's `related_member_state` included), legal basis, citations — capped at 25 per relation type and direction, keeping the newest
- `truncated` plus a `continuation` pointer to `eurlex_get_relations` when more relations exist

---

### `eurlex_comparative_analysis` <sub>prompt</sub>

- Arguments: `domain` required; `focus` optional, folded into its matching analysis axis or added as its own section
- Returns a research plan chaining `eurlex_browse_subjects` → `eurlex_search_documents` → `eurlex_get_document` → `eurlex_get_relations` for the EU side and `courtlistener_search_opinions` for the US side, plus a six-axis analysis framework

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EUR-Lex-specific:

- No API key required — CELLAR SPARQL and the EUR-Lex REST content endpoints are both publicly accessible
- SPARQL is POSTed with CDM prefix declarations built in; server-side LIMIT enforcement (max 100) guards against Virtuoso timeouts
- Act text is fetched via CELLAR content negotiation (`/resource/celex/{CELEX}`); HTML passes through as served; Formex4 XML passes through for a single-part act and is assembled into one document from the parts of a multi-part act (HTTP 300 streams) or a zipped Formex package; Markdown is converted server-side
- Virtuoso errors (HTTP 200 with a `Virtuoso 37000 Error` body) are classified and re-raised as `ServiceUnavailable` or `ValidationError`
- Automatic English fallback when a requested translation is unavailable, with requested/effective language reported

Agent-friendly output:

- EuroVoc prerequisite guidance in server-level instructions — agents are directed to `eurlex_browse_subjects` before concept-filtered searches
- `eurlex_lookup_celex` confirms CELEX/ELI/ECLI existence upfront, preventing downstream errors in document or relation fetches
- `content_status`, `content_unavailability_reason`, and requested/effective language fields distinguish skipped, available, absent, upstream-failed, and incomplete content without string parsing
- Typed `reason` codes on every tool's error contract let agents branch on outcomes programmatically

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://eur-lex.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "eur-lex-mcp-server": {
      "type": "streamable-http",
      "url": "https://eur-lex.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is required.

```json
{
  "mcpServers": {
    "eur-lex-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/eur-lex-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "eur-lex-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/eur-lex-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "eur-lex-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/eur-lex-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key needed — EUR-Lex and CELLAR are publicly accessible.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/eur-lex-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd eur-lex-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# All server-specific vars have sensible defaults — no required vars
```

---

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CELLAR_SPARQL_ENDPOINT` | CELLAR SPARQL endpoint URL override (e.g., for a local Virtuoso mirror). | `http://publications.europa.eu/webapi/rdf/sparql` |
| `EURLEX_CONTENT_BASE_URL` | EU Publications Office CELLAR content resolver base URL override. | `http://publications.europa.eu` |
| `SPARQL_QUERY_TIMEOUT_MS` | Client-side timeout for SPARQL requests in milliseconds. | `55000` |
| `MAX_SPARQL_RESULTS` | Enforced ceiling on LIMIT in all generated SPARQL queries. | `100` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | Session handling: `stateful`, `stateless`, or `auto` (`auto` resolves to stateful). | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t eur-lex-mcp-server .
docker run --rm -p 3010:3010 eur-lex-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/eur-lex-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, and prompts; initializes services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/services/cellar-sparql` | CELLAR SPARQL service — POST client, binding mapper, LIMIT enforcement, CDM PREFIX declarations. |
| `src/services/eurlex-content` | CELLAR content service — content-negotiation GET client for `/resource/celex/{CELEX}` (`Accept` / `Accept-Language`) with English language fallback, and an in-process cache of served bodies so paging an act fetches it once. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools across document search, retrieval, resolution, case law, relations, EuroVoc, and raw SPARQL. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Metadata and relations resources. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Comparative analysis prompt. |
| `tests/` | Unit and integration tests mirroring `src/`. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
