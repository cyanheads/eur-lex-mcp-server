<div align="center">
  <h1>@cyanheads/eur-lex-mcp-server</h1>
  <p><b>Search EU legislation, CJEU case law, and treaties; traverse the CELLAR relationship graph; resolve EuroVoc concepts via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eur-lex-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eur-lex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eur-lex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eur-lex-mcp-server/releases/latest/download/eur-lex-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eur-lex-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXVyLWxleC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eur-lex-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Feur-lex-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eur-lex.caseyjhand.com/mcp](https://eur-lex.caseyjhand.com/mcp)

</div>

---

## Tools

Seven tools covering EU legal research — document discovery, content retrieval, citation resolution, case law, relationship graph traversal, EuroVoc thesaurus lookup, and raw SPARQL access:

| Tool | Description |
|:-----|:------------|
| `eurlex_search_documents` | Search EU legislation, treaties, and preparatory acts across the CELLAR corpus. Filters by document type, date range, EuroVoc concept, author institution, and in-force status. |
| `eurlex_get_document` | Fetch structured metadata and full text (HTML, Markdown, or Formex4 XML) for a work by CELEX number or ELI URI. |
| `eurlex_lookup_celex` | Resolve an EU legal citation — a CELEX number or an ELI URI — to the canonical CELLAR work. |
| `eurlex_get_cases` | Search CJEU and General Court case law — judgments, orders, and Advocate General opinions — by case number, party name, subject, or date range. |
| `eurlex_get_relations` | Traverse the CELLAR relationship graph: amendment chain, consolidated versions, legal basis, citation network, and national transposition measures. |
| `eurlex_browse_subjects` | Search the EuroVoc multilingual thesaurus to resolve human-readable terms to EuroVoc concept IDs — required before using the `eurovoc_concept` filter in `eurlex_search_documents`. |
| `eurlex_query_sparql` | Execute a raw SPARQL SELECT query against the CELLAR Virtuoso endpoint. Results capped at 100; use only when curated tools don't cover the needed CDM ontology traversal. |

### `eurlex_search_documents`

Search EU legislation, treaties, preparatory acts, and more across the 2.7M+ work CELLAR corpus.

- Keyword search across work titles and CELEX string patterns
- Filter by document type (`REG`, `DIR`, `DEC`, `TREATY`, and more)
- Date range filtering (`date_from`, `date_to`)
- EuroVoc concept filtering — use `eurlex_browse_subjects` first to resolve concept IDs
- Filter to in-force acts only
- Pagination via `offset` and configurable `limit` (max 100)
- Returns CELEX numbers, work URIs, document types, and dates for chaining into `eurlex_get_document`

---

### `eurlex_get_document`

Fetch the notice and full text of an EU legal act.

- Accepts CELEX numbers (e.g., `32016R0679`) or ELI URIs
- Returns structured metadata: title, date, document type, author institution, legal basis, EuroVoc subjects, in-force flag
- Full text in HTML (default), Markdown, or Formex4 XML — `format: "markdown"` converts the act body to clean Markdown server-side (recitals and numbered points as readable text, genuine data tables as GFM)
- Content shaping for large acts: `content_mode` `"paged"` (default) returns a bounded character window (`offset` + `limit`) with `content_chars_total` and `has_more` so you can page to the end; `"full"` returns the whole body in one call; `"metadata_only"` skips the body
- Supports all 24 official EU languages; defaults to English with automatic fallback when a translation is unavailable
- Older acts and some CJEU judgments may lack English translations

---

### `eurlex_lookup_celex`

Resolve EU legal identifiers to canonical CELLAR works.

- Accepts CELEX numbers and ELI URIs
- Auto-detects format with `identifier_type: "auto"` (default); set explicitly when auto-detection fails
- Returns work URI, confirmed CELEX number, document type, and date — the prerequisite step before `eurlex_get_document` or `eurlex_get_relations`

---

### `eurlex_get_cases`

Search CJEU and General Court case law.

- Case-specific search: case number, keyword, court (`CJEU` or `GC`), and case type (`judgment`, `order`, `ag_opinion`)
- Date range filtering
- Returns case identifier, court, date, document type, and parties
- Distinct from `eurlex_search_documents` — case law (CELEX sector 6) has its own search parameters and practitioner workflows

---

### `eurlex_get_relations`

Traverse the CELLAR relationship graph for a given work.

- Amendment chain (what amends it, what it amends)
- Consolidated versions (the current in-force text)
- Legal basis
- Citation network (`cdm:work_cites_work` in both directions)
- National transposition measures
- Filter to specific relation types or retrieve all at once
- Returns one-hop relations; multi-hop traversal requires multiple calls or `eurlex_query_sparql`

---

### `eurlex_browse_subjects`

Resolve human-readable terms to EuroVoc concept IDs.

- Full-text search across the multilingual EuroVoc thesaurus
- Returns concept URI, preferred label, concept code, and broader/narrower hierarchy hints
- Supports all EU official languages; defaults to English
- Required before using the `eurovoc_concept` filter in `eurlex_search_documents`

---

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `eurlex://document/{celexNumber}` | Metadata snapshot for a CELLAR work — type, date, title, author institution, in-force flag |
| Resource | `eurlex://document/{celexNumber}/relations` | Relationship summary for a work: amendment chain, consolidations, legal basis, cited-by count |
| Prompt | `eurlex_comparative_analysis` | Frames a comparative legal analysis across EU and US law for a given policy domain |

All resource data is also reachable via tools. Resources provide stable-URI injectable context for agents that support MCP resources.

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

EUR-Lex-specific:

- No API key required — both CELLAR SPARQL and EUR-Lex REST content endpoints are publicly accessible
- `CellarSparqlService` POSTs `application/x-www-form-urlencoded` SPARQL with CDM prefix declarations built in; server-side LIMIT enforcement (max 100) prevents Virtuoso timeout abuse
- `EurLexContentService` fetches act text from the CELLAR content-negotiation resolver (`/resource/celex/{CELEX}` with `Accept` / `Accept-Language` headers); HTML and Formex4 XML pass through, Markdown is converted server-side from the HTML body
- Virtuoso error classification: HTTP 200 with `Virtuoso 37000 Error` body is parsed and re-raised as `ServiceUnavailable` (transient/timeout) or `InvalidParams` (syntax error)
- Language fallback on document fetch: if the requested language is unavailable, retries with English; returns metadata-only with a note when English also fails
- Typed error contracts on every tool — structured `reason` codes let agents branch on outcomes without parsing text

Agent-friendly output:

- EuroVoc prerequisite guidance in server-level instructions — agents are directed to `eurlex_browse_subjects` before attempting concept-filtered searches
- `eurlex_lookup_celex` surfaces CELEX confirmation and work existence upfront, preventing downstream errors in document or relation fetches
- Typed `unavailable` reasons and `language_unavailable` signals let agents retry or explain to users with structured data, not string parsing
- Relationship graph output carries relation type labels alongside CELLAR URIs and resolved CELEX numbers for human-readable downstream use

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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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
| `src/services/eurlex-content` | EUR-Lex content API service — GET client for `legal-content/{LANG}/TXT/` URL pattern with language fallback. |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
