/**
 * @fileoverview Byte-level zip builder for the zipped Formex 4 package tests
 * (#108). Writes local headers, entry data (stored or deflated, optionally with
 * a data descriptor), the central directory, and the end record, so a test can
 * shape each field a hostile or unusual archive might carry: a declared size
 * or CRC that lies, a traversal name, entries out of manifest order, a cut-off
 * tail.
 * Also holds small Formex package parts mirroring the real CELLAR package
 * shapes (`L_…EN.doc.fmx.xml` manifest plus `.NNNNNN.fmx.xml` parts, and the
 * older `.doc.xml` naming).
 * @module tests/fixtures/formex-zip
 */

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  content: string | Uint8Array;
  /** Write sizes and CRC after the data (general-purpose flag bit 3), zeroed in the local header. */
  dataDescriptor?: boolean;
  /** CRC-32 the headers claim, when it should differ from the real one. */
  declaredCrc?: number;
  /** Uncompressed size the central directory claims, when it should differ from the real one. */
  declaredSize?: number;
  method?: 'stored' | 'deflated';
  name: string;
}

/** Build a zip archive from entries, in the given order. */
export function buildZip(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const deflated = entry.method !== 'stored';
    const payload = deflated ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = entry.declaredCrc ?? crc32(data);
    const size = entry.declaredSize ?? data.length;
    const flags = (entry.dataDescriptor ? 0x0008 : 0) | 0x0800;
    const method = deflated ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, entry.dataDescriptor ? 0 : crc, true);
    local.setUint32(18, entry.dataDescriptor ? 0 : payload.length, true);
    local.setUint32(22, entry.dataDescriptor ? 0 : size, true);
    local.setUint16(26, name.length, true);
    const parts = [new Uint8Array(local.buffer), name, payload];
    if (entry.dataDescriptor) {
      const descriptor = new DataView(new ArrayBuffer(16));
      descriptor.setUint32(0, 0x08074b50, true);
      descriptor.setUint32(4, crc, true);
      descriptor.setUint32(8, payload.length, true);
      descriptor.setUint32(12, size, true);
      parts.push(new Uint8Array(descriptor.buffer));
    }

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, flags, true);
    header.setUint16(10, method, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, payload.length, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);

    for (const part of parts) {
      chunks.push(part);
      offset += part.length;
    }
  }

  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** OJ-issue table of contents: a `<PUBLICATION>` root no `REF.PHYS` names. */
export const PACKAGE_TOC = `<?xml version="1.0" encoding="UTF-8"?>
<PUBLICATION><COLL>L</COLL><NO.OJ>1689</NO.OJ><DATE ISO="20240712">20240712</DATE></PUBLICATION>`;

/**
 * Act-by-act manifest (`*.doc.fmx.xml`): a `<DOC>` notice naming the act, then an
 * annex, by `REF.PHYS FILE` — the order assembly follows.
 */
export const PACKAGE_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<DOC><BIB.DOC><NO.DOC FORMAT="YN" TYPE="OJ"><NO.CURRENT>1689</NO.CURRENT><YEAR>2024</YEAR></NO.DOC></BIB.DOC><PUBLICATION.REF FILE="L_202401689EN.toc.fmx.xml"><COLL>L</COLL></PUBLICATION.REF><FMX><DOC.MAIN.PUB NO.SEQ="0001"><LG.DOC>EN</LG.DOC><REF.PHYS FILE="L_202401689EN.000101.fmx.xml" TYPE="DOC.XML"/></DOC.MAIN.PUB><DOC.SUB.PUB NO.SEQ="0002" TYPE="ANNEX"><REF.PHYS FILE="L_202401689EN.012401.fmx.xml" TYPE="DOC.XML"/></DOC.SUB.PUB></FMX></DOC>`;

/** The act body part: a chapter holding two articles. */
export const PACKAGE_ACT = `<?xml version="1.0" encoding="UTF-8"?>
<ACT><ENACTING.TERMS><DIVISION><TITLE><TI><P>CHAPTER I</P></TI><STI><P>GENERAL PROVISIONS</P></STI></TITLE><ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><STI.ART><P>Subject matter</P></STI.ART><PARAG><ALINEA>This Regulation lays down harmonised rules for the placing on the market of artificial intelligence systems.</ALINEA></PARAG></ARTICLE><ARTICLE IDENTIFIER="002"><TI.ART>Article 2</TI.ART><STI.ART><P>Scope</P></STI.ART><PARAG><ALINEA>This Regulation applies to providers placing AI systems on the market.</ALINEA></PARAG></ARTICLE></DIVISION></ENACTING.TERMS></ACT>`;

/** An annex part. */
export const PACKAGE_ANNEX = `<?xml version="1.0" encoding="UTF-8"?>
<ANNEX><TITLE><TI><P>ANNEX I</P></TI><STI><P>List of Union harmonisation legislation</P></STI></TITLE><CONTENTS><P>Directive 2006/42/EC of the European Parliament and of the Council on machinery.</P></CONTENTS></ANNEX>`;

/** The act-by-act package as CELLAR stores it: toc, manifest, act, annex. */
export function actByActPackage(overrides: Partial<Record<string, ZipFixtureEntry>> = {}) {
  const entries: ZipFixtureEntry[] = [
    { name: 'L_202401689EN.toc.fmx.xml', content: PACKAGE_TOC },
    { name: 'L_202401689EN.doc.fmx.xml', content: PACKAGE_MANIFEST },
    { name: 'L_202401689EN.000101.fmx.xml', content: PACKAGE_ACT },
    { name: 'L_202401689EN.012401.fmx.xml', content: PACKAGE_ANNEX },
  ];
  return entries.map((entry) => overrides[entry.name] ?? entry);
}

/** Older package naming (`*.doc.xml` manifest, no toc), as `32016R0679` and `32022R2065` ship. */
export const LEGACY_PACKAGE_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<DOC><BIB.DOC><NO.DOC FORMAT="YN" TYPE="OJ"><NO.CURRENT>2065</NO.CURRENT><YEAR>2022</YEAR></NO.DOC></BIB.DOC><FMX><DOC.MAIN.PUB NO.SEQ="0001"><REF.PHYS FILE="L_2022277EN.01000101.xml" TYPE="DOC.XML"/></DOC.MAIN.PUB></FMX></DOC>`;
