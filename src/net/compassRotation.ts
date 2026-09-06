import { Vector3 } from 'three';

/**
 * The server's rotation encoding: 0-255, but only ever one of 8 discrete
 * 32-step compass values in practice (0=North/-Z, 32=NE, 64=East/+X, ...
 * 224=NW - see movement/system.go's directionToRotation on the backend,
 * which mints EntitySnapshot/EntityUpdate's rotation this way, and which
 * MovementInput's own facing field - see proto/protocol.proto - now uses
 * identically so the server can just trust it instead of re-deriving facing
 * from movement direction alone). rotationToYaw decodes it (for rendering
 * another player smoothly - see RemoteEntityController); quantizeToCompass/
 * facingToRotation encode it (for reporting the local player's own actual
 * movement/facing - see OnlineScene - now camera-relative and therefore a
 * continuous angle, not always already axis-aligned like the old fixed-
 * compass WASD scheme was).
 */

const COMPASS_ROTATION_BY_KEY: Record<string, number> = {
  '0,-1': 0, // North
  '1,-1': 32, // North-East
  '1,0': 64, // East
  '1,1': 96, // South-East
  '0,1': 128, // South
  '-1,1': 160, // South-West
  '-1,0': 192, // West
  '-1,-1': 224, // North-West
};

/** A component is "on" (-1 or 1) once it's past the 22.5° half-sector boundary of an 8-way compass rose - sin(22.5°). */
const COMPASS_AXIS_THRESHOLD = Math.sin(Math.PI / 8);

/**
 * Snaps a continuous world-space x/z direction down to the server's 8-way
 * compass (each axis independently -1/0/1) - movement/system.go's
 * directionToRotation (and its speed/position math) only ever expects one
 * of these 8 combinations, never an arbitrary angle. Used both for the
 * MovementInput dir_x/dir_z actually sent, and internally by
 * facingToRotation below.
 */
export function quantizeToCompass(x: number, z: number): [number, number] {
  const len = Math.hypot(x, z);
  if (len < 1e-6) return [0, 0];
  const nx = x / len;
  const nz = z / len;
  const dx = Math.abs(nx) > COMPASS_AXIS_THRESHOLD ? Math.sign(nx) : 0;
  const dz = Math.abs(nz) > COMPASS_AXIS_THRESHOLD ? Math.sign(nz) : 0;
  return [dx, dz];
}

/** Converts a compass rotation to a three.js Y-axis yaw such that the object's local forward (0,0,-1) ends up facing the same way. */
export function rotationToYaw(rotation: number): number {
  return -(rotation / 256) * Math.PI * 2;
}

/** Converts a world-space facing vector to the compass encoding, via quantizeToCompass - see its own doc comment for why this can't just round each axis independently once the caller's facing vector is a continuous (camera-relative) angle rather than already axis-aligned. */
export function facingToRotation(facing: Vector3): number {
  const [dx, dz] = quantizeToCompass(facing.x, facing.z);
  return COMPASS_ROTATION_BY_KEY[`${dx},${dz}`] ?? 0;
}

/**
 * Snaps `v`'s world-space XZ into `out` as a unit vector along one of the 8
 * compass directions, via quantizeToCompass - the exact same 8 directions
 * the wire ever carries (facingToRotation for facing, dir_x/dir_z for
 * movement). Used so a continuous (camera-relative) vector can be
 * classified locally against the *same* discrete direction a remote
 * observer will ever be able to reconstruct, instead of against its full
 * precision - see OnlineScene.classifyAgainstFacing's doc comment for why
 * that mismatch was silently misclassifying strafes on other clients while
 * looking correct locally. Leaves `out` untouched (returns false) if `v` is
 * ~zero, since there's no direction to snap to.
 */
export function quantizeDirectionVector(v: Vector3, out: Vector3): boolean {
  const [dx, dz] = quantizeToCompass(v.x, v.z);
  if (dx === 0 && dz === 0) return false;
  out.set(dx, 0, dz).normalize();
  return true;
}
