<div align="center">
  <h1>@cyanheads/eur-lex-mcp-server</h1>
  <p><b>Search EU legislation, CJEU case law, and treaties; traverse the CELLAR relationship graph; resolve EuroVoc concepts via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.19.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eur-lex-mcp-server) [![MCP Server](https://img.shields.io/badge/MCP%20Server-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eur-lex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eur-lex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

EU legislation, CJEU case law, and treaties from EUR-Lex. Search documents and case law, fetch full text, resolve citations, trace how acts amend and cite each other, and browse the EuroVoc subject thesaurus.

### Tools

| Tool | Description |
|:-----|:------------|
| `eurlex_search_documents` | Search EU legislation, treaties, and preparatory acts by type, date, EuroVoc subject, author institution, and in-force status |
| `eurlex_get_document` | Fetch metadata (including ELI, Official Journal reference, and dates of effect) and full text (HTML, Markdown, or Formex4 XML) for an act or case by CELEX, ELI, or work URI, with a section outline of either |
| `eurlex_lookup_celex` | Resolve a CELEX number, ELI URI, ECLI, OJ citation (`Regulation (EU) 2016/679`), or Official Journal reference (`OJ L 119, 4.5.2016, p. 1`) to its canonical CELLAR work |
| `eurlex_get_cases` | Search CJEU and General Court case law by case number, court, case type, and date range |
| `eurlex_get_relations` | Traverse the CELLAR relationship graph — amendments, repeals, consolidations, legal basis and the works adopted under it, the proposal an act adopts, interpreting rulings (by article), citations, transpositions |
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

- At least one filter: `keyword` (English titles, plus CELEX numbers or fragments such as `2016R0679`; a keyword with letters and no digit, such as `R(01)`, scans every CELEX and can take tens of seconds; no body search), `document_type` (`REG`, `DIR`, `DEC`, `TREATY`, `JUDG`, `OPIN_AG`, `PROP`, `REC`), `date_from`/`date_to`, `eurovoc_concept` (from `eurlex_browse_subjects`), `author_institution`, or `in_force` (`true`/`false`; `false` covers repealed, expired, and not-yet-in-force acts)
- Pages of up to 100 via `offset`/`limit` (a larger `limit` is served at 100 and reported in `limit_clamp`), newest first; each row flags `is_consolidated` and `is_corrigendum`, and corrigenda and consolidated texts appear only under `include_corrigenda` and `include_consolidated`. Paging stops at row 10,000: the last page carries no `next_offset` and a `notice` giving the `date_from`/`date_to` window that continues past it
- No match returns an empty page with a `notice` on how to broaden the filters; typed errors: `no_filters`, `invalid_date_range`, `invalid_author_institution` and `invalid_keyword` (no letters or digits), `offset_past_window` (`offset` 10,000 or more)
- `author_institution` matches English authority labels and national-court names returned by `eurlex_get_document`, such as `European Parliament` or `Supremo Tribunal de Justiça`, with or without date bounds

---

### `eurlex_get_document` <sub>tool</sub>

- Exactly one of `celex_number`, `eli_uri`, or `work_uri` (pasted forms such as a `CELEX:` prefix or EUR-Lex URL are accepted); body as `html` (default), `markdown`, or `xml` (Formex4) in any of the 24 EUR-Lex languages, falling back to English. Case law also carries `ecli`, `formation`, `referring_court`, `subject_matter`, and `case_reference`; a consolidated text reports its base act as `base_act_celex`
- `content_mode` `"paged"` (default), `"full"`, or `"metadata_only"`, capped at 100,000 characters per call (a larger `limit` is reported in `limit_clamp`) with `content_chars_total`/`has_more` to page on; `outline: true` lists headings with offsets, and `select` (e.g. `{ articles: "1,5,17" }`) returns just those sections. For judgments and AG opinions the outline lists section headings, and `select: { operative_part: true }` returns the ruling alone
- `is_superseded` flags a newer consolidated version (`current_consolidated_celex`, `consolidated_as_of`), and `resolve: "current_consolidated"` serves it; `in_force: false` comes with `repealed_by`, `end_of_validity`, or `entry_into_force` where CELLAR records one. Typed errors: `invalid_identifier_args`, `not_found`, `content_challenge` (a WAF bot-challenge in place of text)
- Citation facts, each absent when CELLAR records none: `eli` (a consolidated text keeps its own point-in-time ELI); `oj_reference`, the Official Journal reference (`OJ L 119, 4.5.2016, p. 1–88`; no series letter before 1968, a class letter as in `OJ L 42I`, `OJ L, 2024/1689, 12.7.2024` for act-by-act publication), with pages from the English edition or, before 1973, the original-language editions, and the earliest issue for a reprinted act; `dates_of_effect`, every recorded date as `{ date, type? }` with `type` one of `entry_into_force`, `application`, `partial_application`, `provisional_application`, `takes_effect`, `takes_partial_effect`; and `transposition_deadlines` for a directive. `entry_into_force` keeps its meaning of an entry still ahead on a not-in-force act. A consolidated text reports its base act's `oj_reference`, `dates_of_effect`, and `transposition_deadlines`
- Available legacy HTML/Markdown bodies may carry `content_omissions: { tables }`: missing-table markers counted across the full source, including outside the returned window. Paging cannot recover these tables. `alternative_representations` lists PDF streams advertised for the served work and language when discovery succeeds; XML availability remains independent. Metadata-only calls do not inspect source omissions
- National implementing measures carry sparse `national_measure` citation fields: `journal`, `number`, `pages`, `publication_date`, and `notification_date`, including metadata-only calls. Numbers and pages retain their source spelling; publication, notification, and document dates are distinct. When the body is unavailable, use the gazette citation to retrieve it; no national-portal URL is inferred, and notification does not prove complete transposition

---

### `eurlex_lookup_celex` <sub>tool</sub>

- A CELEX number, ELI URI, ECLI, or OJ citation naming its act type and year (`Regulation (EU) 2016/679`, `Directive 95/46/EC`, optionally followed by its parenthesized OJ reference, `Directive 95/46/EC (OJ L 281, 23.11.1995, p. 31)`); pasted forms (a `CELEX:` prefix, a EUR-Lex page URL, an ELI with or without scheme or language segment) are normalized and echoed in `celex_number`. A citation without its act type (`95/46/EC`) or year (`Regulation No 17`) is not parsed
- An Official Journal reference resolves to the act starting on the cited page: issue, publication date, and first page (`OJ L 281, 23.11.1995, p. 31`, also `of 23.11.1995`, a page range, a class letter as in `OJ L 42I`, `OJ C`, and before 1968 the series-less `OJ 13, 21.2.1962, p. 204/62`); the year-first `OJ 1995 L 281, p. 31` and `OJ 1995 L 281/31`; and act-by-act `OJ L, 2024/1689, 12.7.2024` and `OJ C, C/2024/2664, 29.4.2024`. A cited date must equal the issue's publication date. Pages are matched on the English edition, or on any language before 1973 when the issue has no English pages. A reference without its year or first page (`OJ L 281`, `OJ L 119/1`) is not parsed. Recognized only under `auto`
- `identifier_type` auto-detects the format or sets it; `ambiguous_identifier` fires when auto-detection can't classify the input (including an OJ reference without its year or first page). A case number (`C-131/12`) returns `found: false` with a `notice` pointing to `eurlex_get_cases`
- Returns work URI, confirmed CELEX number, resource type, date, and the case's ECLI; `found: false` with a `notice` for a well-formed identifier that matches no work, for an OJ reference whose date or page matches nothing, and for one whose first page starts several acts (the `notice` names each CELEX)

---

### `eurlex_get_cases` <sub>tool</sub>

- Filters: `case_number` (`C-131/12`, `T-22/20`, `F-12/05`, or a pre-1989 `26/62`; reaches every judgment, order, and AG opinion filed under it), `court` (`CJEU` or `GC`), `case_type` (`judgment`, `order`, `ag_opinion`), `keyword` (English titles, plus CELEX numbers or fragments such as `2013CJ0131`), and `date_from`/`date_to`; primary records only unless `include_derivative` adds notices, abstracts, summaries, and corrigenda
- Pages of up to 100 via `offset`/`limit` (a larger `limit` is served at 100 and reported in `limit_clamp`), newest first; each case carries its ECLI where recorded, plus `formation`, `advocate_general`, `display_title`, `parties`, `referring_court`, `subject_matter`, and `case_reference`, and the raw `title` only when those fields miss part of it. Paging stops at row 10,000: the last page carries no `next_offset` and a `notice` giving the `date_from`/`date_to` window that continues past it
- No match returns an empty page with a `notice` on how to broaden the filters; typed errors: `invalid_case_number`, `invalid_date_range`, `invalid_keyword` (no letters or digits), `offset_past_window` (`offset` 10,000 or more)
- `case_type: "ag_opinion"` includes Advocate General opinions (`OPIN_AG`) and views (`VIEW_AG`); `resource_type` distinguishes `AG Opinion` from `AG View`

---

### `eurlex_get_relations` <sub>tool</sub>

- Exactly one of `celex_number` or `work_uri`; `relation_types` narrows to any of `cites`, `amends`, `amended_by`, `repeals`, `repealed_by`, `implicitly_repeals`, `implicitly_repealed_by`, `legal_basis`, `basis_for`, `interprets`, `interpreted_by`, `consolidated_version`, `national_transposition`, `adopts`, `adopted_by` (omit for all fifteen)
- `basis_for` lists the works naming the act among their legal bases; `interpreted_by` lists the CJEU and General Court rulings interpreting it, and `interprets` what a ruling interprets; `adopts` lists the works an act adopts (usually its Commission proposal) and `adopted_by` the act that adopted a work. `member_states` narrows `national_transposition` to named member states (ISO 3166-1 alpha-3 or two-letter codes, echoed as alpha-3); using it without `national_transposition` fails as `member_states_not_applicable`
- `article` narrows `interpreted_by` to rulings with a recorded provision in one article of the act (`17`, `6a`, `Article 17`, `Art. 17`, any case; blank is omitted; a paragraph, range, or Roman numeral is rejected). It matches at any depth, ignores leading zeros, and a letter also matches its Latin ordinal (`28c` reaches Article 28 quater); rulings CELLAR records no provision for are left out, as the `notice` says, and the echoed `article` is the normalized form. Using it without `interpreted_by` fails as `article_not_applicable`
- Amendment, repeal, interpretation, and adoption rows carry `provisions`, the provisions CELLAR records the edge as targeting, in compact codes (`A17P1LC` is Article 17(1)(c)) or authority-token codes (`AR 43 PA 4`); a row without them records none, which does not mean the edge reaches the whole act. A page that cannot fit its provisions within the budget at depth 1 withholds them whole, largest first, and reports each row's count as `provisions_withheld`; a provisions lookup CELLAR fails returns the rows without them, named in the `notice`
- One hop, paged per relation type and direction via `offset`/`limit` (up to 100, default 100; a larger `limit` is reported in `limit_clamp`), newest first. Each type and direction pages to row 10,000, then a `notice` routes older works to `eurlex_query_sparql` with a ready-to-run query
- Each complete response surface is budgeted independently at 64,000 UTF-8 bytes, including JSON and enrichment. Oversize pages retain the largest common per-type/direction depth that fits, with whole rows and titles; the notice gives requested/applied limits and rows withheld. Continue at `next_offset` (the current offset plus the applied depth). A depth-1 page is returned whole even if it exceeds the budget, with disclosure. Fitting pages are unchanged; omitting `relation_types` equals listing all fifteen types
- Each relation carries `relation_type`, `direction` (`outgoing`/`incoming`), `related_work_uri`, and where known `related_celex_number`, `related_date`, `related_title` (English only), and `related_member_state` on `national_transposition` rows; `empty_relation_types` separates "no edges of this type" from "paged out". Typed errors: `invalid_identifier_args`, `member_states_not_applicable`, `article_not_applicable`, `not_found`, `offset_past_window`

---

### `eurlex_browse_subjects` <sub>tool</sub>

- Matches preferred and alternative EuroVoc labels, so a common synonym resolves to its concept, in any EU official `language` (default English); `offset`/`limit` pagination (up to 50; a larger `limit` is served at 50 and reported in `limit_clamp`), to row 10,000 (`offset_past_window` beyond)
- Returns concept URI, preferred label, code, broader (parent) label, and the alternative label that matched when one did; an empty page with a `notice` when nothing matches
- Exact label matches rank first, then label or word-start matches, then other substring matches, so `"AI"` leads with artificial intelligence

---

### `eurlex_query_sparql` <sub>tool</sub>

- Read-only SELECT only (update forms and ASK/CONSTRUCT/DESCRIBE are rejected); `cdm:`, `skos:`, and `xsd:` prefixes are auto-injected; optional `timeout_hint` (1000–55000 ms)
- Results capped at `MAX_SPARQL_RESULTS` (default 100); a truncated result's `notice` says to add `ORDER BY` and repeat with a higher `OFFSET`, up to row 10,000. A zero-row result from an untyped string literal gets a `notice` to type it (`^^xsd:string`, `^^xsd:anyURI` for an ELI) or language-tag it
- Typed errors: `not_read_only` (a SPARQL Update), `unsupported_query_form` (ASK, CONSTRUCT, DESCRIBE, or no SELECT), `sparql_error`, `sparql_timeout`

---

### `eurlex://document/{celexNumber}` <sub>resource</sub>

- Metadata snapshot as `application/json` — resource type, author institution(s) labelled as `eurlex_get_document` labels them, Advocates General, date, English title, in-force flag, `eli`, `oj_reference`, `dates_of_effect`, `transposition_deadlines`, legal basis, EuroVoc subjects (the four citation fields as in `eurlex_get_document`); a consolidated text keeps its own `eli`, adds `base_act_celex`, and reads authors, in-force flag, `oj_reference`, `dates_of_effect`, `transposition_deadlines`, legal basis, and subjects from that act
- `celexNumber` comes from `eurlex_search_documents`, `eurlex_get_cases`, or `eurlex_lookup_celex`

---

### `eurlex://document/{celexNumber}/relations` <sub>resource</sub>

- One-hop relationship summary over all fifteen `eurlex_get_relations` types, with no `provisions`, each related work with its `related_date` and English `related_title` where it has them, capped at 25 per relation type and direction (newest kept)
- `truncated` plus a `continuation` pointer to `eurlex_get_relations` when more relations exist

---

### `eurlex_comparative_analysis` <sub>prompt</sub>

- Arguments: `domain` required; `focus` optional, folded into its matching analysis axis or added as its own section
- Returns a research plan that restates the domain in EU legal vocabulary ("antitrust" → "competition law"), chains `eurlex_browse_subjects` → `eurlex_search_documents` → `eurlex_get_document` → `eurlex_get_relations` for the EU side and `courtlistener_search_opinions` for the US side, plus a six-axis analysis framework

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EUR-Lex-specific:

- No API key required — CELLAR SPARQL and the EUR-Lex REST content endpoints are both publicly accessible
- SPARQL is POSTed with CDM prefix declarations built in; server-side LIMIT enforcement (max 100) guards against Virtuoso timeouts
- Act text is fetched via CELLAR content negotiation; HTML passes through as served, multi-part Formex4 XML is assembled into one document, and Markdown is converted server-side
- Syntax, compile, and sort-window errors fail at once as `sparql_error` (a sort-window error, `SR353`, hints to lower `OFFSET` or narrow the query) and timeouts as `sparql_timeout`, neither retried; gateway pages and other transient failures are retried inside the call's shared query budget (`SPARQL_QUERY_TIMEOUT_MS`), and a retry ladder the budget cuts short reports the last attempt's own failure
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
| `SPARQL_QUERY_TIMEOUT_MS` | Client-side timeout in milliseconds, an integer from 1 to 2147483647: the budget a call's CELLAR queries share (a call that chains queries spends it once, not per query) and the ceiling on any single query; an EUR-Lex content fetch gets its own timeout of this length, outside the shared budget. | `55000` |
| `MAX_SPARQL_RESULTS` | Enforced ceiling on LIMIT in all generated SPARQL queries. | `100` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | Session handling: `stateful`, `stateless`, or `auto` (`auto` resolves to stateful). | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool calls' arguments and result, redacted by key name (free-form values are not), capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). | `false` |
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
