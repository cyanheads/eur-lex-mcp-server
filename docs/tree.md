# eur-lex-mcp-server - Directory Structure

Generated on: 2026-09-25 13:21:42

```text
eur-lex-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.10.x/
│   ├── 0.11.x/
│   ├── 0.12.x/
│   ├── 0.13.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   ├── 0.8.x/
│   ├── 0.9.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── eurlex-comparative-analysis.prompt.ts
│   │   │       └── index.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── eurlex-document-relations.resource.ts
│   │   │       ├── eurlex-document.resource.ts
│   │   │       └── index.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── eurlex-browse-subjects.tool.ts
│   │           ├── eurlex-get-cases.tool.ts
│   │           ├── eurlex-get-document.tool.ts
│   │           ├── eurlex-get-relations.tool.ts
│   │           ├── eurlex-lookup-celex.tool.ts
│   │           ├── eurlex-query-sparql.tool.ts
│   │           ├── eurlex-search-documents.tool.ts
│   │           └── index.ts
│   ├── services/
│   │   ├── cellar-sparql/
│   │   │   ├── cdm-labels.ts
│   │   │   ├── cellar-sparql-service.ts
│   │   │   ├── eli-resolution.ts
│   │   │   ├── relation-traversal.ts
│   │   │   └── types.ts
│   │   └── eurlex-content/
│   │       ├── act-structure.ts
│   │       ├── eurlex-content-service.ts
│   │       └── html-to-markdown.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── aws-waf-challenge.ts
│   │   ├── eurlex-act-html.ts
│   │   └── eurlex-formex-multipart.ts
│   ├── prompts/
│   │   └── eurlex-comparative-analysis.prompt.test.ts
│   ├── resources/
│   │   ├── eurlex-document-relations.resource.test.ts
│   │   └── eurlex-document.resource.test.ts
│   ├── services/
│   │   ├── act-structure.test.ts
│   │   ├── cdm-labels.test.ts
│   │   ├── cellar-sparql-service.test.ts
│   │   ├── eli-resolution.test.ts
│   │   ├── eurlex-content-service.test.ts
│   │   └── html-to-markdown.test.ts
│   └── tools/
│       ├── eurlex-browse-subjects.tool.test.ts
│       ├── eurlex-get-cases.tool.test.ts
│       ├── eurlex-get-document.tool.test.ts
│       ├── eurlex-get-relations.tool.test.ts
│       ├── eurlex-lookup-celex.tool.test.ts
│       ├── eurlex-query-sparql.tool.test.ts
│       └── eurlex-search-documents.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
