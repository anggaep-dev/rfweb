import type { CollisionWall } from './ebp';

/**
 * Client-side port of rfworld's internal/worldmap/collision.go
 * (CollisionMap.BlocksMovement/coversY/segmentIntersects/orientation/
 * onSegment) - the same 2D (X/Z) wall-segment-crossing test plus a per-wall
 * vertical window, checked at the same native-RF-unit scale the server uses
 * (see OnlineScene's own doc comment on why this client no longer applies
 * any other scale to server positions). Kept as an exact port - height<=0
 * walls skipped and all - rather than a "close enough" reimplementation:
 * CharacterController uses this to stop local prediction at a wall the
 * instant it's crossed, and any place this disagrees with the server's own
 * real check becomes a visible correction snap, not just a rounding
 * curiosity.
 */

/** Native units of vertical slack a wall's height window gets on each side - matches collision.go's collisionVerticalTolerance exactly. */
const COLLISION_VERTICAL_TOLERANCE = 64;
const EPSILON = 0.000001;

interface Point2 {
  x: number;
  z: number;
}

function coversY(wall: CollisionWall, y: number): boolean {
  const minY = Math.min(wall.start.y, wall.end.y) - COLLISION_VERTICAL_TOLERANCE;
  const maxY = Math.max(wall.start.y + wall.height, wall.end.y + wall.height) + COLLISION_VERTICAL_TOLERANCE;
  return y >= minY && y <= maxY;
}

function orientation(a: Point2, b: Point2, c: Point2): number {
  const v = (b.z - a.z) * (c.x - b.x) - (b.x - a.x) * (c.z - b.z);
  if (Math.abs(v) < EPSILON) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(a: Point2, b: Point2, c: Point2): boolean {
  return (
    b.x <= Math.max(a.x, c.x) + EPSILON &&
    b.x + EPSILON >= Math.min(a.x, c.x) &&
    b.z <= Math.max(a.z, c.z) + EPSILON &&
    b.z + EPSILON >= Math.min(a.z, c.z)
  );
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/** Whether moving from (oldX, oldZ) to (newX, newZ) at height newY crosses an active wall - see this module's own doc comment. */
export function blocksMovement(walls: CollisionWall[], oldX: number, oldZ: number, newX: number, newZ: number, newY: number): boolean {
  if (walls.length === 0) return false;
  if (oldX === newX && oldZ === newZ) return false;

  const moveA: Point2 = { x: oldX, z: oldZ };
  const moveB: Point2 = { x: newX, z: newZ };

  for (const wall of walls) {
    if (wall.height <= 0 || !coversY(wall, newY)) continue;
    const wallA: Point2 = { x: wall.start.x, z: wall.start.z };
    const wallB: Point2 = { x: wall.end.x, z: wall.end.z };
    if (segmentsIntersect(moveA, moveB, wallA, wallB)) return true;
  }
  return false;
}
