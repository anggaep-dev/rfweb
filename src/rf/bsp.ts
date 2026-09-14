import { Quaternion, Vector3 } from 'three';
import { BinaryReader } from './BinaryReader';
import { convertVec3Unity, readQuatRaw } from './r3e';

/**
 * Parses a map's `.bsp` file - the native RF Online world-geometry format
 * (walls/terrain/buildings, one file per map, e.g. `resources/maps/Elan/
 * elan.bsp`). Ported from the reference Blender addon's own working
 * importer (`ImportBSP.import_bsp_from_files` in `extra/
 * cbb-rf-online-addon-main/cbb_rf_online_addon/bsp.py`), not
 * reverse-engineered from scratch - see that file for the full byte-level
 * derivation this was checked against, including the BSP tree (Node/Leaf)
 * and collision (CPlanes/CFaceId/MatListInLeaf) chunks this parser
 * deliberately does not read at all: those drive the addon's own debug
 * visualization and the reference exporter's re-encode, neither of which
 * this renderer-only parser needs - server-side collision is a separate,
 * already-existing concern (see docs/map.md's `collision` field, sourced
 * from the sibling `.ebp` file, not this one).
 *
 * Like `.R3E` (see r3e.ts's own doc comment), a `.bsp`'s vertex/animated-
 * object data is authored in the same Y-up, left-handed "Unity" space, not
 * the Z-up 3ds Max space `coords.ts` converts for `.msh`/`.bn`/`.ani` - the
 * reference addon reads both formats through the exact same
 * `CoordsSys.Unity -> CoordsSys.Blender` converter. `convertVec3Unity` is
 * reused as-is from r3e.ts rather than duplicated.
 *
 * Binary, little-endian:
 * ```
 * u32  version                  (39 in every real file checked)
 * 170 × u32  header             (offset, size) pairs into the rest of the
 *   file, by fixed index - only the pairs this parser actually reads are
 *   named below (see HEADER_INDEX); the rest (collision/BSP-tree chunks)
 *   are simply never looked at.
 * FVertex     × vec3f                 world-space positions (Unity space)
 * UV          × { f32 u, f32 v }      one entry per (face, corner) SLOT,
 *   not per vertex - addressed the same way as Face/VertexId below, not by
 *   the vertex id a slot happens to resolve to (verified against the
 *   reference addon's own post-hoc UV assignment loop, which indexes this
 *   array by a face's `vertexStartId + corner`, the exact same index used
 *   to look up VertexId, not by the vertex id VertexId itself resolves to)
 * Face        × { u16 vertexAmount, u32 vertexStartId }   one per polygon,
 *   `vertexStartId` indexing into VertexId/UV (see above)
 * FaceId      × u32             indirection from a MatGroup's face range
 *   into Face (distinct from the collision chunk's own similarly-named
 *   `CFaceId`, at a different header slot - not read here)
 * VertexId    × u32             indirection from a Face's vertex range
 *   into FVertex
 * Object      × 88-byte AnimatedObject record - identical layout to
 *   R3EAnimatedObject (see r3e.ts), reused verbatim
 * MatGroup    × 42-byte record: u16 attribute, u16 numberOfFaces,
 *   u32 startingFaceId, i16 materialId, i16 lightId, i16×3 bbMin,
 *   i16×3 bbMax, f32×3 position, f32 scale, u16 animatedObjectId
 * ```
 * `materialId` indexes the sibling `.r3m`'s own material array (r3m.ts);
 * that material's first texture layer's `textureId` indexes the sibling
 * `.r3t`'s texture dictionary (r3t.ts) - same two-file convention `.R3E`
 * particle entities use (see particleSystem.ts's `loadTextureFromR3mR3t`).
 * `lightId` (a second, separate `.r3t`-style lightmap dictionary, e.g.
 * `elanLgt.r3t`) is not modeled here - lightmapping is future work, same
 * scope cut the reference addon itself gates behind its own
 * `import_and_show_light_maps` toggle.
 */

const BSP_VERSION = 39;

/** 32-bit-word indices into the 170-entry header table for the (offset, size) pairs this parser actually needs - see the module doc comment for why every other pair (collision/BSP-tree chunks) is omitted. */
const HEADER_INDEX = {
  object: 10,
  fVertex: 90,
  uv: 94,
  face: 98,
  faceId: 100,
  vertexId: 102,
  matGroup: 104,
} as const;

interface FaceEntry {
  vertexAmount: number;
  vertexStartId: number;
}

interface MatGroupRecord {
  numberOfFaces: number;
  startingFaceId: number;
  materialId: number;
  lightId: number;
  animatedObjectId: number;
}

/**
 * A map object's animation-track bind pose - same 88-byte record and same
 * "bake bind pose into vertices, skip real keyframe playback" scope cut as
 * r3e.ts's R3EAnimatedObject (see that file's own doc comment for why: no
 * real sample file drives this path with `frames > 0` either). Kept
 * private to this module - unlike r3e.ts, nothing outside bsp.ts needs the
 * raw record once parseBsp has used it to bake BspGroup.vertices.
 */
interface BspAnimatedObject {
  bindScale: Vector3;
  bindPosition: Vector3;
  bindQuaternion: Quaternion;
}

export interface BspGroup {
  /** Indexes the sibling `.r3m`'s material array - see parseR3M/r3m.ts. */
  materialId: number;
  /** Flat, non-indexed - one entry per triangle corner (n-gon faces are fan-triangulated), same layout convention as r3e.ts's R3EGroup. Every MatGroup record sharing the same materialId is merged into one entry here (see parseBsp's own doc comment on why) - a real map's material groups vastly outnumber its distinct materials, and one draw call per material instead of per group is a real, not premature, optimization for a mesh this size. */
  vertices: Float32Array;
  uvs: Float32Array;
}

export interface BspMesh {
  /** One entry per distinct real (materialId !== -1) material referenced anywhere in the file - see BspGroup's own doc comment on the merge. */
  groups: BspGroup[];
}

function readFaces(r: BinaryReader, offset: number, size: number): FaceEntry[] {
  r.offset = offset;
  const count = size / 6;
  const faces: FaceEntry[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const vertexAmount = r.u16();
    const vertexStartId = r.u32();
    faces[i] = { vertexAmount, vertexStartId };
  }
  return faces;
}

function readU32Array(r: BinaryReader, offset: number, size: number): Uint32Array {
  r.offset = offset;
  const count = size / 4;
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = r.u32();
  return out;
}

function readMatGroups(r: BinaryReader, offset: number, size: number): MatGroupRecord[] {
  r.offset = offset;
  const count = size / 42;
  const groups: MatGroupRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    r.u16(); // attribute - unused
    const numberOfFaces = r.u16();
    const startingFaceId = r.u32();
    const materialId = r.i16();
    const lightId = r.i16();
    r.seek(12); // bbMin/bbMax (i16 x 3 each) - unused
    r.seek(12); // position (f32 x 3) - unused, MatGroup's own bounding info, not needed for rendering
    r.seek(4); // scale - unused (only meaningful together with the position above)
    const animatedObjectId = r.u16();
    groups[i] = { numberOfFaces, startingFaceId, materialId, lightId, animatedObjectId };
  }
  return groups;
}

/** Reads the Object chunk's AnimatedObject records - same 88-byte layout as r3e.ts's R3EAnimatedObject (see readQuatRaw's own doc comment), just narrowed to the 3 fields parseBsp's baking step actually uses. */
function readAnimatedObjects(r: BinaryReader, offset: number, size: number): BspAnimatedObject[] {
  r.offset = offset;
  const count = size / 88;
  const objects: BspAnimatedObject[] = new Array(count);
  for (let i = 0; i < count; i++) {
    r.seek(2 + 2 + 4 + 4 + 4 + 4); // flag, parent, frames, posCount, rotCount, scaleCount - unused (no keyframe playback, see the module doc comment)
    const bindScale = r.vec3Raw();
    r.seek(16); // scaleRot - unused
    const bindPositionRaw = r.vec3Raw();
    const bindQuaternionRaw = readQuatRaw(r);
    r.seek(4 + 4 + 4); // posOffset, rotOffset, scaleOffset - unused (into the Track chunk, not read at all here)
    objects[i] = {
      bindScale,
      // Converted here for the same reason r3e.ts's R3EAnimatedObject does -
      // see that file's own doc comment - so this composes correctly with
      // the already-converted per-vertex positions in bakeAnimatedVertex
      // below.
      bindPosition: convertVec3Unity(bindPositionRaw.x, bindPositionRaw.y, bindPositionRaw.z),
      bindQuaternion: convertVec3UnityQuat(bindQuaternionRaw),
    };
  }
  return objects;
}

/** Quaternion counterpart of convertVec3Unity ((x,y,z) -> (x,y,-z)) - negating a single axis of a quaternion's vector part is its own valid conjugate-style reflection, matching r3e.ts's convertQuatUnity in spirit (both derived by chaining the same addon-proven Unity->Blender step with the standard Blender->three.js step) but derived independently here since bsp.py's own AnimatedObject.quat, unlike R3E's, is read via the *raw*, unconverted `read_quaternion()` (see utils.py's Serializer) - so there is no reference addon behavior to match byte-for-byte here, only the same general "keep this internally consistent with the already-converted vertex data it's composed with" reasoning r3e.ts documents for its own bind-pose baking. */
function convertVec3UnityQuat(q: Quaternion): Quaternion {
  return new Quaternion(q.x, q.y, -q.z, q.w);
}

const tmpVertex = new Vector3();

/**
 * Bakes one animated map object's bind transform onto a vertex already in
 * final (converted) world space. BSP's FVertex pool is shared globally
 * across the whole map, so a vertex belonging to an animated sub-part is
 * stored pre-converted just like every static vertex - the reference addon
 * un-converts it back to local Unity space before applying the object's own
 * Blender-space transform (see bsp.py's `co_conv_blender_unity.
 * convert_vector3f` call). `convertVec3Unity` is its own inverse (negating
 * Z twice is a no-op), so the same function does both directions here.
 */
function bakeAnimatedVertex(vertex: Vector3, object: BspAnimatedObject): Vector3 {
  const local = convertVec3Unity(vertex.x, vertex.y, vertex.z, tmpVertex);
  return local.multiply(object.bindScale).applyQuaternion(object.bindQuaternion).add(object.bindPosition);
}

/** Parses an already-in-memory .bsp buffer into per-material triangle batches, ready to upload as one BufferGeometry each. */
export function parseBsp(buffer: ArrayBuffer): BspMesh {
  const r = new BinaryReader(buffer);

  const version = r.u32();
  if (version !== BSP_VERSION) {
    console.warn(`BSP version ${version} differs from the only version (${BSP_VERSION}) this parser has been checked against`);
  }

  const header: number[] = new Array(170);
  for (let i = 0; i < 170; i++) header[i] = r.u32();
  const chunk = (index: number) => ({ offset: header[index], size: header[index + 1] });

  const fVertexChunk = chunk(HEADER_INDEX.fVertex);
  r.offset = fVertexChunk.offset;
  const vertexCount = fVertexChunk.size / 12;
  const vertices: Vector3[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i] = convertVec3Unity(r.f32(), r.f32(), r.f32());
  }

  const uvChunk = chunk(HEADER_INDEX.uv);
  r.offset = uvChunk.offset;
  const uvCount = uvChunk.size / 8;
  const uvs: [number, number][] = new Array(uvCount);
  for (let i = 0; i < uvCount; i++) {
    const u = r.f32();
    const v = r.f32();
    uvs[i] = [u, 1 - v];
  }

  const faceChunk = chunk(HEADER_INDEX.face);
  const faces = readFaces(r, faceChunk.offset, faceChunk.size);

  const faceIdChunk = chunk(HEADER_INDEX.faceId);
  const faceIds = readU32Array(r, faceIdChunk.offset, faceIdChunk.size);

  const vertexIdChunk = chunk(HEADER_INDEX.vertexId);
  const vertexIds = readU32Array(r, vertexIdChunk.offset, vertexIdChunk.size);

  const matGroupChunk = chunk(HEADER_INDEX.matGroup);
  const matGroups = readMatGroups(r, matGroupChunk.offset, matGroupChunk.size);

  const objectChunk = chunk(HEADER_INDEX.object);
  const animatedObjects = readAnimatedObjects(r, objectChunk.offset, objectChunk.size);

  const byMaterial = new Map<number, { vertices: number[]; uvs: number[] }>();

  for (const matGroup of matGroups) {
    if (matGroup.materialId === -1) continue;

    const animatedObject = matGroup.animatedObjectId !== 0 ? animatedObjects[matGroup.animatedObjectId - 1] : undefined;

    let bucket = byMaterial.get(matGroup.materialId);
    if (!bucket) {
      bucket = { vertices: [], uvs: [] };
      byMaterial.set(matGroup.materialId, bucket);
    }

    for (let i = 0; i < matGroup.numberOfFaces; i++) {
      const face = faces[faceIds[matGroup.startingFaceId + i]];
      if (!face || face.vertexAmount < 3) continue;

      const cornerPositions: Vector3[] = new Array(face.vertexAmount);
      const cornerUvs: [number, number][] = new Array(face.vertexAmount);
      for (let slot = 0; slot < face.vertexAmount; slot++) {
        const slotIndex = face.vertexStartId + slot;
        const vertexIndex = vertexIds[slotIndex];
        let pos = vertices[vertexIndex];
        if (animatedObject) pos = bakeAnimatedVertex(pos, animatedObject).clone();
        cornerPositions[slot] = pos;
        cornerUvs[slot] = uvs[slotIndex];
      }

      // Fan-triangulate, then reverse each triangle's winding - matching
      // the reference addon's own `face_vertices.reverse()` for this exact
      // loop (bsp.py), which r3e.ts's own equivalent fan-triangulation does
      // NOT do for `.R3E` faces. Both formats share the same vertex
      // coordinate conversion, so this isn't compensating for that; the two
      // formats' raw face winding is simply authored differently.
      for (let k = 1; k < face.vertexAmount - 1; k++) {
        for (const cornerIndex of [k + 1, k, 0]) {
          const pos = cornerPositions[cornerIndex];
          bucket.vertices.push(pos.x, pos.y, pos.z);
          const uv = cornerUvs[cornerIndex];
          bucket.uvs.push(uv[0], uv[1]);
        }
      }
    }
  }

  const groups: BspGroup[] = [];
  for (const [materialId, bucket] of byMaterial) {
    if (bucket.vertices.length === 0) continue;
    groups.push({ materialId, vertices: new Float32Array(bucket.vertices), uvs: new Float32Array(bucket.uvs) });
  }

  return { groups };
}
