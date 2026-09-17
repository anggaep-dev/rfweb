import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { continuousRotationFromVector, rotationToYaw } from '../net/compassRotation';
import { classifyLocomotionDirection, classifyMovementAgainstFacing } from '../rf/character';
import type { LocomotionDirection } from '../rf/character';

const UP = new Vector3(0, 1, 0);
const LOCAL_FORWARD = new Vector3(0, 0, -1);

/**
 * This test exists because the local-vs-remote locomotion classification
 * mismatch ("observer misclassifies strafe/backward as forward") took a
 * full session to chase down live (two browser clients + console logging)
 * without a confirmed root cause - see the TEMP diagnostics that used to
 * live in OnlineScene.ts/RemoteEntityController.ts before this test
 * replaced them. Both sides' math is pure (no rendering, no network, no
 * timing) once isolated like this, so any real classification disagreement
 * should be reproducible here in milliseconds instead of by eyeballing two
 * game clients.
 *
 * Updated when movement/facing stopped snapping to a fixed 8-way compass
 * grid (see OnlineScene.ts's own doc comment) - the sender pipeline below
 * now sends the exact continuous camera-relative vector/angle, matching
 * what OnlineScene.update() actually does.
 */

/** Mirrors OnlineScene's per-frame sender pipeline: resolve move from camera, classify raw local input like ViewerScene, then send the exact continuous vector/facing - no compass snapping on either end any more. */
function senderFrame(
  cameraForward: Vector3,
  input: { x: number; y: number },
): {
  localLocomotionDirection: LocomotionDirection | null;
  moveDirection: Vector3;
  faceDirection: Vector3;
  sentDx: number;
  sentDz: number;
  sentFacingRotation: number;
} {
  const cameraRight = new Vector3().crossVectors(cameraForward, UP).normalize();
  const moveDirection = new Vector3().addScaledVector(cameraForward, input.y).addScaledVector(cameraRight, input.x);
  if (moveDirection.lengthSq() > 1e-8) moveDirection.normalize();

  const localLocomotionDirection = classifyLocomotionDirection(input.x, input.y);
  const faceDirection = (localLocomotionDirection ? cameraForward : moveDirection).clone();
  // moveDirection is render-space (camera-relative); the server's dir_z
  // increments a native Z - see nativeToScene's own doc comment on why
  // that's the negation of scene Z, same convention OnlineScene itself uses.
  const sentDx = moveDirection.x;
  const sentDz = -moveDirection.z;
  const sentFacingRotation = continuousRotationFromVector(faceDirection);
  return { localLocomotionDirection, moveDirection, faceDirection, sentDx, sentDz, sentFacingRotation };
}

/** Mirrors RemoteEntityController.tick()'s classification (against targetYaw, not the smoothed render `yaw` - see its own doc comment) from wire values alone. */
function receiverClassify(
  sentDx: number,
  sentDz: number,
  sentFacingRotation: number,
  previous: LocomotionDirection | null,
): LocomotionDirection | null {
  const len = Math.hypot(sentDx, sentDz);
  if (len < 1e-6) return previous; // idle - RemoteEntityController skips classification entirely while !isMoving
  const moveDirection = new Vector3(sentDx / len, 0, -sentDz / len);
  const facing = LOCAL_FORWARD.clone().applyAxisAngle(UP, rotationToYaw(sentFacingRotation));
  const scratch = new Vector3();
  return classifyMovementAgainstFacing(moveDirection, facing, previous, scratch, UP);
}

describe('local prediction vs remote reconstruction agree on locomotion clip', () => {
  const cameraAzimuths = Array.from({ length: 24 }, (_, i) => (i * Math.PI) / 12); // every 15deg, full circle
  const inputs: { x: number; y: number }[] = [
    { x: 0, y: 1 }, // forward
    { x: 0, y: -1 }, // backward
    { x: 1, y: 0 }, // strafe right
    { x: -1, y: 0 }, // strafe left
  ];

  for (const azimuth of cameraAzimuths) {
    for (const input of inputs) {
      it(`camera@${Math.round((azimuth * 180) / Math.PI)}deg input=(${input.x},${input.y})`, () => {
        const cameraForward = new Vector3(0, 0, -1).applyAxisAngle(UP, azimuth);

        let local: LocomotionDirection | null = null;
        let remote: LocomotionDirection | null = null;
        for (let frame = 0; frame < 5; frame++) {
          const result = senderFrame(cameraForward, input);
          local = result.localLocomotionDirection;
          remote = receiverClassify(result.sentDx, result.sentDz, result.sentFacingRotation, remote);
        }

        expect(remote).toBe(local);
      });
    }
  }
});

describe('local prediction sends the exact same vector it renders with', () => {
  const cameraAzimuths = Array.from({ length: 72 }, (_, i) => (i * Math.PI) / 36); // every 5deg, full circle

  for (const azimuth of cameraAzimuths) {
    it(`camera@${Math.round((azimuth * 180) / Math.PI)}deg forward input`, () => {
      const cameraForward = new Vector3(0, 0, -1).applyAxisAngle(UP, azimuth);
      const result = senderFrame(cameraForward, { x: 0, y: 1 });

      // No quantization step any more - the sent dx/dz are exactly
      // moveDirection's own components (Z negated for the native/scene
      // convention), not a lossy compass-snapped approximation of them.
      expect(result.sentDx).toBe(result.moveDirection.x);
      expect(result.sentDz).toBe(-result.moveDirection.z);
    });
  }
});

describe('local facing round-trips through the wire encoding', () => {
  const cameraAzimuths = Array.from({ length: 72 }, (_, i) => (i * Math.PI) / 36); // every 5deg, full circle

  for (const azimuth of cameraAzimuths) {
    it(`camera@${Math.round((azimuth * 180) / Math.PI)}deg forward input faces the sent angle`, () => {
      const cameraForward = new Vector3(0, 0, -1).applyAxisAngle(UP, azimuth);
      const result = senderFrame(cameraForward, { x: 0, y: 1 });
      const decodedFacing = LOCAL_FORWARD.clone().applyAxisAngle(UP, rotationToYaw(result.sentFacingRotation));

      // Unlike sentDx/sentDz above, facing DOES go through a real (lossy)
      // encode/decode round trip - 256 discrete steps over 360deg, ~1.4deg
      // resolution - so this allows for that quantization, same tolerance
      // as compassRotation.test.ts's own round-trip test.
      expect(decodedFacing.x).toBeCloseTo(result.faceDirection.x, 1);
      expect(decodedFacing.z).toBeCloseTo(result.faceDirection.z, 1);
    });
  }
});
