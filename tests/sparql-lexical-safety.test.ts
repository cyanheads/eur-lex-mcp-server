/**
 * @fileoverview Lexical-safety gate over every SPARQL query a tool or resource builds
 * from caller input. Each string input of every definition is sent hostile values;
 * every query the handler hands the CELLAR service is lexed, and a caller value must
 * land inside a well-formed short string literal, a well-formed IRI, or a
 * `bif:contains` expression of phrases and prefix terms. An input rejected before any
 * query is built passes, so constrained, derived, and constant interpolation sites
 * need no allowlist. Exempt are `eurlex_query_sparql.sparql_query`, which takes caller
 * SPARQL by design, and the `eurlex_get_document.select.*` strings, which never reach
 * a query.
 * @module tests/sparql-lexical-safety.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

/** Every query a handler hands the CELLAR service during the current value's run. */
const captured: string[] = [];
const capture = async (query: string) => {
  captured.push(query);
  return [];
};

vi.mock('@/services/cellar-sparql/cellar-sparql-service.js', () => ({
  getCellarSparqlService: () => ({
    query: capture,
    queryWithContinuation: capture,
    queryWithVars: async (query: string) => {
      captured.push(query);
      return { variables: [], bindings: [], limitEnforced: false };
    },
    maxResults: 100,
  }),
  CellarSparqlService: {
    bindingValue: (binding: Record<string, { value?: string }> | undefined, field: string) =>
      binding?.[field]?.value,
    parseBoolean: () => undefined,
  },
}));

vi.mock('@/services/eurlex-content/eurlex-content-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getEurLexContentService: () => ({
    fetchContent: async () => {
      throw new Error('The content service is outside this gate.');
    },
  }),
}));

const { getCellarSparqlService } = await import(
  '@/services/cellar-sparql/cellar-sparql-service.js'
);
const { escapeSparqlLiteral } = await import('@/services/cellar-sparql/eli-resolution.js');
const { allToolDefinitions } = await import('@/mcp-server/tools/definitions/index.js');
const { allResourceDefinitions } = await import('@/mcp-server/resources/definitions/index.js');

/** Marker every hostile value carries, so its landing spots can be found in a query. */
const MARKER = 'zq7';

/** Every character that can end a literal, an IRI, or a phrase early, or open a full-text operator. */
const HOSTILE = 'Zq7"\'\\<>{}|^`*\nZq7\r\tZq7\x01Zq7';

/**
 * The SPARQL 1.1 IRIREF exclusion set (grammar rule [139]), sampled across the
 * control range. Each goes into its own value, between two markers, so an IRI guard
 * that misses one character is caught rather than masked by another the value also
 * holds, and an early `>` leaves the second marker outside the IRI.
 */
const IRI_EXCLUDED = ['<', '>', '"', '{', '}', '|', '^', '`', '\\', '\x00', '\x01', '\x1f', ' '];

/** Prefixes that route an identifier into its ECLI, ELI, EuroVoc, or work-URI branch. */
const PREFIXES = [
  'ECLI:EU:C:',
  'http://data.europa.eu/eli/',
  'http://eurovoc.europa.eu/',
  'http://publications.europa.eu/resource/cellar/',
];

const VARIANTS = [
  HOSTILE,
  // Opens with a quote, so an unguarded `<${value}>` starts with `<"`.
  `"${HOSTILE}`,
  ...PREFIXES.flatMap((prefix) => [
    `${prefix}${HOSTILE}`,
    ...IRI_EXCLUDED.map((ch) => `${prefix}Zq7${ch}Zq7`),
  ]),
  // CELEX characters only, so the routes gated on the CELEX charset see the marker.
  'Zq7(01)_X',
  // Well-formed URIs carrying the marker, so the URI inputs provably reach a query.
  'http://eurovoc.europa.eu/zq7',
  'http://publications.europa.eu/resource/cellar/zq7-0000',
];

/**
 * Values a real caller sends, one of which each tested input must accept with its
 * seeded siblings, so a case whose every variant fails the schema is caught.
 */
const BENIGN = [
  'privacy',
  'en',
  '32016R0679',
  '2016-05-04',
  'C-311/18',
  'http://eurovoc.europa.eu/2828',
  'http://data.europa.eu/eli/reg/2016/679/oj',
  'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1',
];

/** A SPARQL 1.1 IRIREF (grammar rule [139]) at the start of the string. */
const IRIREF = /^<([^<>"{}|^`\\\x00-\x20]*)>/;

/**
 * A `bif:contains` expression: quoted terms joined by OR, each a phrase of letters,
 * digits, and spaces, or a prefix term of at least four letters or digits ending in
 * `*` (CELLAR rejects a shorter one with FT370).
 */
const BIF_TERM = String.raw`'(?:[\p{L}\p{N} ]+|[\p{L}\p{N}]{4,}\*)'`;
const BIF_EXPRESSION = new RegExp(`^${BIF_TERM}(?: OR ${BIF_TERM})*$`, 'u');

/** A literal opening as the expression of `bif:contains`, in the triple or the function form. */
const BIF_CONTAINS_BEFORE = /bif:contains\s*(?:\(\s*\?\w+\s*,\s*)?$/i;

/**
 * Lex the tokens that can carry a caller value — short string literals and IRIs —
 * and report each malformed one, each `bif:contains` expression outside the phrase
 * grammar, and each marker that sits outside every token. A `<` followed by `=` or
 * whitespace is the comparison operator; any other `<` opens an IRI.
 */
function sparqlLexicalIssues(query: string): string[] {
  const issues: string[] = [];
  const tokens: [start: number, end: number][] = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (c === '#') {
      const eol = query.indexOf('\n', i);
      i = eol === -1 ? query.length : eol;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < query.length && query[j] !== c; j++) {
        const d = query[j];
        if (d === '\n' || d === '\r') {
          issues.push(`raw line break inside a string literal at ${j}`);
          break;
        }
        if (d === '\\') {
          if (!/[tbnrf"'\\]/.test(query[j + 1] ?? '')) issues.push(`invalid escape at ${j}`);
          j++;
        }
      }
      if (j >= query.length) issues.push(`unterminated string literal at ${i}`);
      const content = query.slice(i + 1, j);
      if (BIF_CONTAINS_BEFORE.test(query.slice(0, i)) && !BIF_EXPRESSION.test(content)) {
        issues.push(`bif:contains expression outside the phrase grammar: ${content}`);
      }
      tokens.push([i, j]);
      i = j + 1;
      continue;
    }
    if (c === '<' && /[^=\s]/.test(query[i + 1] ?? '')) {
      const iri = IRIREF.exec(query.slice(i));
      if (!iri) {
        issues.push(`malformed IRI at ${i}: ${query.slice(i, i + 60)}`);
        i++;
        continue;
      }
      tokens.push([i, i + iri[0].length - 1]);
      i += iri[0].length;
      continue;
    }
    i++;
  }
  const lower = query.toLowerCase();
  for (let at = lower.indexOf(MARKER); at !== -1; at = lower.indexOf(MARKER, at + 1)) {
    if (!tokens.some(([start, end]) => at > start && at < end)) {
      issues.push(`caller value outside a literal or IRI at ${at}`);
    }
  }
  return issues;
}

/** The Zod definition behind a schema. */
function zodDef(schema: unknown): Record<string, unknown> | undefined {
  return (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
}

/**
 * The path of every string a schema accepts, through its optional/default/union
 * wrappers and into nested objects (`.field`) and arrays (`[]`).
 */
function stringLeaves(schema: unknown, path: string): string[] {
  const def = zodDef(schema);
  switch (def?.type) {
    case 'string':
      return [path];
    case 'optional':
    case 'default':
    case 'nullable':
    case 'prefault':
    case 'readonly':
      return stringLeaves(def.innerType, path);
    case 'pipe':
      return stringLeaves(def.in, path);
    case 'union':
      return [...new Set((def.options as unknown[]).flatMap((o) => stringLeaves(o, path)))];
    case 'object':
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, field]) =>
        stringLeaves(field, `${path}.${key}`),
      );
    case 'array':
      return stringLeaves(def.element, `${path}[]`);
    default:
      return [];
  }
}

/**
 * A value a required input accepts: its first enum value, its literal, or a benign
 * scalar. Optional and defaulted inputs are left for the schema to fill.
 */
function seedValue(schema: unknown): unknown {
  const def = zodDef(schema);
  switch (def?.type) {
    case 'enum':
      return Object.values(def.entries as Record<string, unknown>)[0];
    case 'literal':
      return (def.values as unknown[])[0];
    case 'string':
      return 'privacy';
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'union':
      return seedValue((def.options as unknown[])[0]);
    case 'pipe':
      return seedValue(def.in);
    default:
      return undefined;
  }
}

/** The surface of a tool or resource definition the gate drives. */
interface GateTarget {
  errors?: unknown;
  handler: (input: never, ctx: never) => unknown;
  name: string;
  schema: z.ZodObject;
}

interface GateCase {
  build: (v: string) => Record<string, unknown>;
  id: string;
  target: GateTarget;
}

/**
 * Base inputs no schema seed can supply — an identifier that satisfies the
 * object-level one-of rule — and the identifiers of which exactly one may be sent.
 */
const BASE: Record<string, { base: Record<string, unknown>; exclusive: string[] }> = {
  eurlex_get_document: {
    base: { celex_number: '32016R0679' },
    exclusive: ['celex_number', 'eli_uri', 'work_uri'],
  },
  eurlex_get_relations: {
    base: { celex_number: '32016R0679' },
    exclusive: ['celex_number', 'work_uri'],
  },
};

/** Why each untested string input is exempt. */
const SELECT_EXEMPTION =
  'selects sections of the fetched act text (act-structure); never reaches a SPARQL query';
const EXEMPT: Record<string, string> = {
  'eurlex_query_sparql.sparql_query': 'takes caller SPARQL by design',
  ...Object.fromEntries(
    ['articles', 'chapters', 'recitals', 'annexes', 'headings'].map((key) => [
      `eurlex_get_document.select.${key}`,
      SELECT_EXEMPTION,
    ]),
  ),
};

/** Free-text and URI inputs: each must reach a query, so the gate cannot pass vacuously. */
const MUST_REACH = [
  'eurlex_lookup_celex.identifier',
  'eurlex_browse_subjects.keyword',
  'eurlex_search_documents.keyword',
  'eurlex_search_documents.author_institution',
  'eurlex_search_documents.eurovoc_concept',
  'eurlex_get_cases.keyword',
  'eurlex_get_cases.case_number',
  'eurlex_get_document.eli_uri',
  'eurlex_get_document.work_uri',
  'eurlex_get_relations.work_uri',
];

/**
 * One case per top-level string input of `target`, each sending its value beside
 * the seeded required siblings and the target's base input.
 */
function casesFor(target: GateTarget): GateCase[] {
  const { base = {}, exclusive = [] } = BASE[target.name] ?? {};
  const shape = target.schema.shape as Record<string, z.ZodType>;
  const seeded = Object.fromEntries(
    Object.entries(shape)
      .filter(([, schema]) => !schema.safeParse(undefined).success)
      .map(([field, schema]) => [field, seedValue(schema)]),
  );
  const defaults = { ...seeded, ...base };
  return Object.entries(shape).flatMap(([field, schema]) => {
    const id = `${target.name}.${field}`;
    if (!stringLeaves(schema, id).includes(id) || id in EXEMPT) return [];
    const dropped = exclusive.includes(field) ? exclusive : [field];
    const kept = Object.entries(defaults).filter(([key]) => !dropped.includes(key));
    return [{ id, target, build: (v: string) => ({ ...Object.fromEntries(kept), [field]: v }) }];
  });
}

/**
 * Run every variant through the case's schema and handler. Reports whether a
 * benign value parses, whether the marker reached a query, and each lexical issue.
 */
async function runCase({ target, build }: GateCase) {
  const benignParses = BENIGN.some((value) => target.schema.safeParse(build(value)).success);
  let reached = false;
  const findings: string[] = [];
  for (const value of VARIANTS) {
    captured.length = 0;
    const parsed = target.schema.safeParse(build(value));
    if (!parsed.success) continue;
    const ctx = createMockContext({ errors: target.errors } as never);
    // A rejection is a safe outcome; only the queries built before it are checked.
    await Promise.resolve(target.handler(parsed.data as never, ctx as never)).catch(() => {});
    for (const query of captured) {
      if (query.toLowerCase().includes(MARKER)) reached = true;
      for (const issue of sparqlLexicalIssues(query)) {
        findings.push(`${JSON.stringify(value)}: ${issue}\n${query}`);
      }
    }
  }
  return { benignParses, reached, findings };
}

const targets: GateTarget[] = [
  ...(allToolDefinitions as unknown as (GateTarget & { input: z.ZodObject })[]).map((def) => ({
    ...def,
    schema: def.input,
  })),
  ...(allResourceDefinitions as unknown as (GateTarget & { params: z.ZodObject })[]).map((def) => ({
    ...def,
    schema: def.params,
  })),
];
const cases = targets.flatMap(casesFor);

describe('SPARQL lexical safety of caller input', () => {
  it('covers every string input, nested ones included, unless exempt with a reason', () => {
    const leaves = targets.flatMap((target) => stringLeaves(target.schema, target.name));
    const tested = new Set(cases.map((c) => c.id));
    expect(leaves.filter((id) => !tested.has(id) && !(id in EXEMPT))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((id) => !leaves.includes(id))).toEqual([]);
    expect(MUST_REACH.filter((id) => !tested.has(id))).toEqual([]);
  });

  it.each(cases)('$id lands only inside well-formed literals and IRIs', async (gateCase) => {
    const { benignParses, reached, findings } = await runCase(gateCase);
    expect(
      benignParses,
      `no benign value for ${gateCase.id} parses with its seeded siblings, so no variant reaches the handler`,
    ).toBe(true);
    expect(findings).toEqual([]);
    if (MUST_REACH.includes(gateCase.id)) {
      expect(reached, `${gateCase.id} never reached a query`).toBe(true);
    }
  });
});

describe('gate harness', () => {
  /** A tool with a required enum beside its free-text input, which a bare `{ term }` fails. */
  const probe = (interpolate: (term: string) => string): GateTarget => ({
    name: 'probe',
    schema: z.object({
      term: z.string().min(1).describe('Term.'),
      scope: z.enum(['a', 'b']).describe('Scope.'),
    }),
    handler: (async (input: { term: string }) => {
      await getCellarSparqlService().query(
        `SELECT ?s WHERE { ?s ?p "${interpolate(input.term)}" . }`,
        {} as never,
      );
    }) as never,
  });

  it('seeds a required sibling, so an unescaped input beside it fails the gate', async () => {
    const [gateCase] = casesFor(probe((term) => term));
    expect(gateCase?.build('x')).toEqual({ scope: 'a', term: 'x' });
    const { benignParses, findings } = await runCase(gateCase as GateCase);
    expect(benignParses).toBe(true);
    expect(findings).not.toEqual([]);
  });

  it('passes the same input once it is escaped', async () => {
    const [gateCase] = casesFor(probe(escapeSparqlLiteral));
    const { reached, findings } = await runCase(gateCase as GateCase);
    expect(reached).toBe(true);
    expect(findings).toEqual([]);
  });

  it('finds string leaves through wrappers, unions, nested objects, and arrays', () => {
    const schema = z.object({
      a: z.string(),
      b: z.object({ c: z.string().optional(), d: z.number() }).optional(),
      e: z.array(z.string()),
      f: z.union([z.literal(''), z.string()]),
      g: z.enum(['x']),
    });
    expect(stringLeaves(schema, 't')).toEqual(['t.a', 't.b.c', 't.e[]', 't.f']);
  });
});

describe('sparqlLexicalIssues', () => {
  it.each([
    ['an escaped literal', 'SELECT ?w WHERE { ?w ?p "Zq7\\"x" . }'],
    ['a well-formed IRI', 'SELECT ?w WHERE { ?w ?p <http://eurovoc.europa.eu/zq7> . }'],
    ['a bif:contains phrase', `SELECT ?w WHERE { ?t bif:contains "'zq7 data'" . }`],
    ['prefix terms', `SELECT ?w WHERE { ?c bif:contains "'ZQ7A*' OR 'ZQ7B*'" . }`],
    [
      'a phrase in the function form',
      `SELECT ?w WHERE { ?w ?p ?t . FILTER(bif:contains(?t, "'zq7 data'")) }`,
    ],
    ['comparison operators', 'SELECT ?w WHERE { FILTER(?d <= "zq7" && ?a < ?b) }'],
  ])('accepts %s', (_label, query) => {
    expect(sparqlLexicalIssues(query)).toEqual([]);
  });

  it.each([
    ['a quote that ends the literal early', 'SELECT ?w WHERE { ?w ?p "x"Zq7 . }'],
    ['an unterminated literal', 'SELECT ?w WHERE { ?w ?p "Zq7 . }'],
    ['a raw newline in a literal', 'SELECT ?w WHERE { ?w ?p "Zq7\nx" . }'],
    ['an invalid escape', 'SELECT ?w WHERE { ?w ?p "Zq7\\x" . }'],
    ['an IRI opening with a quote', 'SELECT ?w WHERE { ?w ?p <"zq7"> . }'],
    ['an apostrophe in a phrase', `SELECT ?w WHERE { ?t bif:contains "'zq7's'" . }`],
    [
      'an operator in the function form',
      `SELECT ?w WHERE { FILTER(bif:contains(?t, "'zq7' AND 'data'")) }`,
    ],
    ['a mid-term *', `SELECT ?w WHERE { ?t bif:contains "'zq7*data'" . }`],
    ['a * after a space', `SELECT ?w WHERE { ?t bif:contains "'data zq7*'" . }`],
    ['a prefix term under four characters', `SELECT ?w WHERE { ?t bif:contains "'zq7*'" . }`],
    ['a marker outside any token', 'SELECT ?w WHERE { ?w ?p ?zq7 . }'],
  ])('reports %s', (_label, query) => {
    expect(sparqlLexicalIssues(query)).not.toEqual([]);
  });

  it.each(IRI_EXCLUDED.map((ch) => [JSON.stringify(ch), ch]))(
    'reports %s inside an IRI',
    (_label, ch) => {
      expect(
        sparqlLexicalIssues(`SELECT ?w WHERE { ?w ?p <http://eurovoc.europa.eu/zq7${ch}zq7> . }`),
      ).not.toEqual([]);
    },
  );
});
