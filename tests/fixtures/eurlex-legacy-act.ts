/**
 * @fileoverview A legacy EUR-Lex `text/html` act body, the representation CELLAR
 * serves for acts with no XHTML manifestation (#16, #120, #126). Mirrors the real
 * page shape of `31995L0046` and its peers: a `<head>` and a `<div id="banner">`
 * legal-notice strip on lines of their own, then the whole act inside
 * `<div id="TexteOnly">` as ONE line of `<p>…</p>` paragraphs, headings included,
 * with `&quot;` for straight quotes. Each chapter heading carries its title on
 * the same line, in capitals (#130). A Finnish variant writes its recitals and
 * last article as that act's Finnish text does (#131). Abridged; NOT live content.
 * @module tests/fixtures/eurlex-legacy-act
 */

/** The act text: every paragraph on one line, as the legacy page writes it. */
const LEGACY_TEXT = [
  '<p>DIRECTIVE 95/46/EC OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</p>',
  '<p>of  24 October 1995</p>',
  '<p></p>',
  '<p> Having regard to the proposal from the Commission (1),</p>',
  '<p> (1) Whereas the objectives of the Community include creating an ever closer union;</p>',
  '<p> (2) Whereas data-processing systems are designed to serve man;</p>',
  '<p> HAVE ADOPTED THIS DIRECTIVE:</p>',
  '<p></p>',
  '<p>CHAPTER I GENERAL PROVISIONS </p>',
  '<p></p>',
  '<p>Article 1 </p>',
  '<p>Object of the Directive</p>',
  '<p>1. Member States shall protect the fundamental rights and freedoms of natural persons.</p>',
  '<p>Article 2 </p>',
  '<p>Definitions</p>',
  '<p>For the purposes of this Directive:</p>',
  '<p> (a) &quot;personal data&quot; shall mean any information relating to a natural person;</p>',
  '<p> SECTION I</p>',
  '<p>PRINCIPLES RELATING TO DATA QUALITY</p>',
  '<p></p>',
  '<p>Article 6 </p>',
  '<p>&quot;Mere conduit&quot;</p>',
  '<p>1. Member States shall provide that personal data must be processed fairly.</p>',
  '<p></p>',
  '<p>ANNEX</p>',
  '<p> For the purposes of Article 2 (a): the expression &quot;specialist&quot; indicates a qualification.</p>',
].join('');

/** A legacy page: template lines, the banner, the title block, and the one-line act text. */
export const LEGACY_ACT_HTML = [
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html lang="EN">',
  '<head>',
  '<meta name="DC.language" content="EN">',
  '<style type="text/css" media="all">  @import url(lex/css/lex-screen.css); </style>',
  '<link rel="stylesheet" type="text/css" media="print" href="lex/css/lex-print.css">',
  '<title>EUR-Lex - 31995L0046 - EN</title>',
  '</head>',
  '<body>',
  '<div id="banner">',
  '<a name="top"></a>',
  '<div class="bglang">',
  '<p class="bglang">',
  '<a class="langue" href="../../../editorial/legal_notice.htm" accesskey="8"><b>Avis juridique important</b></a>',
  '<br>',
  '</p>',
  '</div>',
  '<div class="bgtool">',
  '<em class="none">|</em>',
  '</div>',
  '</div>',
  '<a name="top"></a>',
  '<h1>31995L0046</h1>',
  '<p>',
  '<strong>Directive 95/46/EC of the European Parliament and of the Council of 24 October 1995 on the protection of individuals with regard to the processing of personal data  </strong>',
  '<br>',
  '<em>',
  '<br>Official Journal L 281 , 23/11/1995 P. 0031 - 0050<br> </em>',
  '</p>',
  '<br>',
  '<div id="TexteOnly">',
  '<p>',
  '<TXT_TE>',
  LEGACY_TEXT,
  '</TXT_TE>',
  '</p>',
  '</div>',
  '</body>',
  '</html>',
].join('\n');

/**
 * The legacy page in Finnish (#131), its text as `31995L0046` writes it in that
 * language: recitals numbered `1)` with no opening parenthesis, as the Swedish
 * body numbers them too, and the last article headed `34 artiklan`, its keyword
 * in the genitive. Article 33 carries a `1)` sub-point, which is not a recital.
 */
export const LEGACY_FINNISH_ACT_HTML = LEGACY_ACT_HTML.replace(
  LEGACY_TEXT,
  [
    '<p>EUROOPAN PARLAMENTIN JA NEUVOSTON DIREKTIIVI 95/46/EY annettu 24 päivänä lokakuuta 1995,</p>',
    '<p>ottavat huomioon komission ehdotuksen (1),</p>',
    '<p>sekä katsovat, että</p>',
    '<p>1) perustamissopimuksessa esitettyjen yhteisön tavoitteiden mukaisesti toteutetaan Euroopan kansojen yhä läheisempi liitto,</p>',
    '<p>2) tietojenkäsittelyjärjestelmät on tehty palvelemaan ihmistä,</p>',
    '<p>OVAT ANTANEET TÄMÄN DIREKTIIVIN:</p>',
    '<p></p>',
    '<p>I LUKU YLEISET SÄÄNNÖKSET </p>',
    '<p></p>',
    '<p>1 artikla </p>',
    '<p>Direktiivin tavoite</p>',
    '<p>1. Jäsenvaltioiden on turvattava yksilöille heidän oikeutensa yksityisyyteen.</p>',
    '<p>33 artikla </p>',
    '<p>Komissio antaa neuvostolle ja Euroopan parlamentille kertomuksen tämän direktiivin soveltamisesta:</p>',
    '<p>1) ensimmäisen kerran enintään kolme vuotta 32 artiklan 1 kohdassa tarkoitetun päivämäärän jälkeen.</p>',
    '<p></p>',
    '<p>34 artiklan </p>',
    '<p>Tämä direktiivi on osoitettu kaikille jäsenvaltioille.</p>',
    '<p></p>',
    '<p>Tehty Luxemburgissa 24 päivänä lokakuuta 1995.</p>',
  ].join(''),
);

/**
 * The legacy page with a second chapter before the annex (#130), headed as
 * `31995L0046` heads each of its seven. Chapter I gains two prose
 * cross-references, and Chapter II a paragraph opening with a mixed-case chapter
 * line; none is a heading.
 */
export const LEGACY_TWO_CHAPTER_ACT_HTML = LEGACY_ACT_HTML.replace(
  '<p></p><p>ANNEX</p>',
  [
    '<p>2. Chapter IV on the transfer of personal data to third countries shall also apply.</p>',
    '<p>Chapter IV on the transfer of personal data to third countries shall apply.</p>',
    '<p></p>',
    '<p>CHAPTER II GENERAL RULES ON THE LAWFULNESS OF THE PROCESSING OF PERSONAL DATA </p>',
    '<p></p>',
    '<p>Article 7 </p>',
    '<p>Member States shall provide that personal data may be processed only if the data subject has consented.</p>',
    '<p>CHAPTER III Judicial remedies</p>',
    '<p></p>',
    '<p>ANNEX</p>',
  ].join(''),
);
