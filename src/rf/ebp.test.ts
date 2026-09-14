import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEbpCollision } from './ebp';

// Real, committed-locally asset - see bsp.test.ts's own doc comment on this convention.
const EBP_PATH = 'public/game-assets/maps/Elan/Elan.ebp';

describe('parseEbpCollision - real Elan map', () => {
  it('parses without throwing and produces sane collision walls', () => {
    const buffer = readFileSync(EBP_PATH);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

    const { walls } = parseEbpCollision(arrayBuffer);

    expect(walls.length).toBeGreaterThan(0);
    for (const wall of walls) {
      expect(Number.isFinite(wall.start.x)).toBe(true);
      expect(Number.isFinite(wall.start.y)).toBe(true);
      expect(Number.isFinite(wall.start.z)).toBe(true);
      expect(Number.isFinite(wall.end.x)).toBe(true);
      expect(Number.isFinite(wall.height)).toBe(true);
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxHeight = -Infinity;
    for (const wall of walls) {
      minX = Math.min(minX, wall.start.x, wall.end.x);
      maxX = Math.max(maxX, wall.start.x, wall.end.x);
      minZ = Math.min(minZ, wall.start.z, wall.end.z);
      maxZ = Math.max(maxZ, wall.start.z, wall.end.z);
      maxHeight = Math.max(maxHeight, wall.height);
    }
    console.log(`walls: ${walls.length}, x:[${minX},${maxX}] z:[${minZ},${maxZ}] maxHeight:${maxHeight}`);

    // Sanity check against the real BSP map bounds measured elsewhere in this
    // session (roughly -30000..30000 on X/Z) - collision geometry should sit
    // in the same ballpark, not some wildly different coordinate space (this
    // is exactly the assertion that would have caught the CFVertex index 0
    // sentinel-garbage bug - see parseEbpCollision's own doc comment on why
    // it's filtered - if it were still leaking through here).
    expect(minX).toBeGreaterThan(-100000);
    expect(maxX).toBeLessThan(100000);
    expect(minZ).toBeGreaterThan(-100000);
    expect(maxZ).toBeLessThan(100000);
    expect(maxX - minX).toBeGreaterThan(1000);
    expect(maxHeight).toBeGreaterThan(0);
  });
});
