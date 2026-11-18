/**
 * @fileoverview The request body CELLAR's SPARQL endpoint receives for a query: the
 * PREFIX block prepended, the form encoding, its exact byte count, and the endpoint's
 * limit on it. Kept apart from the service, so a module that sizes a query before
 * sending it reads the same measure the service checks.
 * @module services/cellar-sparql/sparql-request-body
 */

/** Required PREFIX declarations for CELLAR CDM ontology queries. */
const SPARQL_PREFIXES = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

/**
 * Longest request body CELLAR's SPARQL endpoint accepts, in bytes. The load balancer
 * in front of it answers a longer one with HTTP 403, counting the whole form-encoded
 * body (`query=…&format=…`), not the query text alone.
 */
export const CELLAR_REQUEST_LIMIT_BYTES = 8192;

/** The query CELLAR receives: the `PREFIX` block is prepended unless it declares `cdm:`. */
export function withSparqlPrefixes(rawQuery: string): string {
  return rawQuery.includes('PREFIX cdm:') ? rawQuery : SPARQL_PREFIXES + rawQuery;
}

/** The form-encoded request body for a query. Percent-encoded, so its length is its byte count. */
export function sparqlRequestBody(query: string): string {
  return new URLSearchParams({
    query,
    format: 'application/sparql-results+json',
  }).toString();
}

/**
 * Bytes of the request body `CellarSparqlService.query` sends for `rawQuery`, to size
 * a query against {@link CELLAR_REQUEST_LIMIT_BYTES} before sending it. Exact for a
 * query with no `LIMIT` above the service ceiling, which is sent as written; a
 * `LIMIT` the ceiling rewrites only shortens the body.
 */
export function sparqlRequestBytes(rawQuery: string): number {
  return sparqlRequestBody(withSparqlPrefixes(rawQuery)).length;
}
