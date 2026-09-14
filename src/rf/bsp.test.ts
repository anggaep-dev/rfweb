import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBsp } from './bsp';
import { parseR3M } from './r3m';
import { parseR3T } from './r3t';

// Real, committed-locally assets (public/game-assets is gitignored - see its
// own README - same "only works where the asset has actually been dropped
// in" convention mesh.test.ts already relies on for its own real .msh file).
const MAP_DIR = 'public/game-assets/maps/Elan';
const BSP_PATH = `${MAP_DIR}/elan.bsp`;
const R3M_PATH = `${MAP_DIR}/elan.r3m`;
const R3T_PATH = `${MAP_DIR}/elan.r3t`;

function readArrayBuffer(path: string): ArrayBuffer {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

describe('parseBsp - real Elan map', () => {
  it('parses without throwing and produces sane per-material geometry', () => {
    const { groups } = parseBsp(readArrayBuffer(BSP_PATH));

    expect(groups.length).toBeGreaterThan(0);

    let totalTriangles = 0;
    for (const group of groups) {
      expect(group.materialId).toBeGreaterThanOrEqual(0);
      expect(group.vertices.length % 9).toBe(0); // whole triangles, 3 floats x 3 corners
      expect(group.uvs.length).toBe((group.vertices.length / 3) * 2);
      totalTriangles += group.vertices.length / 9;

      // A single assertion per array instead of per-element: at real map
      // scale (millions of floats total) a per-element `expect()` call is
      // itself the bottleneck, not parseBsp (confirmed: parseBsp alone
      // measured under 0.5s here; the equivalent per-element-assertion
      // version of this test took over 20s).
      expect(group.vertices.every(Number.isFinite)).toBe(true);
      expect(group.uvs.every(Number.isFinite)).toBe(true);
    }

    expect(totalTriangles).toBeGreaterThan(1000);
  });

  it('every group.materialId resolves to a real .r3m material with a valid .r3t texture', () => {
    const { groups } = parseBsp(readArrayBuffer(BSP_PATH));
    const materials = parseR3M(readArrayBuffer(R3M_PATH));
    const textures = parseR3T(readArrayBuffer(R3T_PATH));

    expect(materials.length).toBeGreaterThan(0);
    expect(textures.size).toBeGreaterThan(0);

    let resolvedTextureCount = 0;
    for (const group of groups) {
      const material = materials[group.materialId];
      expect(material).toBeDefined();
      const textureId = material.textureLayers[0]?.textureId;
      if (textureId && textureId > 0) {
        expect(textures.has(textureId)).toBe(true);
        resolvedTextureCount++;
      }
    }
    // Not every material necessarily has a texture layer, but most of a real
    // terrain map's should - a suspiciously low count here would mean the
    // materialId/textureId wiring is broken, not just "some untextured
    // materials exist".
    expect(resolvedTextureCount).toBeGreaterThan(groups.length * 0.5);
  });
});
