#!/usr/bin/env node
/**
 * Extracts particle-relevant content packed inside Chef/ChefEntityN.rpk
 * archives into loose files under public/game-assets/Chef/, mirroring
 * the same "already-unpacked to loose files" convention every other
 * Chef/ asset in this project uses.
 *
 * Why this exists: many equipped items' real .eff particle data resolves
 * (via Chef/Particle.ini) to a .spt path that was never extracted as a
 * loose file - it exists only packed inside one of the 17 ChefEntityN.rpk
 * archives, alongside its own entity.r3e/.r3m/.r3t mesh+material payload.
 * This project's runtime only ever fetches loose files over HTTP, so any
 * particle whose data is rpk-only silently 404s and never renders -
 * confirmed on real data: of the 938 distinct particle ids referenced by
 * every real .eff file in this project, only 171 already had a loose
 * .spt file; 767 were rpk-only.
 *
 * .rpk format (see docs/rf-format-notes.md's own ".rpk archive" section
 * for the full header layout): this script only needs two things from
 * it beyond that header - real byte size isn't reliably read from an
 * entry's own `size` field (negative on every .r3t entry seen, "infer
 * from next sibling" per that doc note, never fully pinned down) so
 * instead each file's byte length is computed as the difference between
 * its own `offsets[i]` and the very next entry's `offsets[i+1]` (both
 * arrays are stored parallel-by-index, monotonically increasing in
 * packing order regardless of file/folder type) - verified byte-exact
 * against a real entry's own correct declared size (208, matching
 * exactly) before trusting this for extraction.
 *
 * Casing: rpk entry names are stored in ALL LOWERCASE ("belmale_a_cloak",
 * "417p", "aura.r3e") - but this project's Vite dev server has a known
 * case-sensitivity bug (a mis-cased Chef/ request 200s with the SPA's own
 * index.html instead of a real 404 - see docs/rf-format-notes.md's "known
 * bugs" section), so files here are NOT written using the rpk's own
 * lowercase names. Instead, each file is written using whatever casing
 * the rest of the pipeline will actually request it with: a .spt's own
 * path comes from Particle.ini's real casing, and its entity.r3e/.r3m/
 * .r3t sibling's path comes from parsing that same .spt's own
 * "entity_file" line (real files use mixed case there, e.g.
 * ".\Chef\Unick_up\C_W_TSWORD\400p\aura.R3E") - never from the rpk index
 * itself, which is casing-normalized and not authoritative.
 *
 * Usage: node scripts/extract_rpk.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CHEF_DIR = path.join(REPO_ROOT, 'public', 'game-assets', 'Chef');
const DRY_RUN = process.argv.includes('--dry-run');

function decodeName(buf) {
  let end = 0;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.subarray(0, end).toString('latin1');
}

/** Parses one .rpk archive's full directory listing + byte ranges. */
function parseRpk(rpkPath) {
  const buf = fs.readFileSync(rpkPath);
  let offset = 0;
  offset += 4; // version (f32, always 1.0 in every file checked)
  const fileAmount = buf.readUInt32LE(offset); offset += 4;
  offset += 4 * fileAmount; // offsetIndices - unused for a flat listing
  const offsets = [];
  for (let i = 0; i < fileAmount; i++) {
    offsets.push(buf.readInt32LE(offset));
    offset += 4;
  }

  const rawEntries = [];
  for (let i = 0; i < fileAmount; i++) {
    const name = decodeName(buf.subarray(offset, offset + 52));
    offset += 52;
    const size = buf.readInt32LE(offset); offset += 4;
    offset += 2; // reserved
    const childCount = buf.readUInt16LE(offset); offset += 2;
    offset += 4; // offsetIndicesIndex - unused for a flat listing
    rawEntries.push({ name, size, childCount });
  }
  const dataStart = offset;

  const entries = [];
  let cursor = 0;
  function walk(prefix, count) {
    for (let i = 0; i < count && cursor < rawEntries.length; i++) {
      const index = cursor;
      const e = rawEntries[index];
      cursor++;
      const isFolder = !/\.[A-Za-z0-9]+$/.test(e.name);
      // The very first entry in every real archive is a literal "."/".\"
      // root marker, not a real path segment - it must contribute nothing
      // to its children's paths (an earlier investigation script embedded
      // it literally, producing phantom ".\/"-prefixed paths that never
      // match a normal lookup).
      const isRootMarker = /^\.[\\/]?$/.test(e.name);
      const lowerPath = isRootMarker ? '' : prefix ? `${prefix}/${e.name}` : e.name;
      if (!isRootMarker) entries.push({ index, lowerPath: lowerPath.toLowerCase(), folder: isFolder });
      if (isFolder) walk(lowerPath, e.childCount);
    }
  }
  walk('', rawEntries.length);

  return { buf, dataStart, offsets, rawEntries, entries };
}

/**
 * The byte offset where the next real file's content starts, scanning
 * forward from `fromIndex` (inclusive). A FILE entry's own `offsets[i]`
 * is this directly. A FOLDER entry's `offsets[i]` is always the sentinel
 * -1 (folders have no payload of their own) - its `size` field looked
 * like it might double-encode the same value (one real folder's `size`
 * exactly matched its first child file's own `offsets[]` + 1), but that
 * turned out not to generalize: a folder with no *immediate* file child
 * (its own first child is itself another folder) can have `size = 0`
 * instead, which isn't a real offset at all. Trusting a folder's `size`
 * field produced a real 0-byte-extraction bug (`424p.spt`, immediately
 * followed by an empty-looking folder marker whose next real content was
 * two folder-levels further in) - so folder markers are skipped
 * entirely here instead: walk forward past every consecutive `offsets
 * [i] === -1` entry (however many folder markers deep) until the first
 * real file's own valid offset is found, or the archive ends.
 */
function nextRealOffset(archive, fromIndex) {
  for (let i = fromIndex; i < archive.rawEntries.length; i++) {
    if (archive.offsets[i] >= 0) return archive.offsets[i];
  }
  return archive.buf.length - archive.dataStart;
}

function extractBytes(archive, entry) {
  const start = archive.dataStart + archive.offsets[entry.index];
  const end = archive.dataStart + nextRealOffset(archive, entry.index + 1);
  return archive.buf.subarray(start, end);
}

function loadAllArchives() {
  const files = fs.readdirSync(CHEF_DIR).filter((f) => /\.rpk$/i.test(f));
  const archives = [];
  for (const f of files) {
    const full = path.join(CHEF_DIR, f);
    archives.push({ name: f, ...parseRpk(full) });
  }
  return archives;
}

/** Case-insensitive lookup by the entry's own reconstructed lowercase path (leading ".\" or "./" and backslashes normalized away first). */
function findEntry(archives, clientPath) {
  const normalized = clientPath
    .replace(/^\.[\\/]?/, '')
    .replace(/^chef[\\/]/i, '')
    .replace(/\\/g, '/')
    .toLowerCase();
  for (const archive of archives) {
    const entry = archive.entries.find((e) => !e.folder && e.lowerPath === normalized);
    if (entry) return { archive, entry };
  }
  return null;
}

/** Converts a Chef/-relative client path (backslashes, ".\Chef\...") into a real filesystem path under public/game-assets/Chef/, preserving whatever casing the caller passed in. */
function clientPathToLocalFile(clientPath) {
  const normalized = clientPath.replace(/\\/g, '/').replace(/^\.?\/?Chef\/?/i, '');
  return path.join(CHEF_DIR, normalized);
}

function writeExtracted(localPath, bytes) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, bytes);
}

/** A 0-byte file on disk means an earlier, buggier run of this same script mis-extracted it (a since-fixed bug where a file immediately followed by a folder entry computed a negative/zero length) - treated as "not really there" so it gets a fresh extraction attempt instead of being silently trusted. */
function existsNonEmpty(localPath) {
  if (!fs.existsSync(localPath)) return false;
  return fs.statSync(localPath).size > 0;
}

function loadParticleIniPaths() {
  const text = fs.readFileSync(path.join(CHEF_DIR, 'Particle.ini'), 'latin1');
  const paths = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^PARTICLE\s*=\s*(\S+)/i.exec(raw.trim());
    if (m) paths.push(m[1]);
  }
  return paths;
}

function main() {
  console.log(DRY_RUN ? 'DRY RUN - no files will be written\n' : '');
  console.log('Loading .rpk archives...');
  const archives = loadAllArchives();
  console.log(`Loaded ${archives.length} archives, ${archives.reduce((n, a) => n + a.entries.length, 0)} total entries.\n`);

  const sptPaths = loadParticleIniPaths();
  console.log(`Particle.ini lists ${sptPaths.length} .spt paths.`);

  let sptAlreadyLocal = 0;
  let sptExtracted = 0;
  let sptNotInRpk = 0;
  let entityExtracted = 0;
  let entityAlreadyLocal = 0;
  let entityNotInRpk = 0;
  const notFoundSpt = [];
  const notFoundEntity = [];

  for (const clientSptPath of sptPaths) {
    const localSptFile = clientPathToLocalFile(clientSptPath);
    let sptText;

    if (existsNonEmpty(localSptFile)) {
      sptAlreadyLocal++;
      sptText = fs.readFileSync(localSptFile, 'latin1');
    } else {
      const found = findEntry(archives, clientSptPath);
      if (!found) {
        sptNotInRpk++;
        notFoundSpt.push(clientSptPath);
        continue;
      }
      const bytes = extractBytes(found.archive, found.entry);
      writeExtracted(localSptFile, bytes);
      sptExtracted++;
      sptText = bytes.toString('latin1');
    }

    const entityMatch = /^entity_file\s+(\S+)/im.exec(sptText);
    if (!entityMatch) continue;
    const clientEntityPath = entityMatch[1];
    const localEntityFile = clientPathToLocalFile(clientEntityPath);
    const entityAlreadyPresent = existsNonEmpty(localEntityFile);
    if (entityAlreadyPresent) entityAlreadyLocal++;

    // Each of .r3e/.r3m/.r3t (same folder, same basename, different
    // extension) is checked and extracted independently, regardless of
    // whether the main .r3e itself needed extracting - an earlier version
    // of this script skipped the whole sibling check whenever the .r3e
    // already existed, which left a real, silent gap: a bundle whose .r3e
    // was already present locally (from an earlier, correct extraction)
    // but whose .r3m/.r3t siblings had been mis-extracted as 0-byte files
    // by a bug since fixed in this script (see nextRealOffset's own doc
    // comment) never got those siblings retried. .r3m/.r3t aren't parsed
    // by this project's runtime yet, but extracting them now means that
    // follow-up work doesn't need a second extraction pass.
    //
    // Sibling extension casing matches whatever case the .spt's own
    // entity_file line used for the .r3e extension (real files use mixed
    // case there, e.g. "aura.R3E") rather than a hardcoded lowercase - an
    // earlier version of this script always wrote lowercase ".r3e/.r3m/
    // .r3t" regardless, which silently 404s (or worse, 200s with Vite's
    // own SPA fallback page - see docs/rf-format-notes.md's "known bugs"
    // section) against a real .spt requesting the uppercase spelling. The
    // runtime now also has its own case-insensitive fallback for exactly
    // this (particleSystem.ts's loadR3EGeometry/loadParticleTemplate), so
    // this fix is belt-and-suspenders, not load-bearing - correct casing
    // on disk still matters for anything that fetches these files without
    // going through that fallback (e.g. a future r3m/r3t consumer).
    const entityExtMatch = /\.([A-Za-z0-9]+)$/.exec(clientEntityPath);
    const entityExtIsUpper = entityExtMatch ? entityExtMatch[1] === entityExtMatch[1].toUpperCase() : false;
    const stemNoExt = clientEntityPath.replace(/\.[^./\\]+$/, '');
    let anySiblingExtracted = false;
    for (const bareExt of ['r3e', 'r3m', 'r3t']) {
      const ext = '.' + (entityExtIsUpper ? bareExt.toUpperCase() : bareExt);
      const siblingClientPath = stemNoExt + ext;
      const siblingLocalFile = clientPathToLocalFile(siblingClientPath);
      if (existsNonEmpty(siblingLocalFile)) continue;
      const siblingEntry = findEntry(archives, siblingClientPath);
      if (!siblingEntry) continue;
      const bytes = extractBytes(siblingEntry.archive, siblingEntry.entry);
      writeExtracted(siblingLocalFile, bytes);
      anySiblingExtracted = true;
    }

    if (!entityAlreadyPresent) {
      if (anySiblingExtracted) entityExtracted++;
      else if (!findEntry(archives, clientEntityPath)) {
        entityNotInRpk++;
        notFoundEntity.push(clientEntityPath);
      }
    }
  }

  console.log('\n--- .spt files ---');
  console.log(`already local: ${sptAlreadyLocal}`);
  console.log(`extracted from .rpk: ${sptExtracted}`);
  console.log(`not found anywhere (genuinely missing from this dataset): ${sptNotInRpk}`);

  console.log('\n--- entity bundles (.r3e/.r3m/.r3t) ---');
  console.log(`already local: ${entityAlreadyLocal}`);
  console.log(`extracted from .rpk: ${entityExtracted}`);
  console.log(`not found anywhere: ${entityNotInRpk}`);

  if (notFoundSpt.length > 0) {
    console.log('\nSample .spt paths not found anywhere:');
    for (const p of notFoundSpt.slice(0, 15)) console.log(' ', p);
  }
  if (notFoundEntity.length > 0) {
    console.log('\nSample entity paths not found anywhere:');
    for (const p of notFoundEntity.slice(0, 15)) console.log(' ', p);
  }
}

main();
