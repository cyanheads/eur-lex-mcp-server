<div align="center">
  <h1>@cyanheads/eur-lex-mcp-server</h1>
  <p><b>Search EU legislation, CJEU case law, and treaties; traverse the CELLAR relationship graph; resolve EuroVoc concepts via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.13.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eur-lex-mcp-server) [![MCP Server](https://img.shields.io/badge/MCP%20Server-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eur-lex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eur-lex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

- Keyword matches English titles via the full-text index, or CELEX substrings — no full-text body search; at least one filter is required
- `document_type` (`REG`, `DIR`, `DEC`, `TREATY`, `JUDG`, `OPIN_AG`, `PROP`, `REC`) expands to its full CELLAR authority family; `include_consolidated` folds in consolidated texts of that category
- Date range (`date_from`/`date_to`), EuroVoc concept URI (from `eurlex_browse_subjects`), and author institution filters; `in_force` restricts to acts in force (`true`) or no longer in force (`false`)
- Corrigenda are excluded by default so primary acts fill the page; `include_corrigenda` re-admits them
- Pagination via `offset` and `limit` (max 100); each result flags `is_consolidated` and `is_corrigendum`
- Typed errors: `no_filters`, `invalid_date_range`, `no_results`

---

### `eurlex_get_document` <sub>tool</sub>

- Accepts exactly one of `celex_number`, `eli_uri`, or `work_uri`
- Body as `html` (default), `markdown` (server-side converted), or `xml` (Formex4); all 24 EUR-Lex language codes, case-insensitive, defaulting to and falling back to English
- `content_mode` `"paged"` (default, offset/limit window), `"full"` (first window from zero), or `"metadata_only"`; every body returned in one call caps at 100,000 characters, with `content_chars_total`/`has_more` to page the rest
- `outline: true` returns chapter/section/article/annex/recital headings with offsets, in Formex XML as well as HTML and Markdown; `select` (e.g. `{ articles: "1,5,17" }`) returns just those sections, under the same cap. Each source character appears once: an article selected alongside the chapter holding it rides inside the chapter's text and adds nothing to the cap. A selection is a set of slices rather than a contiguous window, so `has_more` stays false and `selected_sections` carries each matched section's own `offset`/`chars`, nested ones included — read one on its own with a `paged` call, including when the cap cut its text
- `resolve: "current_consolidated"` serves the newest consolidated version instead of the requested base act; `is_superseded`/`current_consolidated_celex`/`consolidated_as_of` flag a stale base act either way
- Typed `content_challenge` error when EUR-Lex returns a WAF bot-challenge instead of text

---

### `eurlex_lookup_celex` <sub>tool</sub>

- Accepts a CELEX number, ELI URI, or ECLI; `identifier_type` auto-detects the format or can be set explicitly
- Returns work URI, confirmed CELEX number, resource type, date, and the ECLI of a case — `found: false` for a well-formed identifier that matches no work
- An ECLI shared by several records (a judgment and its abstract or extract, a joined AG opinion) resolves to the primary record with the lowest CELEX
- `ambiguous_identifier` error when auto-detection can't classify the input

---

### `eurlex_get_cases` <sub>tool</sub>

- Filters: `case_number`, `court` (`CJEU` or `GC`), `case_type` (`judgment`, `order`, `ag_opinion`), keyword, and date range
- `case_number` takes `C-131/12`, `T-22/20`, or `F-12/05`, the `Case C-97/23 P.` reference form with any procedural suffix, and pre-1989 numbers like `26/62`; it reaches every judgment, order, and AG opinion filed under the number. One case per value: a joined list like `C-131/12 and C-132/12` is rejected
- `court` selects by the CELEX court letter, so every primary record a court filed is reachable, whatever its document letter
- Primary records only by default — judicial information notices, abstracts, summaries, and corrigenda excluded; `include_derivative` includes them
- Each case carries its ECLI (`ECLI:EU:C:2014:317`) where CELLAR records one; party names, subject matter, and case reference are parsed from the raw CELLAR title into `display_title`, `parties`, `subject_matter`, `case_reference`
- Pagination via `offset` and `limit` (max 100)
- Typed errors: `invalid_case_number`, `invalid_date_range`, `no_results`

---

### `eurlex_get_relations` <sub>tool</sub>

- Accepts exactly one of `celex_number` or `work_uri`
- `relation_types` filters to a subset of `cites`, `amends`, `amended_by`, `repeals`, `repealed_by`, `implicitly_repeals`, `implicitly_repealed_by`, `legal_basis`, `consolidated_version`, `national_transposition`; omit for all
- One-hop only, paginated per relation type and direction via `offset`/`limit` (max 100, default 100)
- Each relation carries `relation_type`, `direction` (`outgoing`/`incoming`), `related_work_uri`, and `related_celex_number` when known; `national_transposition` rows add `related_member_state`, the ISO 3166-1 alpha-3 code of the member state behind the measure (`GBR` for the United Kingdom)
- `empty_relation_types` distinguishes "no edges of this type" from "edges paged out of this window"; `no_relations` fires only when the first page is empty

---

### `eurlex_browse_subjects` <sub>tool</sub>

- Matches both preferred and alternative (non-preferred) EuroVoc labels, so a common synonym resolves to the concept it stands for
- Returns concept URI, preferred label, code, broader (parent) label, and the alternative label that matched when one did
- Supports all EU official languages via `language`; defaults to English
- Pagination via `offset` and `limit` (max 50)

---

### `eurlex_query_sparql` <sub>tool</sub>

- Read-only SELECT only — update forms and ASK/CONSTRUCT/DESCRIBE are rejected before execution
- `cdm:`, `skos:`, and `xsd:` prefixes are auto-injected; results capped at 100 rows
- Optional `timeout_hint` (1000–55000 ms); the Virtuoso endpoint enforces a 60-second hard limit
- Typed errors: `not_read_only`, `sparql_error`, `sparql_timeout`

---

### `eurlex://document/{celexNumber}` <sub>resource</sub>

- Metadata snapshot as `application/json` — resource type, author institution(s), date, title, in-force flag, legal basis, EuroVoc subjects
- `celexNumber` comes from `eurlex_search_documents`, `eurlex_get_cases`, or `eurlex_lookup_celex`

---

### `eurlex://document/{celexNumber}/relations` <sub>resource</sub>

- One-hop relationship summary — amendment chain, consolidations, national transposition (each measure's `related_member_state` included), legal basis, citations — capped at 25 per relation type
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
- Act text is fetched via CELLAR content negotiation (`/resource/celex/{CELEX}`); HTML and Formex4 XML pass through, Markdown is converted server-side
- Virtuoso errors (HTTP 200 with a `Virtuoso 37000 Error` body) are classified and re-raised as `ServiceUnavailable` or `InvalidParams`
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
| `src/services/eurlex-content` | CELLAR content service — content-negotiation GET client for `/resource/celex/{CELEX}` (`Accept` / `Accept-Language`) with English language fallback. |
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
