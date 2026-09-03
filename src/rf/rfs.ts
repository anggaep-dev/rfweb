import { BinaryReader } from './BinaryReader';

const RECORD_SIZE = 64;
const NAME_SIZE = 32;
// 5x u32 + 2x u16 of reserved fields between the name and the data offset.
// Constant across every entry in the sample archives seen so far (mesh
// packs) - purpose unknown, safe to skip for extraction.
const RESERVED_SIZE = RECORD_SIZE - NAME_SIZE - 4;

export interface RfsEntry {
  name: string;
  /** Byte offset into the archive buffer where this entry's raw data begins. */
  offset: number;
  /** Byte length of this entry's raw data. */
  size: number;
}

export interface RfsArchive {
  entries: RfsEntry[];
  buffer: ArrayBuffer;
}

/**
 * Parses an unpacked ".RFS" resource archive: a flat table of fixed
 * 64-byte records (name + reserved fields + a data offset) followed by
 * every entry's raw payload, back to back in table order and
 * uncompressed. An entry's size isn't stored directly - it's the gap
 * between its offset and the next entry's (or EOF for the last entry).
 */
export function parseRfs(buffer: ArrayBuffer): RfsArchive {
  const r = new BinaryReader(buffer);
  const entryCount = r.u32();

  const names: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < entryCount; i++) {
    names.push(r.fixedString(NAME_SIZE, 'ascii'));
    r.seek(RESERVED_SIZE);
    offsets.push(r.u32());
  }

  const entries: RfsEntry[] = names.map((name, i) => {
    const offset = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.byteLength;
    return { name, offset, size: end - offset };
  });

  return { entries, buffer };
}

/** Looks up one entry by name (case-insensitive, matching the archive's own filenames). */
export function findRfsEntry(archive: RfsArchive, name: string): RfsEntry | null {
  const upper = name.toUpperCase();
  return archive.entries.find((e) => e.name.toUpperCase() === upper) ?? null;
}

/** Returns the raw bytes for one archive entry. */
export function readRfsEntry(archive: RfsArchive, entry: RfsEntry): ArrayBuffer {
  return archive.buffer.slice(entry.offset, entry.offset + entry.size);
}
