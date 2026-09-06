import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { facingToRotation, quantizeDirectionVector, quantizeToCompass, rotationToYaw } from '../net/compassRotation';
import { classifyLocomotionDirectionStable, classifyMovementAgainstFacing } from '../rf/character';
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
 */

interface SenderState {
  facing: Vector3;
  lastInputLocomotionDirection: LocomotionDirection | null;
  lastLocomotionDirection: LocomotionDirection | null;
}

function freshSenderState(): SenderState {
  return { facing: new Vector3(0, 0, -1), lastInputLocomotionDirection: null, lastLocomotionDirection: null };
}

/** Mirrors OnlineScene's per-frame sender pipeline: updateMoveDirectionFromCamera -> quantizeMoveDirection -> updateFacing -> classifyAgainstFacing -> the values reportMovementIfChanged would send. See those methods' own doc comments in OnlineScene.ts for the algorithm this reproduces. */
function senderFrame(
  state: SenderState,
  cameraForward: Vector3,
  input: { x: number; y: number },
): { localLocomotionDirection: LocomotionDirection | null; sentDx: number; sentDz: number; sentFacingRotation: number } {
  const cameraRight = new Vector3().crossVectors(cameraForward, UP).normalize();
  const moveDirection = new Vector3().addScaledVector(cameraForward, input.y).addScaledVector(cameraRight, input.x);
  if (moveDirection.lengthSq() > 1e-8) moveDirection.normalize();

  const quantizedMoveDirection = new Vector3();
  if (!quantizeDirectionVector(moveDirection, quantizedMoveDirection)) quantizedMoveDirection.copy(moveDirection);

  const inputLocomotionDirection = classifyLocomotionDirectionStable(input.x, input.y, state.lastInputLocomotionDirection);
  state.lastInputLocomotionDirection = inputLocomotionDirection;
  if (!inputLocomotionDirection) state.facing.copy(quantizedMoveDirection);

  const quantizedFacing = new Vector3();
  quantizeDirectionVector(state.facing, quantizedFacing);
  const scratch = new Vector3();
  const localLocomotionDirection = classifyMovementAgainstFacing(
    quantizedMoveDirection,
    quantizedFacing,
    state.lastLocomotionDirection,
    scratch,
    UP,
  );
  state.lastLocomotionDirection = localLocomotionDirection;

  const [sentDx, sentDz] = quantizeToCompass(moveDirection.x, moveDirection.z);
  const sentFacingRotation = facingToRotation(state.facing);
  return { localLocomotionDirection, sentDx, sentDz, sentFacingRotation };
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
  const moveDirection = new Vector3(sentDx / len, 0, sentDz / len);
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
        const sender = freshSenderState();

        // Establish a stable facing by holding plain forward first, same as
        // a real player who was already walking before this input started -
        // classification is only meaningful once facing is grid-aligned.
        senderFrame(sender, cameraForward, { x: 0, y: 1 });
        senderFrame(sender, cameraForward, { x: 0, y: 1 });

        let local: LocomotionDirection | null = null;
        let remote: LocomotionDirection | null = null;
        for (let frame = 0; frame < 5; frame++) {
          const result = senderFrame(sender, cameraForward, input);
          local = result.localLocomotionDirection;
          remote = receiverClassify(result.sentDx, result.sentDz, result.sentFacingRotation, remote);
        }

        expect(remote).toBe(local);
      });
    }
  }
});
