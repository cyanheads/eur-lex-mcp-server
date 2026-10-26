# CELLAR SPARQL and the CDM vocabulary

What an `eurlex_query_sparql` query needs beyond the tool's own description. Every example below was run against the live endpoint through the tool.

## Prefixes and literals

- `cdm:`, `skos:`, and `xsd:` are injected for you. `owl:` also resolves without a declaration on CELLAR. Write the annotation vocabulary as full IRIs: `<http://publications.europa.eu/ontology/annotation#…>`.
- Identifiers are typed literals, and an untyped literal matches nothing:

| Value | Write it as |
|:--|:--|
| CELEX (`cdm:resource_legal_id_celex`) | `"32016R0679"^^xsd:string` |
| ECLI (`cdm:case-law_ecli`) | `"ECLI:EU:C:2014:317"^^xsd:string` |
| ELI (`cdm:resource_legal_eli`) | `"http://data.europa.eu/eli/reg/2016/679/oj"^^xsd:anyURI` |
| Title, label | `"…"@en`, or `FILTER(LANG(?label) = "en")` |
| Date | `"2026-01-01"^^xsd:date` |

- `cdm:resource_legal_in-force` comes back as `xsd:boolean` `"1"` or `"0"`. Compare it with `?inForce = true` or `= false`.
- Several work URIs can carry one CELEX: the ECLI above reaches two works for `62012CJ0131`. Use `SELECT DISTINCT` on the CELEX, or `GROUP BY` it.

## Titles live on expressions

A work has one expression per language, and the title sits on the expression:

```sparql
?expr cdm:expression_belongs_to_work ?work ;
      cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
      cdm:expression_title ?title .
```

The language URI ends in the upper-case ISO 639-2/T code (`ENG`, `FRA`, `DEU`). Many works have no English title (national implementing measures rarely do), so wrap the join in `OPTIONAL` unless the query needs a title. For a title phrase, use the full-text index: `?title bif:contains "'artificial intelligence'"`, with a single-quoted phrase inside the double quotes.

## Document types

`cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/{CODE}>`. The main codes are `REG`, `DIR`, `DEC`, `JUDG`, `ORDER`, `OPIN_AG`, `CONS_TEXT` (consolidated text), and `CORRIGENDUM`. Each family has variants: `REG_IMPL` and `REG_DEL` for implementing and delegated regulations, `DIR_IMPL`, `DEC_IMPL`, and so on. A plain `REG` match misses them, so list the variants in a `VALUES` block. A corrigendum carries `CORRIGENDUM` alongside the type of the act it corrects, so exclude it with `FILTER NOT EXISTS`.

## Relations and their stored direction

CELLAR stores most relations one way only. The reverse-named predicates (`…amended_by…`, `…has_consolidated_version…`) hold no triples, so ask for the reverse direction by swapping subject and object.

| Question | Pattern |
|:--|:--|
| What amends `?act` | `?amender cdm:resource_legal_amends_resource_legal ?act` |
| What `?act` repeals, explicitly or implicitly | `?act cdm:resource_legal_repeals_resource_legal ?old` · `?act cdm:resource_legal_implicitly_repeals_resource_legal ?old` |
| Consolidated texts of `?act` | `?cons cdm:act_consolidated_based_on_resource_legal ?act ; cdm:act_consolidated_date ?asOf` |
| Corrigenda of `?act` | `?corr cdm:resource_legal_corrects_resource_legal ?act` |
| Rulings interpreting `?act` | `?ruling cdm:case-law_interpretes_resource_legal ?act` |
| Legal basis of `?act` | `?act cdm:resource_legal_based_on_resource_legal ?basis` |
| The proposal `?act` adopts | `?act cdm:resource_legal_adopts_resource_legal ?proposal` |
| National measures transposing `?dir` | `?measure cdm:measure_national_implementing_implements_resource_legal ?dir` |
| Citations | `?a cdm:work_cites_work ?b` (both directions are meaningful) |
| Subjects | `?work cdm:work_is_about_concept_eurovoc ?concept` |
| Authors | `?work cdm:work_created_by_agent ?agent . ?agent skos:prefLabel ?name` |
| Dates | `cdm:work_date_document`, `cdm:resource_legal_date_entry-into-force`, `cdm:resource_legal_date_end-of-validity`, `cdm:directive_date_transposition` |

A consolidated text records no in-force flag, subjects, or legal basis of its own. Read those from the base act through `cdm:act_consolidated_based_on_resource_legal`.

## Provisions an edge targets

Amendment, repeal, interpretation, and adoption edges are reified as `owl:Axiom`s that name the provision of the edge's object:

```sparql
?ax owl:annotatedSource ?ruling ;
    owl:annotatedProperty cdm:case-law_interpretes_resource_legal ;
    owl:annotatedTarget ?act ;
    <http://publications.europa.eu/ontology/annotation#reference_to_modified_location> ?loc .
```

`?loc` is a compact designator such as `A17P1LD` (Article 17(1)(d)), with article numbers zero-padded (`A04PT7`), or an authority-code form such as `{AR|…} 43 {PA|…} 4`. The decoding table is in the `provisions` description of `eurlex_get_relations`. Some edges carry the same axiom twice, so select `DISTINCT`. Citation, legal-basis, and transposition edges have axioms but no `reference_to_modified_location`; consolidation edges have no axiom at all.

## EuroVoc

Concepts are `skos:Concept`s with `skos:prefLabel` and `skos:altLabel` per language, `skos:notation`, and `skos:broader`. A concept can have more than one broader concept. To match a concept and every concept below it, use `?c skos:broader* <http://eurovoc.europa.eu/2828> . ?work cdm:work_is_about_concept_eurovoc ?c`.

## Virtuoso behaviour that changes results

- **Give every date range a lower bound.** A range open below can drop rows inside it without an error. Use `"1000-01-01"^^xsd:date` when you mean "no lower bound", since CELLAR's earliest document date is 1001-01-01.
- **Under `ORDER BY DESC(?date)`, project the date with `SAMPLE`, not `MAX`.** With no selective pattern, `MAX` over the ordered column lets the planner skip the date range's upper bound.
- **Take a grouped maximum of an `OPTIONAL` date as `MAX(STR(?date))`, and compare dates inside that `OPTIONAL` as strings.** A plain `MAX` over an `OPTIONAL` `xsd:date` comes back wrong. A typed comparison inside the `OPTIONAL` (`FILTER(?date <= NOW())`, or against an `xsd:date` literal) makes even `MAX(STR(?date))` return a stale date on some runs, while `FILTER(STR(?date) <= STR(NOW()))` returns the latest every time. ISO dates sort lexically, so the string forms keep date order.
- **Anchor on an indexed value.** Start from a typed CELEX, ECLI, or ELI triple, a `bif:contains` phrase, or a type plus a bounded date range. `FILTER(STR(?celex) = …)` or `CONTAINS` over every CELEX scans the whole corpus.
- **A sorted query can only read 10,000 rows.** A sorted query whose `OFFSET` + `LIMIT` passes row 10,000 fails with `SR353`. Narrow the query with a date window instead of paging further.
- **Timeouts are final.** A `sparql_timeout`, whether it hit the 55 s client budget or Virtuoso refused the query as too costly, fails the same way on retry. Narrow the query before you run it again.

## Examples

Acts amending the VAT Directive, newest first, with English titles:

```sparql
SELECT DISTINCT ?amender ?celex ?date ?title WHERE {
  ?act cdm:resource_legal_id_celex "32006L0112"^^xsd:string .
  ?amender cdm:resource_legal_amends_resource_legal ?act ;
           cdm:resource_legal_id_celex ?celex .
  OPTIONAL { ?amender cdm:work_date_document ?date }
  OPTIONAL { ?expr cdm:expression_belongs_to_work ?amender ;
                   cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
                   cdm:expression_title ?title }
} ORDER BY DESC(?date) LIMIT 5
```

Rulings interpreting Article 17 of the GDPR, with the provision recorded:

```sparql
SELECT DISTINCT ?celex ?loc WHERE {
  ?act cdm:resource_legal_id_celex "32016R0679"^^xsd:string .
  ?ruling cdm:case-law_interpretes_resource_legal ?act ;
          cdm:resource_legal_id_celex ?celex .
  ?ax owl:annotatedSource ?ruling ;
      owl:annotatedProperty cdm:case-law_interpretes_resource_legal ;
      owl:annotatedTarget ?act ;
      <http://publications.europa.eu/ontology/annotation#reference_to_modified_location> ?loc .
  FILTER(REGEX(?loc, "^A0*17([^0-9]|$)"))
}
```

Directives whose transposition deadline falls in 2026:

```sparql
SELECT DISTINCT ?celex ?deadline WHERE {
  ?dir cdm:directive_date_transposition ?deadline ;
       cdm:resource_legal_id_celex ?celex .
  FILTER(?deadline >= "2026-01-01"^^xsd:date && ?deadline <= "2026-12-31"^^xsd:date)
} ORDER BY ?deadline
```

Two hops, from a ruling to each act it interprets and that act's latest consolidation in effect:

```sparql
SELECT ?actCelex (MAX(STR(?asOf)) AS ?latestConsolidation) WHERE {
  ?ruling cdm:resource_legal_id_celex "62012CJ0131"^^xsd:string ;
          cdm:case-law_interpretes_resource_legal ?act .
  ?act cdm:resource_legal_id_celex ?actCelex .
  OPTIONAL { ?cons cdm:act_consolidated_based_on_resource_legal ?act ;
                   cdm:act_consolidated_date ?asOf .
             FILTER(STR(?asOf) <= STR(NOW())) }
} GROUP BY ?actCelex
```

Works on a EuroVoc concept, counted exactly and with its narrower concepts:

```sparql
SELECT ?exact ?withNarrower WHERE {
  { SELECT (COUNT(DISTINCT ?w) AS ?exact) WHERE {
      ?w cdm:work_is_about_concept_eurovoc <http://eurovoc.europa.eu/2828> } }
  { SELECT (COUNT(DISTINCT ?w2) AS ?withNarrower) WHERE {
      ?c skos:broader* <http://eurovoc.europa.eu/2828> .
      ?w2 cdm:work_is_about_concept_eurovoc ?c } }
}
```
