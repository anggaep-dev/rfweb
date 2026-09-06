import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { facingToRotation, rotationToYaw } from '../net/compassRotation';

/**
 * Regression test for a real, shipped bug: RemoteEntityController used to
 * apply FACING_CORRECTION a second time when converting a decoded yaw into
 * a world rotation (`character.group.rotation.y = remote.yaw +
 * MESH_FACING_CORRECTION_RAD`, later refactored into
 * CharacterController.setWorldYaw - see its own doc comment). That
 * correction is only valid folded into update()'s own lookAt(facePoint,
 * position, up) call - note the swapped eye/target order, looking FROM one
 * step ahead BACK AT the character rather than the standard order - which
 * already cancels it out. Applying it again on top of a plain
 * `setFromAxisAngle(Y, yaw)` double-corrects and faces every remote entity
 * exactly backward from how the local player's own client renders that same
 * yaw. This reproduces both pipelines' math (without needing a mounted
 * CharacterController/scene) and asserts they agree - see setWorldYaw's own
 * doc comment for the fix.
 */

const FACING_CORRECTION = new Quaternion(0, 1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const LOCAL_FORWARD = new Vector3(0, 0, -1);

/** Mirrors CharacterController.update()'s local-player turn, assuming the turn has fully caught up (rotateTowards reached its target). */
function localPipelineQuat(faceNorm: Vector3, position: Vector3): Quaternion {
  const facePoint = position.clone().add(faceNorm);
  const lookMatrix = new Matrix4().lookAt(facePoint, position, new Vector3(0, 1, 0));
  return new Quaternion().setFromRotationMatrix(lookMatrix).multiply(FACING_CORRECTION);
}

/** Mirrors CharacterController.setWorldYaw(). */
function setWorldYawQuat(yaw: number): Quaternion {
  return new Quaternion().setFromAxisAngle(Y_AXIS, yaw);
}

describe('local player rotation vs remote setWorldYaw agree on the same facing', () => {
  const cases: [number, number][] = [
    [1, 0], // East
    [0, -1], // North
    [0, 1], // South
    [-1, 0], // West
    [1, -1], // NE
    [-1, -1], // NW
    [1, 1], // SE
    [-1, 1], // SW
  ];

  for (const [x, z] of cases) {
    it(`facing (${x}, ${z})`, () => {
      const faceNorm = new Vector3(x, 0, z).normalize();
      const position = new Vector3(3, 0, -2); // arbitrary, non-origin, to catch any position-dependence bug

      const localForward = LOCAL_FORWARD.clone().applyQuaternion(localPipelineQuat(faceNorm, position));

      // What a remote observer decodes off the wire, then feeds setWorldYaw with.
      const yaw = rotationToYaw(facingToRotation(faceNorm));
      const remoteForward = LOCAL_FORWARD.clone().applyQuaternion(setWorldYawQuat(yaw));

      expect(remoteForward.x).toBeCloseTo(localForward.x, 3);
      expect(remoteForward.z).toBeCloseTo(localForward.z, 3);
    });
  }
});
