import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blocksMovement } from './collision';
import { parseEbpCollision } from './ebp';
import type { CollisionWall } from './ebp';

const EBP_PATH = 'public/game-assets/maps/Elan/Elan.ebp';

function wall(startX: number, startY: number, startZ: number, endX: number, endY: number, endZ: number, height: number): CollisionWall {
  return {
    start: { x: startX, y: startY, z: startZ } as CollisionWall['start'],
    end: { x: endX, y: endY, z: endZ } as CollisionWall['end'],
    height,
  };
}

describe('blocksMovement - synthetic walls (mirrors rfworld collision_test.go)', () => {
  const walls = [wall(10, 0, -20, 10, 0, 20, 100)];

  it('blocks a movement segment crossing the wall', () => {
    expect(blocksMovement(walls, 0, 0, 20, 0, 10)).toBe(true);
  });

  it('allows movement above the wall (outside its height window)', () => {
    expect(blocksMovement(walls, 0, 0, 20, 0, 200)).toBe(false);
  });

  it('allows movement outside the wall segment (past its Z extent)', () => {
    expect(blocksMovement(walls, 0, 30, 20, 30, 10)).toBe(false);
  });

  it('allows movement that never crosses the wall line at all', () => {
    expect(blocksMovement(walls, 0, 0, 0, 50, 10)).toBe(false);
  });

  it('is a no-op for a zero-length (X/Z) segment', () => {
    expect(blocksMovement(walls, 10, 0, 10, 0, 10)).toBe(false);
  });

  it('skips a zero-height wall, matching the backend skipping it too', () => {
    const zeroHeight = [wall(10, 0, -20, 10, 0, 20, 0)];
    expect(blocksMovement(zeroHeight, 0, 0, 20, 0, 10)).toBe(false);
  });
});

describe('blocksMovement - real Elan map', () => {
  it('blocks a perpendicular crossing of real, sampled wall segments', () => {
    const buffer = readFileSync(EBP_PATH);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const { walls } = parseEbpCollision(arrayBuffer);

    let tested = 0;
    let blocked = 0;
    for (let i = 0; i < walls.length; i += 137) {
      const w = walls[i];
      if (w.height <= 0) continue;
      const dx = w.end.x - w.start.x;
      const dz = w.end.z - w.start.z;
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;

      const mx = (w.start.x + w.end.x) / 2;
      const mz = (w.start.z + w.end.z) / 2;
      const my = (w.start.y + w.end.y) / 2;
      const px = -dz / length;
      const pz = dx / length;
      const off = 10;

      tested++;
      if (blocksMovement(walls, mx - px * off, mz - pz * off, mx + px * off, mz + pz * off, my)) blocked++;
    }

    expect(tested).toBeGreaterThan(0);
    expect(blocked).toBe(tested);
  });
});
