import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry, Mesh, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { parseBsp } from './bsp';
import { nativeToScene } from './map';

const BSP_PATH = 'public/game-assets/maps/Elan/elan.bsp';

function readArrayBuffer(path: string): ArrayBuffer {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

describe('nativeToScene - real Elan map alignment', () => {
  it('renders native RF entity positions where the real map mesh actually has a floor', () => {
    const { groups } = parseBsp(readArrayBuffer(BSP_PATH));
    const meshes = groups
      .filter((g) => g.vertices.length > 0)
      .map((g) => {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(g.vertices, 3));
        return new Mesh(geometry);
      });

    // Closest hit to `referenceY`, not the topmost - a multi-story building
    // has a roof/upper floor above the real target floor too (see
    // OnlineScene's followGroundHeight for the same reasoning applied to the
    // real per-frame ground-follow).
    function nearestFloorY(x: number, z: number, referenceY: number): number | null {
      const ray = new Raycaster(new Vector3(x, 100000, z), new Vector3(0, -1, 0));
      let best: number | null = null;
      for (const mesh of meshes) {
        for (const hit of ray.intersectObject(mesh, false)) {
          if (best === null || Math.abs(hit.point.y - referenceY) < Math.abs(best - referenceY)) best = hit.point.y;
        }
      }
      return best;
    }

    // Two real, independently-known native RF positions - docs/map.md's own
    // coordinate-rules example (the "dp_elan_start" spawn helper) and a real
    // monster spawn (dmm18_7) pulled from a live GET /map response. Both
    // should land on real, walkable mesh geometry once converted - this is
    // exactly the check that would have caught the mesh/entity-position
    // mismatch (a `%goto` and monster-spawn debug markers rendering outside
    // the visible map) before it shipped, since a naive (unconverted) render
    // finds no floor within hundreds of units of either point.
    const realNativePositions = [
      { name: 'dp_elan_start', x: -5234, y: 438, z: -3603 },
      { name: 'dmm18_7', x: -1102.615112, y: 311.787933, z: 424.418121 },
    ];

    for (const p of realNativePositions) {
      const scene = nativeToScene(p);
      const floorY = nearestFloorY(scene.x, scene.z, p.y);
      expect(floorY, `${p.name}: expected a floor near y=${p.y} at converted (${scene.x}, ${scene.z})`).not.toBeNull();
      expect(Math.abs((floorY as number) - p.y), `${p.name}: nearest floor was ${floorY}, expected close to ${p.y}`).toBeLessThan(50);
    }
  });
});
