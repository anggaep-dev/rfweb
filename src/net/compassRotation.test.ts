import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { facingToRotation, quantizeDirectionVector, quantizeToCompass, rotationToYaw } from './compassRotation';

describe('quantizeToCompass', () => {
  it('snaps the 4 cardinal directions exactly', () => {
    expect(quantizeToCompass(0, -1)).toEqual([0, -1]); // North
    expect(quantizeToCompass(1, 0)).toEqual([1, 0]); // East
    expect(quantizeToCompass(0, 1)).toEqual([0, 1]); // South
    expect(quantizeToCompass(-1, 0)).toEqual([-1, 0]); // West
  });

  it('snaps the 4 diagonals exactly', () => {
    const diag = Math.SQRT1_2;
    expect(quantizeToCompass(diag, -diag)).toEqual([1, -1]); // NE
    expect(quantizeToCompass(diag, diag)).toEqual([1, 1]); // SE
    expect(quantizeToCompass(-diag, diag)).toEqual([-1, 1]); // SW
    expect(quantizeToCompass(-diag, -diag)).toEqual([-1, -1]); // NW
  });

  it('stays within a wedge for angles well inside its 45deg span', () => {
    // 10deg off North, either side - still North, not NE/NW.
    const rad = (10 * Math.PI) / 180;
    expect(quantizeToCompass(Math.sin(rad), -Math.cos(rad))).toEqual([0, -1]);
    expect(quantizeToCompass(-Math.sin(rad), -Math.cos(rad))).toEqual([0, -1]);
  });

  it('crosses into the diagonal wedge past the 22.5deg boundary', () => {
    const rad = (23 * Math.PI) / 180;
    expect(quantizeToCompass(Math.sin(rad), -Math.cos(rad))).toEqual([1, -1]); // just past NE boundary
  });

  it('returns [0, 0] for a near-zero vector', () => {
    expect(quantizeToCompass(0, 0)).toEqual([0, 0]);
    expect(quantizeToCompass(1e-8, -1e-8)).toEqual([0, 0]);
  });
});

describe('rotationToYaw / facingToRotation round-trip', () => {
  it('recovers the same compass direction after encode -> decode', () => {
    const cases: [number, number][] = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ];
    for (const [x, z] of cases) {
      const facing = new Vector3(x, 0, z).normalize();
      const rotation = facingToRotation(facing);
      const yaw = rotationToYaw(rotation);
      const decoded = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), yaw);
      // Direction-only check: decoded should point the same octant as the
      // input (+0 normalizes any -0 from a component that rounds to zero).
      expect(Math.sign(Math.round(decoded.x)) + 0).toBe(Math.sign(x) + 0);
      expect(Math.sign(Math.round(decoded.z)) + 0).toBe(Math.sign(z) + 0);
    }
  });
});

describe('quantizeDirectionVector', () => {
  it('leaves `out` untouched and returns false for a ~zero vector', () => {
    const out = new Vector3(5, 5, 5);
    const changed = quantizeDirectionVector(new Vector3(0, 0, 0), out);
    expect(changed).toBe(false);
    expect(out).toEqual(new Vector3(5, 5, 5));
  });

  it('snaps to a unit vector along the compass grid', () => {
    const out = new Vector3();
    const changed = quantizeDirectionVector(new Vector3(0.9, 0, -0.1), out);
    expect(changed).toBe(true);
    expect(out.x).toBeCloseTo(1, 5);
    expect(out.z).toBeCloseTo(0, 5);
  });
});
