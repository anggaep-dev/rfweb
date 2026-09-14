import { Vector3 } from 'three';
import { BinaryReader } from './BinaryReader';
import { convertVec3Unity } from './r3e';

/**
 * Parses a map's `.ebp` file's collision chunk (CFVertex/CFLine) - the same
 * native RF data the backend's own collision enforcement is built from (see
 * rfworld's internal/worldmap/collision.go, which the docs/map.md
 * `collision` field's vertex/line counts already summarize). Ported from
 * the reference Blender addon's own working importer (`ImportBSP.
 * import_bsp_from_files`'s EBP section in `extra/cbb-rf-online-addon-main/
 * cbb_rf_online_addon/bsp.py`, the same "000_COLLISION" mesh it builds for
 * visualization), not reverse-engineered from scratch.
 *
 * Scope: only CFVertex and CFLine (each collision wall's own start/end
 * point + height) - this parser deliberately does not read CFLineId/CFLeaf
 * (the server's own spatial partitioning of these lines for fast BVH-style
 * queries) or anything past the collision chunk (entity placement, sound
 * data - already covered by GET /map's own JSON fields); a flat "every wall
 * as one quad" debug render has no use for that partitioning.
 *
 * Like `.bsp` (see bsp.ts's own doc comment), a `.ebp`'s vertex data is
 * authored in the same Y-up, left-handed "Unity" space, not the Z-up 3ds Max
 * space `coords.ts` converts for `.msh`/`.bn`/`.ani` - `convertVec3Unity` is
 * reused as-is from r3e.ts.
 *
 * Binary, little-endian:
 * ```
 * u32  version                  (20 in every real file checked)
 * 18 × u32  header              (offset, size) pairs - only CFVertex (index
 *   0) and CFLine (index 2) are read here; everything else (CFLineId,
 *   CFLeaf, entity/sound chunks further in the file) is never looked at.
 * CFVertex × vec3f                     collision-line endpoints (Unity space)
 * CFLine   × { u32 attr, u16 startV, u16 endV, f32 height, u16 front,
 *              u16 back }              one 2D wall segment, 16 bytes each -
 *   attr/front/back (adjacent-leaf bookkeeping for the server's own spatial
 *   queries) are read past but not modeled.
 * ```
 */

const EBP_VERSION = 20;

/** 32-bit-word indices into the 18-entry header table for the (offset, size) pairs this parser actually needs. */
const HEADER_INDEX = {
  cfVertex: 0,
  cfLine: 2,
} as const;

export interface CollisionWall {
  start: Vector3;
  end: Vector3;
  /** Native RF units - see bakeAnimatedVertex-style axis note in buildCollisionWallsGeometry (map.ts) on which axis this actually extrudes along in three.js space. */
  height: number;
}

export interface EbpCollision {
  walls: CollisionWall[];
}

/** Parses an already-in-memory .ebp buffer's collision chunk into a flat list of wall segments. */
export function parseEbpCollision(buffer: ArrayBuffer): EbpCollision {
  const r = new BinaryReader(buffer);

  const version = r.u32();
  if (version !== EBP_VERSION) {
    console.warn(`EBP version ${version} differs from the only version (${EBP_VERSION}) this parser has been checked against`);
  }

  const header: number[] = new Array(18);
  for (let i = 0; i < 18; i++) header[i] = r.u32();
  const chunk = (index: number) => ({ offset: header[index], size: header[index + 1] });

  const vertexChunk = chunk(HEADER_INDEX.cfVertex);
  r.offset = vertexChunk.offset;
  const vertexCount = vertexChunk.size / 12;
  const vertices: Vector3[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i] = convertVec3Unity(r.f32(), r.f32(), r.f32());
  }

  const lineChunk = chunk(HEADER_INDEX.cfLine);
  r.offset = lineChunk.offset;
  const lineCount = lineChunk.size / 16;
  const walls: CollisionWall[] = [];
  for (let i = 0; i < lineCount; i++) {
    r.u32(); // attr - unused, see the module doc comment
    const startV = r.u16();
    const endV = r.u16();
    const height = r.f32();
    r.u16(); // front leaf - unused
    r.u16(); // back leaf - unused
    // Real Elan.ebp's CFLine index 0 is a degenerate (startV === endV, i.e.
    // zero-length) sentinel entry pointing at CFVertex index 0, which is
    // itself garbage (a suspiciously round ~-4.3e8 value on every axis - an
    // uninitialized-memory fill pattern from whatever tool wrote this file,
    // not a real map coordinate). Every other real entry has a genuine,
    // distinct start/end - skipping the zero-length case filters exactly
    // this placeholder without risking a false positive on some other
    // legitimately-zero-height real boundary line (height alone isn't a
    // safe filter; a real wall can apparently be zero-height, just not
    // zero-length).
    if (startV === endV) continue;
    walls.push({ start: vertices[startV], end: vertices[endV], height });
  }

  return { walls };
}
