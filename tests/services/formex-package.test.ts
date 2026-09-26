/**
 * @fileoverview Tests for the zipped Formex 4 package reader (#108): manifest-
 * ordered parts from stored and deflated entries, data descriptors, both package
 * namings, and the untrusted-input cases — traversal and duplicate names, lying
 * or oversize declared sizes, a failed CRC, unsupported methods, encryption, a
 * missing part, a truncated or corrupted archive — each read as no package, never
 * a throw.
 * Archives are built byte by byte in `tests/fixtures/formex-zip.ts`.
 * @module tests/services/formex-package.test
 */

import { describe, expect, it } from 'vitest';
import {
  FORMEX_PACKAGE_MAX_BYTES,
  readFormexPackage,
} from '@/services/eurlex-content/formex-package.js';
import {
  actByActPackage,
  buildZip,
  LEGACY_PACKAGE_MANIFEST,
  PACKAGE_ACT,
  PACKAGE_ANNEX,
  PACKAGE_MANIFEST,
  type ZipFixtureEntry,
} from '../fixtures/formex-zip.js';

const MANIFEST = 'L_202401689EN.doc.fmx.xml';
const ACT = 'L_202401689EN.000101.fmx.xml';
const ANNEX = 'L_202401689EN.012401.fmx.xml';

/** Set a 16-bit field of the `index`th central directory header. */
function patchCentral(zip: Uint8Array, index: number, field: number, value: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let at = view.getUint32(zip.length - 22 + 16, true);
  for (let n = 0; n < index; n++) {
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true);
  }
  view.setUint16(at + field, value, true);
  return zip;
}

/** Index of the first occurrence of `text`'s UTF-8 bytes in `bytes`. */
function indexOfBytes(bytes: Uint8Array, text: string): number {
  return Buffer.from(bytes).indexOf(text);
}

/**
 * Each entry's name and the span of its data, walked through the local headers
 * from the start of an archive built without data descriptors.
 */
function localEntries(zip: Uint8Array): { end: number; name: string; start: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: { end: number; name: string; start: number }[] = [];
  for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
    const nameEnd = at + 30 + view.getUint16(at + 26, true);
    const start = nameEnd + view.getUint16(at + 28, true);
    const end = start + view.getUint32(at + 18, true);
    entries.push({ name: new TextDecoder().decode(zip.subarray(at + 30, nameEnd)), start, end });
    at = end;
  }
  return entries;
}

/** A manifest naming the given files, in order. */
function manifestNaming(...files: string[]): string {
  const refs = files.map((file) => `<REF.PHYS FILE="${file}" TYPE="DOC.XML"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<DOC><FMX>${refs}</FMX></DOC>`;
}

describe('readFormexPackage', () => {
  it('returns the manifest, then each part it names, whatever the entry order', () => {
    const [toc, manifest, act, annex] = actByActPackage();
    const parts = readFormexPackage(buildZip([annex!, toc!, act!, manifest!]));

    expect(parts).toEqual([PACKAGE_MANIFEST, PACKAGE_ACT, PACKAGE_ANNEX]);
  });

  it('reads stored and deflated entries alike', () => {
    const parts = readFormexPackage(
      buildZip(
        actByActPackage({
          [ACT]: { name: ACT, content: PACKAGE_ACT, method: 'stored' },
          [MANIFEST]: { name: MANIFEST, content: PACKAGE_MANIFEST, method: 'stored' },
        }),
      ),
    );

    expect(parts).toEqual([PACKAGE_MANIFEST, PACKAGE_ACT, PACKAGE_ANNEX]);
  });

  it('reads entries whose sizes follow the data in a descriptor', () => {
    const entries = actByActPackage().map((entry) => ({ ...entry, dataDescriptor: true }));

    expect(readFormexPackage(buildZip(entries))).toEqual([
      PACKAGE_MANIFEST,
      PACKAGE_ACT,
      PACKAGE_ANNEX,
    ]);
  });

  it('reads the older *.doc.xml manifest naming', () => {
    const parts = readFormexPackage(
      buildZip([
        { name: 'L_2022277EN.01000101.xml', content: PACKAGE_ACT },
        { name: 'L_2022277EN.01000101.doc.xml', content: LEGACY_PACKAGE_MANIFEST },
      ]),
    );

    expect(parts).toEqual([LEGACY_PACKAGE_MANIFEST, PACKAGE_ACT]);
  });

  it('decodes UTF-8 part text', () => {
    const greek = '<?xml version="1.0" encoding="UTF-8"?>\n<ACT><TI.ART>Άρθρο 1</TI.ART></ACT>';
    const parts = readFormexPackage(
      buildZip([
        { name: 'a.doc.fmx.xml', content: manifestNaming('a.1.fmx.xml') },
        { name: 'a.1.fmx.xml', content: greek },
      ]),
    );

    expect(parts?.[1]).toBe(greek);
  });

  describe('reads as no package', () => {
    it.each<[string, ZipFixtureEntry[]]>([
      ['no manifest', actByActPackage({ [MANIFEST]: { name: 'readme.txt', content: 'x' } })],
      [
        'two manifests',
        [...actByActPackage(), { name: 'L_202401689EN.2.doc.xml', content: PACKAGE_MANIFEST }],
      ],
      ['a manifest naming no part', [{ name: MANIFEST, content: '<DOC><FMX/></DOC>' }]],
      [
        'a manifest naming a part the archive lacks',
        actByActPackage({ [ANNEX]: { name: 'L_202401689EN.099901.fmx.xml', content: 'x' } }),
      ],
      [
        'a declared uncompressed total over the cap',
        actByActPackage({
          [ANNEX]: { name: ANNEX, content: PACKAGE_ANNEX, declaredSize: FORMEX_PACKAGE_MAX_BYTES },
        }),
      ],
      [
        'a deflated entry that inflates past its declared size',
        actByActPackage({ [ACT]: { name: ACT, content: PACKAGE_ACT, declaredSize: 10 } }),
      ],
      [
        'a deflated entry that inflates short of its declared size',
        actByActPackage({
          [ACT]: { name: ACT, content: PACKAGE_ACT, declaredSize: PACKAGE_ACT.length + 1 },
        }),
      ],
      [
        'a stored entry whose declared size differs from its data',
        actByActPackage({
          [ACT]: { name: ACT, content: PACKAGE_ACT, method: 'stored', declaredSize: 12 },
        }),
      ],
      [
        'a stored entry whose data fails its CRC',
        actByActPackage({
          [ACT]: { name: ACT, content: PACKAGE_ACT, method: 'stored', declaredCrc: 0x1234_5678 },
        }),
      ],
      [
        'a deflated entry that inflates to its declared size but fails its CRC',
        actByActPackage({ [ACT]: { name: ACT, content: PACKAGE_ACT, declaredCrc: 0x1234_5678 } }),
      ],
      ['a duplicate entry name', [...actByActPackage(), { name: ACT, content: PACKAGE_ANNEX }]],
      ...[
        '../evil.xml',
        '/etc/evil.xml',
        'a\\..\\evil.xml',
        'C:/evil.xml',
        'parts/../../evil.xml',
      ].map((name): [string, ZipFixtureEntry[]] => [
        `a traversal name (${name})`,
        [...actByActPackage(), { name, content: 'x' }],
      ]),
    ])('%s', (_case, entries) => {
      expect(readFormexPackage(buildZip(entries))).toBeNull();
    });

    it('a traversal name in the manifest alone', () => {
      const zip = buildZip([
        { name: MANIFEST, content: manifestNaming('../L_202401689EN.000101.fmx.xml') },
        { name: ACT, content: PACKAGE_ACT },
      ]);

      expect(readFormexPackage(zip)).toBeNull();
    });

    it('a part named repeatedly until the parts read would inflate past the cap', () => {
      const size = 12 * 1024 * 1024;
      const zip = buildZip([
        { name: MANIFEST, content: manifestNaming(ACT, ACT, ACT) },
        { name: ACT, content: new Uint8Array(size) },
      ]);

      expect(readFormexPackage(zip)).toBeNull();
      expect(
        readFormexPackage(
          buildZip([
            { name: MANIFEST, content: manifestNaming(ACT, ACT) },
            { name: ACT, content: new Uint8Array(size) },
          ]),
        )?.[1]?.length,
      ).toBe(size);
    });

    it('an unsupported compression method or an encrypted entry', () => {
      const method = patchCentral(buildZip(actByActPackage()), 2, 10, 12);
      const encrypted = patchCentral(buildZip(actByActPackage()), 2, 8, 0x0801);

      expect(readFormexPackage(method)).toBeNull();
      expect(readFormexPackage(encrypted)).toBeNull();
    });

    it('bytes that are not a zip, or none at all', () => {
      const text = new TextEncoder().encode(`<html>${'x'.repeat(500)}</html>`);

      expect(readFormexPackage(text)).toBeNull();
      expect(readFormexPackage(new Uint8Array(0))).toBeNull();
      expect(readFormexPackage(new Uint8Array(21))).toBeNull();
    });
  });

  it('reads an archive cut short at any length as no package, never a throw', () => {
    const zip = buildZip(actByActPackage());

    for (let length = 0; length < zip.length; length++) {
      expect(readFormexPackage(zip.subarray(0, length))).toBeNull();
    }
    expect(readFormexPackage(zip)).not.toBeNull();
  });

  it('reads a stored entry with one data byte flipped as no package', () => {
    const act = '<ACT>hello world</ACT>';
    const zip = buildZip([
      { name: MANIFEST, content: manifestNaming(ACT), method: 'stored' },
      { name: ACT, content: act, method: 'stored' },
    ]);
    const corrupted = zip.slice();
    const at = indexOfBytes(zip, act);
    corrupted[at + 5] = 'j'.charCodeAt(0);

    expect(readFormexPackage(zip)?.[1]).toBe(act);
    expect(readFormexPackage(corrupted)).toBeNull();
  });

  it('reads an archive with any one byte corrupted as the same parts or no package, never a throw', () => {
    const zip = buildZip(actByActPackage());
    const parts = readFormexPackage(zip);
    const read = new Set([MANIFEST, ACT, ANNEX]);
    const dataOfReadParts = localEntries(zip).filter((entry) => read.has(entry.name));
    expect(dataOfReadParts).toHaveLength(3);

    for (let at = 0; at < zip.length; at++) {
      const corrupted = zip.slice();
      corrupted[at] = (corrupted[at] ?? 0) ^ 0xff;
      const result = readFormexPackage(corrupted);
      if (dataOfReadParts.some((entry) => at >= entry.start && at < entry.end)) {
        expect(result, `byte ${at}, inside a read part's data`).toBeNull();
      } else if (result !== null) {
        expect(result, `byte ${at}`).toEqual(parts);
      }
    }
  });

  it('reads a manifest of unclosed REF.PHYS openers in one pass', () => {
    const manifest = `<DOC>${'<REF.PHYS FILE="x'.repeat(200_000)}</DOC>`;
    const started = performance.now();

    expect(readFormexPackage(buildZip([{ name: MANIFEST, content: manifest }]))).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
