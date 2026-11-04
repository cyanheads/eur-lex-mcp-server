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
| Commission document number (`cdm:work_id_document`) | `"comnat:COM_2021_0206_FIN"^^xsd:string`: series, year, number padded to four digits, `_FIN2` for `final/2`; before 2010 a part as `COM_1990_0314(01)_FIN` |
| Procedure reference (`cdm:procedure_code_interinstitutional_reference_procedure`, on the dossier) | `"2021/0106/COD"^^xsd:string`; the dossier's `cdm:dossier_initiated_by_act_preparatory` is the proposal. A proposal reaches its dossier as `<work> cdm:work_part_of_dossier ?d`, many older ones only as `?d cdm:dossier_initiated_by_act_preparatory <work>`; most adopted acts only as `?d cdm:dossier_produces_resource_legal <work>`, so read all three. Status is the one of `cdm:dossier_adopted-proposal`, `_withdrawn-proposal`, `_pending-proposal`, `_not-adopted-proposal` set true (each is recorded `true` or `false`, so test the value); `cdm:dossier_date_withdrawn` dates a withdrawal. `procedure_code_interinstitutional_has_status_file-status` reads `PROP_PENDING` on withdrawn dossiers, and `cdm:dossier_date_adopted` is often the OJ date |
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

## Case-law facts

Court of Justice and General Court rulings carry no EuroVoc concept. A judgment, order, or AG opinion carries four classification facts instead, each with possibly several values, on its canonical work only: a `do_not_index` copy of the same CELEX carries none, and derivative records at most the procedure language.

| Fact | Pattern | Value |
|:--|:--|:--|
| Country the case originates in | `?work cdm:case-law_originates_in_country ?country` | `<http://publications.europa.eu/resource/authority/country/DEU>`, the upper-case ISO 3166-1 alpha-3 code |
| Procedure type and outcome | `?work cdm:case-law_has_type_procedure_concept_type_procedure ?procedure` | `<http://publications.europa.eu/resource/authority/fd_100/ANNU%3DOB>`: a procedure root, then the outcome after `%3D` |
| Subject | `?work cdm:case-law_is-about_case-law-subject-matter ?subject` | `<http://publications.europa.eu/resource/authority/case-law-subject-matter/PDON>`, one of 186 concepts `skos:inScheme <http://publications.europa.eu/resource/authority/case-law-subject-matter>` |
| Procedure language | `?work cdm:case-law_uses_procedure_language ?language` | `<http://publications.europa.eu/resource/authority/language/BUL>`, the ISO 639-2/T code |

Each value's English `skos:prefLabel` names it ("Action for annulment - successful", "Protection of personal data"). Every one of these tables also holds `OP_DATPRO`, "Provisional data", which records nothing about a case.

The procedure IRI stores the `=` between root and outcome as `%3D`, so `<…/fd_100/ANNU=OB>` matches nothing. Match a root as the IRI itself or the root plus `%3D`, never as a bare prefix: `STRSTARTS(STR(?procedure), "…/fd_100/REFE")`, meant for interim measures, also takes `REFER_PREL_URG`, the urgent preliminary references.

The most frequent roots, the ones `procedure_type` on `eurlex_get_cases` matches:

| Root | Procedure |
|:--|:--|
| `PREJ`, `REFER_PREL_URG` | Preliminary reference, ordinary and urgent |
| `ANNU` | Action for annulment |
| `FONC` | Staff case |
| `PVOI` | Appeal |
| `CONS` | Failure to fulfil obligations |
| `RESP` | Action for damages |
| `REFE` | Interim measures |
| `SANC` | Appeal against a penalty |
| `CARE` | Failure to act |
| `COMP` | Arbitration clause |

The outcomes after `%3D` are `OB` successful, `RF` unfounded, `RI` inadmissible, and `NL` decision unnecessary; preliminary references rarely record one. An appeal also carries the code of the action appealed. The country is the referring court's state on a preliminary reference, the defendant state on `CONS`, and the applicant's state or the member-state party on a direct action; staff cases usually carry none.

## Virtuoso behaviour that changes results

- **Give every date range a lower bound.** A range open below can drop rows inside it without an error. Use `"1000-01-01"^^xsd:date` when you mean "no lower bound", since CELLAR's earliest document date is 1001-01-01. That date is CELLAR's placeholder for an unknown date, on `cdm:work_date_document` and on a national measure's official-journal and notification dates, so a query reading the oldest or newest date should exclude it; the curated tools report it as no date.
- **Under `ORDER BY DESC(?date)`, project the date with `SAMPLE`, not `MAX`.** With no selective pattern, `MAX` over the ordered column lets the planner skip the date range's upper bound.
- **Take a grouped maximum of an `OPTIONAL` date as `MAX(STR(?date))`, and compare dates inside that `OPTIONAL` as strings.** A plain `MAX` over an `OPTIONAL` `xsd:date` comes back wrong. A typed comparison inside the `OPTIONAL` (`FILTER(?date <= NOW())`, or against an `xsd:date` literal) makes even `MAX(STR(?date))` return a stale date on some runs, while `FILTER(STR(?date) <= STR(NOW()))` returns the latest every time. ISO dates sort lexically, so the string forms keep date order.
- **Group on an IRI, not a computed string.** A `GROUP BY` key built with `BIND(SUBSTR(STR(?celex), …))` can split one value into several groups, apparently by the length of the string it came from: counting NIS2's national measures per member state that way returns Czechia twice (27 and 56 measures) and Hungary twice (4 and 36). Build the key as an IRI instead, `BIND(IRI(CONCAT("urn:member-state:", SUBSTR(STRAFTER(STR(?celex), "72022L2555"), 1, 3))) AS ?memberState)`, and read the code back from its end.
- **Anchor on an indexed value.** Start from a typed CELEX, ECLI, or ELI triple, a `bif:contains` phrase, or a type plus a bounded date range. `FILTER(STR(?celex) = …)` or `CONTAINS` over every CELEX scans the whole corpus.
- **A sorted query can only read 10,000 rows.** A sorted query whose `OFFSET` + `LIMIT` passes row 10,000 fails with `SR353`. Narrow the query with a date window instead of paging further.
- **Read a `sparql_timeout` by its `retryable` flag.** Not retryable means Virtuoso refused the query as over its estimated-cost limit: it is refused on every run until you narrow it. Retryable means the query ran past its client timeout (`timeout_hint`, 55 s by default): CELLAR's response time varies, so a later run can finish, but a query slower than its timeout fails every run. Narrow one that keeps timing out, or raise a `timeout_hint` set below 55000.

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

Ordinary preliminary references (`PREJ`, any outcome) from German courts on the protection of personal data, newest first, one row per CELEX:

```sparql
SELECT ?celex (SAMPLE(?date) AS ?decided) WHERE {
  ?work cdm:case-law_originates_in_country <http://publications.europa.eu/resource/authority/country/DEU> ;
        cdm:case-law_has_type_procedure_concept_type_procedure ?procedure ;
        cdm:case-law_is-about_case-law-subject-matter <http://publications.europa.eu/resource/authority/case-law-subject-matter/PDON> ;
        cdm:resource_legal_id_celex ?celex .
  FILTER(?procedure = <http://publications.europa.eu/resource/authority/fd_100/PREJ>
         || STRSTARTS(STR(?procedure), "http://publications.europa.eu/resource/authority/fd_100/PREJ%3D"))
  OPTIONAL { ?work cdm:work_date_document ?date }
} GROUP BY ?celex ORDER BY DESC(?decided) LIMIT 5
```
