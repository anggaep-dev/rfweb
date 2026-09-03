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
 * Scope: this parses the *static* geometry only (vertices + UVs + faces,
 * triangulated) - vertex colors (VColor) and per-material animated
 * sub-objects/keyframe tracks (Object/Track chunks, for a mesh part that
 * moves independently within the entity) are present in the format but
 * not parsed here. Every real Chef/ particle mesh sampled while building
 * this appears to be simple decorative geometry (rings, orbs, blade
 * shapes) with no animated sub-parts, so this covers the actual use case;
 * revisit if a real file turns out to need them.
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
 * standard Blender->three.js one). Not used by the static-geometry parse
 * below (which has no rotated sub-parts), but exported for when
 * animated-object support is added.
 */
export function convertQuatUnity(x: number, y: number, z: number, w: number, out = new Quaternion()): Quaternion {
  return out.set(-x, -y, z, w);
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

export interface R3EMesh {
  /** Flat, non-indexed - one entry per triangle corner (n-gon faces are fan-triangulated), matching how this project's other parsed mesh formats are laid out (see mesh.ts's RfMeshObject). */
  vertices: Float32Array;
  uvs: Float32Array;
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

  // Object/Track chunks (per-material-group animated sub-parts) are
  // deliberately not read - see the module doc comment. Chunks are all
  // independently offset-addressable via the table above, so skipping
  // them doesn't misalign anything already parsed.

  // --- Flatten into triangles: only "static" groups (animatedObjectId 0) with a real material, fan-triangulating any n-gon faces ---
  const outVertices: number[] = [];
  const outUvs: number[] = [];
  for (const group of matGroups) {
    if (group.materialId === -1 || group.animatedObjectId !== 0) continue;

    for (let i = 0; i < group.numberOfFaces; i++) {
      const face = faces[faceIds[group.startingFaceId + i]];
      if (!face || face.vertexAmount < 3) continue;

      const cornerPositions: Vector3[] = [];
      const cornerUvs: [number, number][] = [];
      for (let j = 0; j < face.vertexAmount; j++) {
        const vertexIndex = vertexIds[face.vertexStartId + j];
        cornerPositions.push(vertices[vertexIndex]);
        cornerUvs.push(uvs[face.vertexStartId + j]);
      }

      for (let k = 1; k < face.vertexAmount - 1; k++) {
        for (const cornerIndex of [0, k, k + 1]) {
          const pos = cornerPositions[cornerIndex];
          outVertices.push(pos.x, pos.y, pos.z);
          const uv = cornerUvs[cornerIndex];
          outUvs.push(uv[0], uv[1]);
        }
      }
    }
  }

  return {
    vertices: new Float32Array(outVertices),
    uvs: new Float32Array(outUvs),
  };
}
