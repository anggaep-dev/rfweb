import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMesh } from './mesh';

// Real, committed asset - a loose (already-extracted, non-MESH08) cloak mesh
// - regression coverage for the default-format path after it was extracted
// out of parseMesh into decodeDefaultMeshObject (see mesh.mesh08.test.ts for
// the new MESH08 path this refactor made room for).
const MESH_PATH = 'public/game-assets/item/Armor/Mesh/BELMALE_ARMOR_CLOAK_002.msh';

describe('parseMesh - default (non-MESH08) format', () => {
  it('parses a real cloak mesh: dummy sockets and the one real geometry sub-object', () => {
    const buffer = readFileSync(MESH_PATH);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const objects = parseMesh(arrayBuffer);

    expect(objects.length).toBe(8);
    const names = objects.map((o) => o.name);
    expect(names).toContain('Dummy_Arms_L');
    expect(names).toContain('M_00');

    const dummy = objects.find((o) => o.name === 'Dummy_Arms_L');
    expect(dummy?.vertices.length).toBe(0);
    expect(dummy?.parentName).toBe('Bip01 L Hand');

    const real = objects.find((o) => o.name === 'M_00');
    expect(real).toBeDefined();
    // Flattened per-triangle-corner (non-indexed), not per unique vertex:
    // 1676 triangles (confirmed real triangleAmount, by direct byte
    // inspection) x 3 corners x 3 floats.
    expect(real!.vertices.length).toBe(1676 * 3 * 3);
    expect(real!.normals.length).toBe(real!.vertices.length);
    expect(real!.texturePath).toContain('Manteau_Di_bb.dds');
    for (let i = 0; i < real!.vertices.length; i++) expect(Number.isFinite(real!.vertices[i])).toBe(true);
  });
});
