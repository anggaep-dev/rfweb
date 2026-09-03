import { BinaryReader } from './BinaryReader';

const RECORD_SIZE = 64;
const NAME_SIZE = 32;
// 5x u32 + 2x u16 of reserved fields between the name and the trailing
// offset/size pair. Constant across every entry seen so far - purpose
// unknown, safe to skip for extraction.
const RESERVED_SIZE = RECORD_SIZE - NAME_SIZE - 4 - 4;

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
 * 64-byte records (name + reserved fields + an explicit data offset and
 * size) followed by every entry's raw payload, back to back in table order
 * and uncompressed.
 */
export function parseRfs(buffer: ArrayBuffer): RfsArchive {
  const r = new BinaryReader(buffer);
  const entryCount = r.u32();

  const entries: RfsEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const name = r.fixedString(NAME_SIZE, 'ascii');
    r.seek(RESERVED_SIZE);
    const offset = r.u32();
    const size = r.u32();
    entries.push({ name, offset, size });
  }

  // The header/index table (what we've read so far) can parse fine even if
  // the payload section got cut short - e.g. a truncated or stale-cached
  // fetch response. Catch that here with a clear message instead of a
  // confusing "buffer too small" crash three calls downstream in whatever
  // tries to read the (near-empty) sliced-out entry.
  let maxEnd = 0;
  for (const entry of entries) maxEnd = Math.max(maxEnd, entry.offset + entry.size);
  if (buffer.byteLength < maxEnd) {
    throw new Error(
      `RFS archive looks truncated: its own index expects data up to byte ${maxEnd}, ` +
        `but only ${buffer.byteLength} bytes were actually fetched. Try a hard refresh (the response was likely cut short or served from a stale cache).`,
    );
  }

  return { entries, buffer };
}

/**
 * Looks up one entry by name (case-insensitive, matching the archive's own
 * filenames). Names longer than the 32-byte record slot are truncated in
 * the archive itself (e.g. animation filenames routinely run past that),
 * so the lookup name is truncated the same way before comparing - the
 * truncated prefix is still unique within a given archive in practice.
 */
export function findRfsEntry(archive: RfsArchive, name: string): RfsEntry | null {
  const truncated = name.toUpperCase().slice(0, NAME_SIZE);
  return archive.entries.find((e) => e.name.toUpperCase() === truncated) ?? null;
}

/** Returns the raw bytes for one archive entry. */
export function readRfsEntry(archive: RfsArchive, entry: RfsEntry): ArrayBuffer {
  return archive.buffer.slice(entry.offset, entry.offset + entry.size);
}
