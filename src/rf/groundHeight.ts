import { Matrix3, Raycaster, Vector3 } from 'three';
import type { Box3, Intersection, Object3D } from 'three';

export type GroundQueryMode = 'movement' | 'spawn' | 'teleport';

export interface GroundHit {
  y: number;
  point: Vector3;
}

export interface GroundQueryOptions {
  mode: GroundQueryMode;
  referenceY: number;
  maxStepUp?: number;
  maxStepDown?: number;
}

const DOWN_AXIS = new Vector3(0, -1, 0);
const DEFAULT_RAYCAST_MARGIN = 500;
const DEFAULT_MOVEMENT_MAX_STEP_UP = 120;
const DEFAULT_MOVEMENT_MAX_STEP_DOWN = 180;
const MIN_UP_NORMAL_Y = 0.05;

/**
 * Stable map-height resolver for character render placement. The map mesh is
 * treated as the height source; .ebp/native collision remains responsible
 * for blocking horizontal movement.
 *
 * The important rule is "closest to a Y hint", not "first hit from the sky".
 * Real maps can have stacked surfaces at the same X/Z (bridges, roofs,
 * interior floors). During movement the current rendered Y is the hint and
 * large vertical jumps are rejected; during spawn/teleport the server/GM Y is
 * the hint and any nearby layer may be selected.
 */
export class GroundHeightProvider {
  private readonly mapObject3D: Object3D;
  private readonly bounds: Box3 | null;
  private readonly raycaster = new Raycaster();
  private readonly rayOrigin = new Vector3();
  private readonly normalMatrix = new Matrix3();
  private readonly normal = new Vector3();

  constructor(mapObject3D: Object3D, bounds: Box3 | null = null) {
    this.mapObject3D = mapObject3D;
    this.bounds = bounds;
  }

  getGroundAt(x: number, z: number, options: GroundQueryOptions): GroundHit | null {
    const referenceY = Number.isFinite(options.referenceY) ? options.referenceY : 0;
    const originY = this.bounds ? this.bounds.max.y + DEFAULT_RAYCAST_MARGIN : referenceY + DEFAULT_RAYCAST_MARGIN;
    this.rayOrigin.set(x, originY, z);
    this.raycaster.set(this.rayOrigin, DOWN_AXIS);
    if (this.bounds) this.raycaster.far = Math.max(DEFAULT_RAYCAST_MARGIN, this.bounds.max.y - this.bounds.min.y + DEFAULT_RAYCAST_MARGIN * 2);
    else this.raycaster.far = DEFAULT_RAYCAST_MARGIN * 4;

    const hits = this.raycaster.intersectObject(this.mapObject3D, true);
    let best: Intersection<Object3D> | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const hit of hits) {
      if (!this.isUsableGroundHit(hit)) continue;
      const dy = hit.point.y - referenceY;
      if (options.mode === 'movement') {
        const maxStepUp = options.maxStepUp ?? DEFAULT_MOVEMENT_MAX_STEP_UP;
        const maxStepDown = options.maxStepDown ?? DEFAULT_MOVEMENT_MAX_STEP_DOWN;
        if (dy > maxStepUp || -dy > maxStepDown) continue;
      }
      const score = Math.abs(dy);
      if (score < bestScore) {
        best = hit;
        bestScore = score;
      }
    }

    if (!best) return null;
    return { y: best.point.y, point: best.point.clone() };
  }

  applyToPosition(position: Vector3, options: GroundQueryOptions): boolean {
    const hit = this.getGroundAt(position.x, position.z, options);
    if (!hit) return false;
    position.y = hit.y;
    return true;
  }

  private isUsableGroundHit(hit: Intersection<Object3D>): boolean {
    if (!hit.face) return true;
    this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    this.normal.copy(hit.face.normal).applyMatrix3(this.normalMatrix).normalize();
    return this.normal.y >= MIN_UP_NORMAL_Y;
  }
}

/**
 * Backward-compatible helper for callers that only need a near-foot movement
 * query. New code should prefer GroundHeightProvider so spawn/teleport can
 * use the server Y as a layer hint.
 */
export function followGroundHeight(raycaster: Raycaster, position: Vector3, mapObject3D: Object3D | null): boolean {
  if (!mapObject3D) return false;
  const provider = new GroundHeightProvider(mapObject3D);
  void raycaster;
  return provider.applyToPosition(position, { mode: 'movement', referenceY: position.y });
}
