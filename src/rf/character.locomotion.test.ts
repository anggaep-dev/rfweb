import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { classifyLocomotionDirection, classifyLocomotionDirectionStable, classifyMovementAgainstFacing } from './character';

const UP = new Vector3(0, 1, 0);

describe('classifyLocomotionDirection', () => {
  it('classifies dominant-forward/backward as bw or null (plain forward)', () => {
    expect(classifyLocomotionDirection(0, 1)).toBeNull();
    expect(classifyLocomotionDirection(0, -1)).toBe('bw');
  });

  it('classifies dominant-sideways as lf/rt', () => {
    expect(classifyLocomotionDirection(1, 0)).toBe('rt');
    expect(classifyLocomotionDirection(-1, 0)).toBe('lf');
  });

  it('ties go to forward', () => {
    expect(classifyLocomotionDirection(1, 1)).toBeNull();
    expect(classifyLocomotionDirection(1, -1)).toBe('bw');
  });
});

describe('classifyLocomotionDirectionStable (hysteresis)', () => {
  it('does not flicker for a value oscillating right at the raw boundary', () => {
    // x/y sit almost exactly on the |y|===|x| boundary, alternating which
    // side of it by a hair - the plain (non-hysteresis) classifier would
    // flip every frame; the stable one should hold its previous group.
    let prev: ReturnType<typeof classifyLocomotionDirectionStable> = null;
    const samples: [number, number][] = [
      [0, 1],
      [1.01, 1],
      [0.99, 1],
      [1.02, 1],
      [0.98, 1],
    ];
    const results = samples.map(([x, y]) => (prev = classifyLocomotionDirectionStable(x, y, prev)));
    // Started in the forward/backward group (null) and the hysteresis band
    // should keep it there for every sample that isn't clearly (>=15%) past it.
    expect(results).toEqual([null, null, null, null, null]);
  });

  it('still switches immediately on a genuine direction reversal within the same group', () => {
    // bw -> null (sign flip on y) is a real reversal, not boundary noise.
    const afterBw = classifyLocomotionDirectionStable(0, -1, null);
    expect(afterBw).toBe('bw');
    const afterForward = classifyLocomotionDirectionStable(0, 1, afterBw);
    expect(afterForward).toBeNull();
  });

  it('switches group once a value is clearly past the hysteresis band', () => {
    const stillForward = classifyLocomotionDirectionStable(1.1, 1, null); // within band
    expect(stillForward).toBeNull();
    const nowStrafe = classifyLocomotionDirectionStable(1.2, 1, stillForward); // past 1.15x
    expect(nowStrafe).toBe('rt');
  });
});

/** North-facing unit vector, matching OnlineScene/RemoteEntityController's default. */
const NORTH = new Vector3(0, 0, -1);

describe('classifyMovementAgainstFacing', () => {
  it('classifies pure forward/backward/strafe relative to facing north', () => {
    const scratch = new Vector3();
    expect(classifyMovementAgainstFacing(new Vector3(0, 0, -1), NORTH, null, scratch, UP)).toBeNull(); // forward
    expect(classifyMovementAgainstFacing(new Vector3(0, 0, 1), NORTH, null, scratch, UP)).toBe('bw');
    expect(classifyMovementAgainstFacing(new Vector3(1, 0, 0), NORTH, null, scratch, UP)).toBe('rt');
    expect(classifyMovementAgainstFacing(new Vector3(-1, 0, 0), NORTH, null, scratch, UP)).toBe('lf');
  });

  it('classifies the same physical strafe consistently regardless of which way the character faces', () => {
    // Facing east; moving in world -Z (what was "forward" while facing
    // north) is now a pure sideways strafe relative to facing, not forward.
    const facingEast = new Vector3(1, 0, 0);
    const scratch = new Vector3();
    const result = classifyMovementAgainstFacing(new Vector3(0, 0, -1), facingEast, null, scratch, UP);
    expect(result).toBe('lf');
  });

  it('agrees with the plain classifyLocomotionDirection for a hand-derived local basis', () => {
    // Cross-check classifyMovementAgainstFacing's own cross/dot orchestration
    // against manually projecting into facing's local right/forward axes.
    const facing = new Vector3(1, 0, -1).normalize(); // NE
    const moveDirection = new Vector3(1, 0, 1).normalize(); // SE
    const right = new Vector3().crossVectors(facing, UP).normalize();
    const localX = moveDirection.dot(right);
    const localY = moveDirection.dot(facing);
    const expected = classifyLocomotionDirection(localX, localY);

    const scratch = new Vector3();
    const actual = classifyMovementAgainstFacing(moveDirection, facing, null, scratch, UP);
    expect(actual).toBe(expected);
  });
});
