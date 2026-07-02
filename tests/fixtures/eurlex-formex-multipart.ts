/**
 * @fileoverview Fixtures for multi-part Formex 4 assembly (issue #18). Mirrors the
 * real CELLAR wire shape observed for GDPR `32016R0679` under
 * `Accept: application/xml;type=fmx4`: an HTTP 300 "Multiple Choices" index whose
 * XHTML `<a href="…/DOC_N">` links point at the sibling streams, a small `<DOC>`/
 * `<BIB.DOC>` notice header (DOC_1), and the `<ACT>` body carrying the enacting
 * terms and articles (DOC_2). The index and DOC_1 are verbatim live responses;
 * DOC_2 is trimmed from the 418 KB original but structurally faithful. NOT
 * refreshed against the live network — a recorded snapshot.
 * @module tests/fixtures/eurlex-formex-multipart
 */

/**
 * The verbatim CELLAR "300 Multiple Choices" index body for GDPR `32016R0679`.
 * Two sibling parts (DOC_1 notice header, DOC_2 act body), each an `<a href>`
 * with a `stream_order`.
 */
export const FORMEX_MULTIPART_INDEX_300 = `<html><head><title>300 Multiple-Choice Response</title></head><body> List of URI's:<ul><li title="manifestation">cellar:3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02<ul><li title="item"><a href="http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02/DOC_1"><span class="stream_page_physical_first"></span>&amp;nbsp;-&amp;nbsp;<span class="stream_page_physical_last"></span>&amp;nbsp;<span class="url">(http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02/DOC_1)</span></a><ul><li title="stream_name">L_2016119EN.01000101.doc.xml</li><li title="stream_label">oj_JOL_2016_119_R_20160503101609085_notice_formex.ingest_2016-05-04T000624208_immc.xml_amd-107_1462341705007.rdf</li><li title="stream_order" id="streamOrder">1</li></ul></li><li title="item"><a href="http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02/DOC_2"><span class="stream_page_physical_first"></span>&amp;nbsp;-&amp;nbsp;<span class="stream_page_physical_last"></span>&amp;nbsp;<span class="url">(http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02/DOC_2)</span></a><ul><li title="stream_name">L_2016119EN.01000101.xml</li><li title="stream_label">oj_JOL_2016_119_R_20160503101609085_notice_formex.ingest_2016-05-04T000624208_immc.xml_amd-107_1462341705007.rdf</li><li title="stream_order" id="streamOrder">2</li></ul></li></ul></li></ul></body></html>`;

/** Absolute part URLs referenced by {@link FORMEX_MULTIPART_INDEX_300}. */
export const FORMEX_PART_URL_DOC_1 =
  'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02/DOC_1';
export const FORMEX_PART_URL_DOC_2 =
  'http://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.02/DOC_2';

/**
 * DOC_1 (stream order 1) — the verbatim live notice header. A `<DOC>` root
 * carrying `<BIB.DOC>` plus the title; no enacting terms. This is the "small
 * header" the single-part fetch used to return on its own.
 */
export const FORMEX_DOC_1 = `<?xml version="1.0" encoding="UTF-8"?>
<DOC xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.55-20141201.xd"><BIB.DOC><PROD.ID>20160425012</PROD.ID><FIN.ID>68895</FIN.ID><NO.DOC FORMAT="YN" TYPE="OJ"><NO.CURRENT>679</NO.CURRENT><YEAR>2016</YEAR><COM>EU</COM></NO.DOC><DURAB TYPE="DUR"/><AUTHOR>PE</AUTHOR><AUTHOR>CS</AUTHOR><EEA/></BIB.DOC><PUBLICATION.REF FILE="L_2016119EN.toc.xml"><COLL>L</COLL><NO.OJ>119</NO.OJ><DATE ISO="20160504">20160504</DATE><LG.OJ>EN</LG.OJ><VOLUME.REF>01</VOLUME.REF></PUBLICATION.REF><FMX><DOC.MAIN.PUB NO.SEQ="0001" SYNOPTISM="D0001"><LG.DOC>EN</LG.DOC><LEGAL.VALUE>REG</LEGAL.VALUE><DATE ISO="20160427">20160427</DATE><PAGE.FIRST>1</PAGE.FIRST><PAGE.LAST>88</PAGE.LAST><PAGE.TOTAL>88</PAGE.TOTAL><PAGE.SEQ>1</PAGE.SEQ><REF.PHYS FILE="L_2016119EN.01000101.xml" TYPE="DOC.XML"/></DOC.MAIN.PUB></FMX><PAPER><VOLUME.PAPER><ITEM.VOLUME REF.NO.SEQ="0001"><TITLE ID.TITLE="T0001"><TI><P>Regulation (EU) 2016/679 of the European Parliament and of the Council of <DATE ISO="20160427">27 April 2016</DATE> on the protection of natural persons with regard to the processing of personal data (General Data Protection Regulation)</P></TI></TITLE><ITEM.REF>1</ITEM.REF></ITEM.VOLUME></VOLUME.PAPER></PAPER></DOC>`;

/**
 * DOC_2 (stream order 2) — the `<ACT>` body. Trimmed from the 418 KB original but
 * structurally faithful: `<BIB.INSTANCE>`, title, a short `<PREAMBLE>`, and
 * `<ENACTING.TERMS>` with a real `<ARTICLE>` (Article 1, verbatim text). This is
 * the content the old code dropped by treating the 300 as unavailable.
 */
export const FORMEX_DOC_2 = `<?xml version="1.0" encoding="UTF-8"?>
<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fmx="http://opoce" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.55-20141201.xd"><BIB.INSTANCE><DOCUMENT.REF FILE="L_2016119EN.01000101.doc.xml"><COLL>L</COLL><NO.OJ>119</NO.OJ><YEAR>2016</YEAR><LG.OJ>EN</LG.OJ></DOCUMENT.REF><EEA/><DATE ISO="20160427">20160427</DATE><LG.DOC>EN</LG.DOC><NO.SEQ>0001</NO.SEQ><NO.DOC FORMAT="YN" TYPE="OJ"><NO.CURRENT>679</NO.CURRENT><YEAR>2016</YEAR><COM>EU</COM></NO.DOC></BIB.INSTANCE><TITLE><TI><P><HT TYPE="UC">Regulation</HT> (EU) 2016/679 <HT TYPE="UC">of the European Parliament and of the Council</HT></P><P>on the protection of natural persons with regard to the processing of personal data (General Data Protection Regulation)</P></TI></TITLE><PREAMBLE><PREAMBLE.INIT>THE EUROPEAN PARLIAMENT AND THE COUNCIL OF THE EUROPEAN UNION,</PREAMBLE.INIT><GR.CONSID><CONSID><NP><NO.P>(1)</NO.P><TXT>The protection of natural persons in relation to the processing of personal data is a fundamental right.</TXT></NP></CONSID></GR.CONSID><PREAMBLE.FINAL>HAVE ADOPTED THIS REGULATION:</PREAMBLE.FINAL></PREAMBLE><ENACTING.TERMS><DIVISION><TITLE><TI><P>CHAPTER I</P></TI><STI><P>General provisions</P></STI></TITLE><ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><STI.ART>Subject-matter and objectives</STI.ART><PARAG IDENTIFIER="001.001"><NO.PARAG>1.</NO.PARAG><ALINEA>This Regulation lays down rules relating to the protection of natural persons with regard to the processing of personal data and rules relating to the free movement of personal data.</ALINEA></PARAG></ARTICLE></DIVISION></ENACTING.TERMS><FINAL><P>This Regulation shall be binding in its entirety and directly applicable in all Member States.</P></FINAL></ACT>`;

/**
 * A single-part Formex act body — a standalone `<ACT>` returned with HTTP 200 (no
 * 300). Used to assert the single-part path is unaffected by multi-part assembly.
 */
export const FORMEX_SINGLE_PART_ACT = `<?xml version="1.0" encoding="UTF-8"?>
<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.55-20141201.xd"><BIB.INSTANCE><NO.DOC FORMAT="YN" TYPE="OJ"><NO.CURRENT>2065</NO.CURRENT><YEAR>2019</YEAR><COM>EU</COM></NO.DOC></BIB.INSTANCE><TITLE><TI><P>A single-part regulation served directly as Formex</P></TI></TITLE><ENACTING.TERMS><ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><PARAG><ALINEA>This regulation is served as one Formex stream, not multi-part.</ALINEA></PARAG></ARTICLE></ENACTING.TERMS></ACT>`;
