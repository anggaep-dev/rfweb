import { Vector3 } from 'three';

/**
 * The server's rotation encoding: 0-255, but only ever one of 8 discrete
 * 32-step compass values in practice (0=North/-Z, 32=NE, 64=East/+X, ...
 * 224=NW - see movement/system.go's directionToRotation on the backend,
 * which mints EntitySnapshot/EntityUpdate's rotation this way, and which
 * MovementInput's own facing field - see proto/protocol.proto - now uses
 * identically so the server can just trust it instead of re-deriving facing
 * from movement direction alone). rotationToYaw decodes it (for rendering
 * another player smoothly - see RemoteEntityController); facingToRotation
 * encodes it (for reporting the local player's own actual facing, which
 * isn't always the same as its movement direction - see OnlineScene).
 */

/** Converts a compass rotation to a three.js Y-axis yaw such that the object's local forward (0,0,-1) ends up facing the same way. */
export function rotationToYaw(rotation: number): number {
  return -(rotation / 256) * Math.PI * 2;
}

/**
 * Converts a world-space facing vector back to the compass encoding -
 * mirrors movement/system.go's directionToRotation exactly (same 8-way
 * mapping), but works off the vector's own signs rather than a raw dx/dz
 * pair, since callers always have an already-compass-aligned facing vector
 * (never an arbitrary continuous angle - see OnlineScene's `facing` field).
 */
export function facingToRotation(facing: Vector3): number {
  const dx = Math.sign(Math.round(facing.x));
  const dz = Math.sign(Math.round(facing.z));
  if (dx === 0 && dz < 0) return 0; // North
  if (dx > 0 && dz < 0) return 32; // North-East
  if (dx > 0 && dz === 0) return 64; // East
  if (dx > 0 && dz > 0) return 96; // South-East
  if (dx === 0 && dz > 0) return 128; // South
  if (dx < 0 && dz > 0) return 160; // South-West
  if (dx < 0 && dz === 0) return 192; // West
  if (dx < 0 && dz < 0) return 224; // North-West
  return 0;
}
