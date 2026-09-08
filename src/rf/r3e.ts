import { Quaternion, Vector3 } from 'three';
import { BinaryReader } from './BinaryReader';

/**
 * Parses `.R3E` particle-entity meshes (referenced by `.spt` particle
 * templates' `entity file` key - see docs/rf-format-notes.md's "Weapon/
 * armor glow & particle effects" section). Ported directly from the
 * reference Blender addon's working importer
 * (extra/cbb-rf-online-addon-main/cbb_rf_online_addon/r3e.py) - this
 * project had no independent documentation or hex-dump-derived
 * understanding of this format before that addon was pointed out; the
 * field layout and math below should match it field-for-field, not a
 * from-scratch reverse-engineering.
 *
 * Scope: geometry + per-group material id + animated-sub-part bind
 * transforms. VColor (per-vertex color) and the Track chunk's actual
 * keyframe data are parsed only as far as locating them (see
 * AnimatedObject) - real keyframe *playback* isn't implemented yet, since
 * no real Chef/ file sampled while building this has `frames > 0` on any
 * animated object to test against (every one has real geometry under a
 * nonzero animatedObjectId, just with `frames === 0` - i.e. a fixed
 * bind-pose "extra part," not something that actually plays back). A
 * group's bind-pose transform (position/rotation/scale) is still applied
 * to its vertices either way, so the part renders in the right place even
 * without animation - this fixes a real bug the previous version of this
 * file had (animated-object-id groups were skipped entirely, so any R3E
 * using one lost that geometry outright, not just its animation).
 */

const R3E_VERSION = 113;

/** CompHeader's vectorDataType: how the Vertex chunk's positions are packed. */
const VERTEX_FORMAT_BYTE = 0x8000;
const VERTEX_FORMAT_SHORT = 0x4000;
// Anything else (seen as 0 in every real file sampled) means plain float32 vec3s.

/**
 * R3E's source engine used a Y-up, left-handed authoring space (the
 * reference addon labels it "Unity", distinct from the Z-up, right-handed
 * 3ds Max space `coords.ts` converts for every other format in this
 * project - `.msh`/`.bn`/`.ani` all come from 3ds Max, `.R3E` doesn't).
 * Derived by chaining the addon's own proven Unity->Blender vector step
 * ((x,y,z) -> (x,z,y), no sign flips) with the standard Blender->three.js
 * step (both right-handed, so a plain rotation: (x,y,z) -> (x,z,-y)) -
 * which telescopes down to just negating Z, matching the well-known
 * "Unity is three.js/right-handed-Y-up with Z flipped" relationship
 * independent of this derivation. Kept separate from coords.ts's
 * `convertVec3`/`convertQuat` (3ds Max-specific) rather than merged with
 * them, since mixing the two would make it unclear which one a given call
 * site means.
 */
function convertVec3Unity(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, y, -z);
}

/**
 * Quaternion counterpart of convertVec3Unity, derived the same way
 * (chaining the addon's proven Unity->Blender quaternion step with the
 * standard Blender->three.js one).
 */
export function convertQuatUnity(x: number, y: number, z: number, w: number, out = new Quaternion()): Quaternion {
  return out.set(-x, -y, z, w);
}

/** Raw quaternion (XYZW), no coordinate conversion - same reasoning as BinaryReader.vec3Raw, just not on that shared class since every other format using it is 3ds-Max-space (see BinaryReader.quat) and this one isn't. */
function readQuatRaw(r: BinaryReader, out = new Quaternion()): Quaternion {
  const x = r.f32();
  const y = r.f32();
  const z = r.f32();
  const w = r.f32();
  return out.set(x, y, z, w);
}

interface ChunkRef {
  offset: number;
  size: number;
}

interface ChunkTable {
  compHeader: ChunkRef;
  vertex: ChunkRef;
  vColor: ChunkRef;
  uv: ChunkRef;
  face: ChunkRef;
  faceId: ChunkRef;
  vertexId: ChunkRef;
  matGroup: ChunkRef;
  object: ChunkRef;
  track: ChunkRef;
}

function readChunkTable(r: BinaryReader): ChunkTable {
  const chunk = (): ChunkRef => ({ offset: r.u32(), size: r.u32() });
  return {
    compHeader: chunk(),
    vertex: chunk(),
    vColor: chunk(),
    uv: chunk(),
    face: chunk(),
    faceId: chunk(),
    vertexId: chunk(),
    matGroup: chunk(),
    object: chunk(),
    track: chunk(),
  };
}

interface FaceEntry {
  vertexAmount: number;
  vertexStartId: number;
}

interface MaterialGroup {
  numberOfFaces: number;
  startingFaceId: number;
  materialId: number;
  animatedObjectId: number;
}

/**
 * One entry per Object chunk record - a sub-part's bind transform plus
 * where to find its keyframe tracks in the Track blob, if it has any (see
 * the module doc comment on why playback isn't implemented). `parent` is
 * 1-based (matching the reference addon's own indexing) into this same
 * array; 0 means "parented to the entity root," not to another animated
 * object.
 */
export interface R3EAnimatedObject {
  flag: number;
  parent: number;
  frames: number;
  posCount: number;
  rotCount: number;
  scaleCount: number;
  /** Bind scale - raw, not yet converted to three.js space (see the module doc comment on this file's overall stance on animated-object math being less battle-tested than the static path). */
  bindScale: Vector3;
  bindScaleRot: Quaternion;
  bindPosition: Vector3;
  bindQuaternion: Quaternion;
  /** Byte offsets into the sibling `track` buffer - see R3EMesh.track. Position keyframes are 16 bytes each (f32 frame + vec3f), rotation 20 bytes (f32 frame + quat XYZW), scale 32 bytes (f32 frame + vec3f + quat XYZW, a scale magnitude applied along an arbitrary rotated axis) - ported from the reference addon's own read sizes, not independently re-derived. */
  posOffset: number;
  rotOffset: number;
  scaleOffset: number;
}

export interface R3EGroup {
  /** -1 groups (no material - not rendered) are already excluded from R3EMesh.groups entirely. */
  materialId: number;
  /** Non-zero for a bind-pose-baked sub-part (see R3EMesh.animatedObjects[animatedObjectId - 1]) - 0 means this group is part of the entity's static/root geometry. */
  animatedObjectId: number;
  /** Flat, non-indexed - one entry per triangle corner (n-gon faces are fan-triangulated), matching how this project's other parsed mesh formats are laid out (see mesh.ts's RfMeshObject). Already includes the group's own bind-pose transform if animatedObjectId is nonzero - see the module doc comment. */
  vertices: Float32Array;
  uvs: Float32Array;
}

export interface R3EMesh {
  /** One entry per real (materialId !== -1) MatGroup, in file order - static and bind-pose-baked-animated groups alike (see R3EGroup). */
  groups: R3EGroup[];
  /** Every group's vertices concatenated, ignoring materialId - the flattened shape every caller used before per-group data existed (see particleSystem.ts). Prefer `groups` for anything that needs to render different parts with different materials. */
  vertices: Float32Array;
  uvs: Float32Array;
  /** Sub-part bind transforms/keyframe-track locations, 0-indexed here (R3EGroup.animatedObjectId is 1-based, matching the reference addon - subtract 1 to index into this array) - empty for the common case of a simple decorative shape with no animated parts. */
  animatedObjects: R3EAnimatedObject[];
}

/** Parses an already-in-memory .R3E buffer into flat, ready-to-upload triangle data. */
export function parseR3E(buffer: ArrayBuffer): R3EMesh {
  const r = new BinaryReader(buffer);

  const version = r.u32();
  r.u32(); // "identity" field - unused by the reference importer too

  if (version !== R3E_VERSION) {
    console.warn(`R3E version ${version} differs from the only version (${R3E_VERSION}) this parser has been checked against`);
  }

  const table = readChunkTable(r);

  // --- CompHeader: vertex compression mode + the decompression reference point/scale/uv range ---
  r.offset = table.compHeader.offset;
  const vectorDataType = r.u16();
  r.seek(12); // reserved
  const refPos = r.vec3Raw(); // decompression reference point - RAW (pre-conversion) space, matching the compressed vertex bytes it's combined with below
  const refScale = r.f32();
  const uvMin = r.f32();
  const uvMax = r.f32();
  const uvScale = (uvMax - uvMin) / 2;
  const uvPos = uvMin + uvScale;

  // --- Vertex ---
  r.offset = table.vertex.offset;
  const vertices: Vector3[] = [];
  if (vectorDataType === VERTEX_FORMAT_BYTE) {
    const count = table.vertex.size / 3;
    for (let i = 0; i < count; i++) {
      const x = (r.i8() / 127) * refScale + refPos.x;
      const y = (r.i8() / 127) * refScale + refPos.y;
      const z = (r.i8() / 127) * refScale + refPos.z;
      vertices.push(convertVec3Unity(x, y, z));
    }
  } else if (vectorDataType === VERTEX_FORMAT_SHORT) {
    const count = table.vertex.size / 6;
    for (let i = 0; i < count; i++) {
      const x = (r.i16() / 32767) * refScale + refPos.x;
      const y = (r.i16() / 32767) * refScale + refPos.y;
      const z = (r.i16() / 32767) * refScale + refPos.z;
      vertices.push(convertVec3Unity(x, y, z));
    }
  } else {
    const count = table.vertex.size / 12;
    for (let i = 0; i < count; i++) {
      const x = r.f32();
      const y = r.f32();
      const z = r.f32();
      vertices.push(convertVec3Unity(x, y, z));
    }
  }

  // --- UV ---
  r.offset = table.uv.offset;
  const uvCount = table.uv.size / 4;
  const uvs: [number, number][] = [];
  for (let i = 0; i < uvCount; i++) {
    const u = (r.i16() / 32767) * uvScale + uvPos;
    const v = (r.i16() / 32767) * uvScale + uvPos;
    // V is stored top-down (DirectX-style), same convention mesh.ts already flips for character textures.
    uvs.push([u, 1 - v]);
  }

  // --- Face: (vertexAmount, vertexStartId) per polygon, not yet triangles ---
  r.offset = table.face.offset;
  const faceCount = table.face.size / 6;
  const faces: FaceEntry[] = [];
  for (let i = 0; i < faceCount; i++) {
    const vertexAmount = r.u16();
    const vertexStartId = r.u32();
    faces.push({ vertexAmount, vertexStartId });
  }

  // --- FaceId: indirection from a material group's face range into `faces` ---
  r.offset = table.faceId.offset;
  const faceIdCount = table.faceId.size / 2;
  const faceIds: number[] = [];
  for (let i = 0; i < faceIdCount; i++) faceIds.push(r.u16());

  // --- VertexId: indirection from a face's vertex range into `vertices` ---
  r.offset = table.vertexId.offset;
  const vertexIdCount = table.vertexId.size / 2;
  const vertexIds: number[] = [];
  for (let i = 0; i < vertexIdCount; i++) vertexIds.push(r.u16());

  // --- MatGroup ---
  r.offset = table.matGroup.offset;
  const matGroupCount = table.matGroup.size / 22;
  const matGroups: MaterialGroup[] = [];
  for (let i = 0; i < matGroupCount; i++) {
    const numberOfFaces = r.u16();
    const startingFaceId = r.u32();
    const materialId = r.i16();
    const animatedObjectId = r.u16();
    r.seek(12); // bounding box min/max (3x i16 each) - unused
    matGroups.push({ numberOfFaces, startingFaceId, materialId, animatedObjectId });
  }

  // --- Object: sub-part bind transforms + where their keyframe tracks (if any) live in the Track blob ---
  r.offset = table.object.offset;
  const objectCount = table.object.size / 88;
  const animatedObjects: R3EAnimatedObject[] = [];
  for (let i = 0; i < objectCount; i++) {
    const flag = r.u16();
    const parent = r.u16();
    const frames = r.i32();
    const posCount = r.i32();
    const rotCount = r.i32();
    const scaleCount = r.i32();
    const bindScale = r.vec3Raw();
    const bindScaleRot = readQuatRaw(r);
    const bindPositionRaw = r.vec3Raw();
    const bindQuaternionRaw = readQuatRaw(r);
    const posOffset = r.u32();
    const rotOffset = r.u32();
    const scaleOffset = r.u32();
    animatedObjects.push({
      flag,
      parent,
      frames,
      posCount,
      rotCount,
      scaleCount,
      bindScale,
      bindScaleRot,
      // Converted here (unlike the reference addon, which assigns these raw
      // to a Blender object's transform without going through its own
      // Unity->Blender step for this specific field - see the module doc
      // comment on why this file doesn't treat that part of the reference
      // as fully trustworthy) so composing them with this file's
      // already-converted vertex positions below is internally consistent.
      bindPosition: convertVec3Unity(bindPositionRaw.x, bindPositionRaw.y, bindPositionRaw.z),
      bindQuaternion: convertQuatUnity(bindQuaternionRaw.x, bindQuaternionRaw.y, bindQuaternionRaw.z, bindQuaternionRaw.w),
      posOffset,
      rotOffset,
      scaleOffset,
    });
  }

  // Track chunk (raw keyframe bytes, sliced per-object via the offsets
  // above) is intentionally not read here - see the module doc comment on
  // why playback isn't implemented yet.

  // --- Flatten each real (materialId !== -1) group into its own triangle list, fan-triangulating any n-gon faces. A nonzero animatedObjectId group gets its bind-pose transform baked into its vertices right here. ---
  const groups: R3EGroup[] = [];
  const allVertices: number[] = [];
  const allUvs: number[] = [];

  for (const matGroup of matGroups) {
    if (matGroup.materialId === -1) continue;

    const animatedObject = matGroup.animatedObjectId !== 0 ? animatedObjects[matGroup.animatedObjectId - 1] : null;

    const groupVertices: number[] = [];
    const groupUvs: number[] = [];
    for (let i = 0; i < matGroup.numberOfFaces; i++) {
      const face = faces[faceIds[matGroup.startingFaceId + i]];
      if (!face || face.vertexAmount < 3) continue;

      const cornerPositions: Vector3[] = [];
      const cornerUvs: [number, number][] = [];
      for (let j = 0; j < face.vertexAmount; j++) {
        const vertexIndex = vertexIds[face.vertexStartId + j];
        let pos = vertices[vertexIndex];
        if (animatedObject) {
          pos = pos
            .clone()
            .multiply(animatedObject.bindScale)
            .applyQuaternion(animatedObject.bindQuaternion)
            .add(animatedObject.bindPosition);
        }
        cornerPositions.push(pos);
        cornerUvs.push(uvs[face.vertexStartId + j]);
      }

      for (let k = 1; k < face.vertexAmount - 1; k++) {
        for (const cornerIndex of [0, k, k + 1]) {
          const pos = cornerPositions[cornerIndex];
          groupVertices.push(pos.x, pos.y, pos.z);
          const uv = cornerUvs[cornerIndex];
          groupUvs.push(uv[0], uv[1]);
        }
      }
    }

    groups.push({
      materialId: matGroup.materialId,
      animatedObjectId: matGroup.animatedObjectId,
      vertices: new Float32Array(groupVertices),
      uvs: new Float32Array(groupUvs),
    });
    allVertices.push(...groupVertices);
    allUvs.push(...groupUvs);
  }

  return {
    groups,
    vertices: new Float32Array(allVertices),
    uvs: new Float32Array(allUvs),
    animatedObjects,
  };
}
