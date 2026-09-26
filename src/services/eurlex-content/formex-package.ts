/**
 * @fileoverview Reader for the zipped Formex 4 package CELLAR serves under
 * `Accept: application/zip;mtype=fmx4` (#108) — the only Formex form of acts
 * whose `application/xml;type=fmx4` variant answers 404.
 *
 * The package holds a `<DOC>` manifest (`*.doc.fmx.xml`, or `*.doc.xml` in
 * older packages) whose `<REF.PHYS FILE>` elements name the act and its annexes
 * in publication order, plus, in act-by-act packages, an OJ-issue table of
 * contents no `REF.PHYS` names. Parts are returned in manifest order: the
 * archive's entry order is not publication order.
 *
 * The archive is untrusted input, read with a central-directory reader over
 * `node:zlib` so the same code runs on Bun and Node. Anything malformed or
 * unsafe — no end record, a truncated or overlapping layout, an encrypted
 * entry, a method other than stored or deflated, a duplicate or path-traversal
 * name, a declared size over {@link FORMEX_PACKAGE_MAX_BYTES}, an entry that
 * inflates to anything but its declared size, or one whose bytes fail its
 * CRC-32 — reads as no package, never a throw. Inflation is bounded by each
 * entry's declared size and stops there, so a lying central directory cannot
 * inflate past the cap.
 * @module services/eurlex-content/formex-package
 */

import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Most bytes a package may declare across its entries, and most its read parts
 * may inflate to. The largest acts' Formex runs to a few megabytes.
 */
export const FORMEX_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;

const END_RECORD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_ARCHIVE_COMMENT = 0xffff;

const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED_FLAG = 0x0001;

/** The manifest entry: a `<DOC>` notice naming the parts. */
const MANIFEST_NAME = /\.doc(?:\.fmx)?\.xml$/i;

interface ZipEntry {
  compressedSize: number;
  /** CRC-32 of the uncompressed bytes, from the central directory. */
  crc: number;
  localOffset: number;
  method: number;
  size: number;
}

const decoder = new TextDecoder();

/** True for a relative name with no `..` segment, backslash, drive, or NUL. */
function isSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    !/[\\\0]/.test(name) &&
    !name.startsWith('/') &&
    !/^[a-z]:/i.test(name) &&
    !name.split('/').includes('..')
  );
}

/**
 * Index the archive by entry name from its central directory. Null when the end
 * record is missing, the directory runs outside the archive, an entry is
 * encrypted or unsafely named, a name repeats, or the declared sizes total more
 * than {@link FORMEX_PACKAGE_MAX_BYTES}.
 */
function readDirectory(bytes: Uint8Array, view: DataView): Map<string, ZipEntry> | null {
  let end = -1;
  const floor = Math.max(0, bytes.length - END_RECORD_SIZE - MAX_ARCHIVE_COMMENT);
  for (let at = bytes.length - END_RECORD_SIZE; at >= floor; at--) {
    if (view.getUint32(at, true) === END_RECORD) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (at + view.getUint32(end + 12, true) > end) return null;

  const entries = new Map<string, ZipEntry>();
  let declared = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_HEADER) return null;
    const nameEnd = at + 46 + view.getUint16(at + 28, true);
    if (nameEnd > end) return null;
    const name = decoder.decode(bytes.subarray(at + 46, nameEnd));
    const size = view.getUint32(at + 24, true);
    declared += size;
    if (
      declared > FORMEX_PACKAGE_MAX_BYTES ||
      (view.getUint16(at + 8, true) & ENCRYPTED_FLAG) !== 0 ||
      !isSafeName(name) ||
      entries.has(name)
    ) {
      return null;
    }
    entries.set(name, {
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size,
      localOffset: view.getUint32(at + 42, true),
    });
    at = nameEnd + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

/**
 * An entry's bytes, located through its local header (whose extra field may
 * differ from the central one; a data descriptor after the data changes
 * nothing, since sizes and CRC come from the central directory). Null when the
 * data runs past the archive, the method is unsupported, the output is not
 * exactly the declared size — inflation stops at that size — or its CRC-32 is
 * not the declared one.
 */
function readEntry(bytes: Uint8Array, view: DataView, entry: ZipEntry): Uint8Array | null {
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_HEADER) return null;
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (start + entry.compressedSize > bytes.length) return null;
  const data = bytes.subarray(start, start + entry.compressedSize);
  const output =
    entry.method === STORED ? data : entry.method === DEFLATED ? inflate(data, entry.size) : null;
  return output?.length === entry.size && crc32(output) === entry.crc ? output : null;
}

/** A raw deflate stream inflated to at most `size` bytes, or null when it will not inflate. */
function inflate(data: Uint8Array, size: number): Uint8Array | null {
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, size) });
  } catch {
    return null;
  }
}

/**
 * Read a zipped Formex package into its parts, in manifest order: the `<DOC>`
 * manifest first, then each file its `<REF.PHYS FILE>` elements name. Null when
 * the bytes are not a readable archive, it holds no single manifest, the manifest
 * names no file, a named file is absent or unreadable, or the parts read would
 * inflate past {@link FORMEX_PACKAGE_MAX_BYTES} in all.
 */
export function readFormexPackage(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readDirectory(bytes, view);
  if (!entries) return null;

  const manifests = [...entries.keys()].filter((name) => MANIFEST_NAME.test(name));
  if (manifests.length !== 1) return null;
  const manifestName = manifests[0] as string;

  let inflated = 0;
  const read = (name: string): string | null => {
    const entry = entries.get(name);
    if (!entry || inflated + entry.size > FORMEX_PACKAGE_MAX_BYTES) return null;
    const data = readEntry(bytes, view, entry);
    if (!data) return null;
    inflated += data.length;
    return decoder.decode(data);
  };

  const manifest = read(manifestName);
  if (manifest === null) return null;

  // Tags are matched as `<[^<>]*>`, so a run of unclosed openers costs one pass (#94).
  const files: string[] = [];
  for (const tag of manifest.matchAll(/<REF\.PHYS\b([^<>]*)>/g)) {
    const file = /\bFILE="([^"]*)"/.exec(tag[1] ?? '')?.[1];
    if (file) files.push(file);
  }
  if (files.length === 0) return null;

  const parts = [manifest];
  for (const file of files) {
    const part = read(file);
    if (part === null) return null;
    parts.push(part);
  }
  return parts;
}
