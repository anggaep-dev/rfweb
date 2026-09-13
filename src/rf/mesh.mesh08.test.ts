import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findRfsEntry, parseRfs, readRfsEntry } from './rfs';
import { parseMesh } from './mesh';

// Real, committed asset - the same GDBUSTER.RFS the CDN-migrated booster
// cloak meshes were extracted from (see scripts/extract_rfs.py's
// BOOSTER_MESH_BASE/BOOSTER_ARCHIVE_NAME) - not a synthetic fixture, so this
// test exercises parseMesh against genuine MESH08 bytes.
const ARCHIVE_PATH = 'public/game-assets/item/New_Booster/Mesh/GDBUSTER.RFS';

function loadBoosterMesh(entryName: string): ReturnType<typeof parseMesh> {
  const nodeBuffer = readFileSync(ARCHIVE_PATH);
  const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength) as ArrayBuffer;
  const archive = parseRfs(arrayBuffer);
  const entry = findRfsEntry(archive, entryName);
  if (!entry) throw new Error(`"${entryName}" not found in ${ARCHIVE_PATH}`);
  return parseMesh(readRfsEntry(archive, entry));
}

describe('parseMesh - MESH08 (real booster cloak meshes)', () => {
  it('parses every real race/tier booster mesh without throwing, and finds real geometry', () => {
    const races = ['ACCRETIA', 'BELFEMALE', 'BELMALE', 'CORFEMALE', 'CORMALE'];
    const tiers = ['50', '52', '53', '54'];
    for (const race of races) {
      for (const tier of tiers) {
        const stem = `${race}_COSTUMEARMOR_CLOAK_${tier}`;
        const objects = loadBoosterMesh(`${stem}.msh`);
        expect(objects.length).toBeGreaterThan(0);
        const withGeometry = objects.filter((o) => o.vertices.length > 0);
        expect(withGeometry.length).toBeGreaterThan(0);
      }
    }
  });

  it('decodes BELMALE tier 50 in full detail: dummy sockets, real geometry, and the embedded texture reference', () => {
    const objects = loadBoosterMesh('BELMALE_COSTUMEARMOR_CLOAK_50.msh');

    // Every real socket/dummy name seen in this file, confirmed by direct
    // byte inspection (extract_rfs_entry.mjs + manual header walk) before
    // this parser existed - not just "some objects came back".
    const names = objects.map((o) => o.name);
    expect(names).toContain('Dummy_Shield_L');
    expect(names).toContain('gundam_buster');

    const dummy = objects.find((o) => o.name === 'Dummy_Shield_L');
    expect(dummy?.vertices.length).toBe(0);
    expect(dummy?.parentName).toBe('Bip01 L Hand');

    const real = objects.find((o) => o.name === 'gundam_buster');
    expect(real).toBeDefined();
    expect(real!.vertices.length).toBeGreaterThan(0);
    expect(real!.vertices.length % 3).toBe(0);
    expect(real!.normals.length).toBe(real!.vertices.length);
    expect(real!.uvs.length).toBe((real!.vertices.length / 3) * 2);

    // The mesh's own embedded texture reference - confirmed by direct byte
    // inspection to be an absolute dev-machine path whose basename is
    // "01_buster_BE", exactly matching character.ts's boosterTextureName()
    // formula's output for this same race/tier. This is the whole point of
    // the test: proves the formula was already correct, and the real bug
    // was MESH08 support being entirely missing, not the texture naming.
    expect(real!.texturePath.toUpperCase()).toContain('01_BUSTER_BE');

    // No NaN/garbage floats snuck into vertex data - the classic symptom of
    // a byte-offset miscalculation in a binary reader.
    for (let i = 0; i < real!.vertices.length; i++) expect(Number.isFinite(real!.vertices[i])).toBe(true);
    for (let i = 0; i < real!.normals.length; i++) expect(Number.isFinite(real!.normals[i])).toBe(true);
  });
});
