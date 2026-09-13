import { Matrix3, Matrix4, Vector3 } from 'three';
import { BinaryReader } from './BinaryReader';
import { convertMatrix } from './coords';

const INVALID_NAME = 'NULL';

/**
 * MESH08's per-vertex weight encoding stores only the first 3 (of up to 4)
 * bone weights explicitly - the 4th is implied as `1 - sum(first 3)` unless
 * that sum is already ~1. Matches the reference Blender addon's own
 * `WEIGHT_TOLERANCE` (`extra/cbb-rf-online-addon-main/cbb_rf_online_addon/
 * msh.py`) exactly - this project's MESH08 support was ported from that
 * addon's working reader, not reverse-engineered from scratch.
 */
const MESH08_WEIGHT_TOLERANCE = 1e-5;

export interface RfMeshObject {
  name: string;
  parentName: string;
  /** Vertex positions, three.js space, already baked into bind/world space when skinned. */
  vertices: Float32Array;
  normals: Float32Array;
  uvs: Float32Array; // uv, per vertex (flat/non-indexed)
  /** Per-vertex skin data, only present when the object carries weights. */
  skinBoneNames: string[][] | null;
  skinWeights: number[][] | null;
  texturePath: string;
  /**
   * This sub-object's placement, three.js space. Already baked into
   * `vertices`/`normals` when skinned (skinning needs bind-pose-space
   * vertices); left for the caller to apply otherwise (e.g. a rigid part
   * parented to a bone).
   */
  objectMatrix: Matrix4;
}

/**
 * Parses a .msh file - either the "default" variant most character part
 * meshes use, or the newer MESH08 variant (6-byte "MESH08" magic before the
 * object count) confirmed real on every real `*_COSTUMEARMOR_CLOAK_*`
 * (booster) mesh checked (all 20 race/tier combos in `GDBUSTER.RFS`) -
 * MESH08 is apparently what later content (boosters) shipped with, while
 * older armor/body-part meshes stay on the default format. A single file
 * can contain several sub-objects, and both variants can be mixed - each
 * object's own format is determined once, from the file's magic, not
 * per-object.
 *
 * Both variants share the exact same 693-byte common per-object header
 * (name/parent/matrix/vertexAmount-triangleAmount-weightAmount/texturePath/
 * .../the trailing 31-byte skip) - confirmed by the fact that MESH08's own
 * zero-vertex "dummy" socket objects (Dummy_Shield_L etc.) are spaced
 * exactly 699 bytes apart, i.e. the same 693-byte header plus MESH08's own
 * 3 extra always-present u16 counts (vertexAmount/triangleAmount/
 * boneGroupAmount, each 0 for a dummy) - see below. They diverge entirely
 * after that header: the default variant's own vertexAmount/triangleAmount/
 * weightAmount (read as part of the shared header) directly size its
 * vertex/triangle/weight sections; MESH08 re-reads its *own* vertex/
 * triangle/bone-group counts right after the header instead (the header's
 * own counts still get read - same byte offsets - but are only used for
 * `weightAmount > 0` gating, matching the reference addon's own "Only
 * useful for non MESH08 meshes" comment on `weightModelType`) and uses a
 * structurally different, indexed layout - see decodeMesh08Object below.
 * Ported from the reference Blender addon's own working reader (`extra/
 * cbb-rf-online-addon-main/cbb_rf_online_addon/msh.py`'s `CBB_OT_ImportMSH.
 * import_meshes`), not reverse-engineered from scratch - verified against
 * it byte-offset by byte-offset while cross-checking real GDBUSTER.RFS mesh
 * data (see docs/rf-format-notes.md's MESH08 section for the full trail).
 */
export function parseMesh(buffer: ArrayBuffer): RfMeshObject[] {
  const r = new BinaryReader(buffer);

  const magicBytes = new Uint8Array(buffer, 0, 6);
  const magicText = new TextDecoder('ascii').decode(magicBytes);
  const isMesh08 = magicText === 'MESH08';
  if (isMesh08) r.seek(6);

  const objectAmount = r.u16();
  const objects: RfMeshObject[] = [];

  for (let objectIndex = 0; objectIndex < objectAmount; objectIndex++) {
    const name = r.fixedString(100, 'euc-kr');
    const parentName = r.fixedString(100, 'euc-kr');

    const objectMatrix = convertMatrix(r.matrix4Raw());
    r.seek(128); // local matrix + a third, unused matrix

    const vertexAmount = r.u16();
    const triangleAmount = r.u16();
    const weightAmount = r.u16();

    const texturePath = r.fixedString(100, 'euc-kr');
    r.fixedString(100, 'euc-kr'); // effect path - unused

    r.vec3(); // bounding box max - unused
    r.vec3(); // bounding box min - unused
    r.vec3Raw(); // unknown float3 - unused
    r.u32();
    r.u32(); // unknown flags
    const weightModelType = r.u32();
    r.vec3Raw(); // unknown float3 - unused
    r.f32(); // unknown float - unused
    r.seek(31);

    const { baseVertices, triIndices, triNormals, triUvs, weightsByVertex } = isMesh08
      ? decodeMesh08Object(r, weightAmount)
      : decodeDefaultMeshObject(r, vertexAmount, triangleAmount, weightAmount, weightModelType);

    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const skinBoneNames: string[][] = [];
    const skinWeights: number[][] = [];
    const hasWeights = weightsByVertex.size > 0;

    for (let t = 0; t < triIndices.length; t++) {
      const tri = triIndices[t];
      for (let corner = 0; corner < 3; corner++) {
        const baseIndex = tri[corner];
        const base = baseVertices[baseIndex];
        vertices.push(...base.pos);
        normals.push(...triNormals[t][corner]);
        uvs.push(...triUvs[t][corner]);

        if (hasWeights) {
          const entry = weightsByVertex.get(baseIndex);
          const boneNames: string[] = [];
          const weightValues: number[] = [];
          if (entry) {
            for (let k = 0; k < entry.boneNames.length; k++) {
              if (entry.boneNames[k] !== INVALID_NAME) {
                boneNames.push(entry.boneNames[k]);
                weightValues.push(entry.weights[k]);
              }
            }
          }
          skinBoneNames.push(boneNames);
          skinWeights.push(weightValues);
        }
      }
    }

    // Skinning needs vertices in bind/world space; rigid (unweighted) parts
    // are left in local space for the caller to place relative to their parent.
    if (hasWeights) {
      const normalMatrix = new Matrix3().getNormalMatrix(objectMatrix);
      const v = new Vector3();
      const n = new Vector3();
      for (let i = 0; i < vertices.length; i += 3) {
        v.set(vertices[i], vertices[i + 1], vertices[i + 2]).applyMatrix4(objectMatrix);
        vertices[i] = v.x;
        vertices[i + 1] = v.y;
        vertices[i + 2] = v.z;

        n.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(normalMatrix).normalize();
        normals[i] = n.x;
        normals[i + 1] = n.y;
        normals[i + 2] = n.z;
      }
    }

    objects.push({
      name,
      parentName,
      vertices: new Float32Array(vertices),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      skinBoneNames: hasWeights ? skinBoneNames : null,
      skinWeights: hasWeights ? skinWeights : null,
      texturePath,
      objectMatrix,
    });
  }

  return objects;
}

interface DecodedMeshObjectData {
  baseVertices: { pos: [number, number, number]; normal: [number, number, number] }[];
  /** Vertex indices into `baseVertices`, one triple per triangle. */
  triIndices: [number, number, number][];
  /** Per-triangle-corner normals/UVs, parallel to `triIndices` (`[corner0, corner1, corner2]` per triangle) - the default format authors these per-corner (so a shared vertex can have a hard edge/UV seam); MESH08 only has them per-vertex, so decodeMesh08Object fans a vertex's one normal/UV out to every corner that references it. */
  triNormals: [number, number, number][][];
  triUvs: [number, number][][];
  weightsByVertex: Map<number, { boneNames: string[]; weights: number[] }>;
}

/** Reads one sub-object's vertex/triangle/weight sections in the "default" (non-MESH08) layout - the exact logic this function replaced, unchanged, just extracted so parseMesh can share its downstream per-corner-flattening/bind-space-baking code with decodeMesh08Object below. */
function decodeDefaultMeshObject(
  r: BinaryReader,
  vertexAmount: number,
  triangleAmount: number,
  weightAmount: number,
  weightModelType: number,
): DecodedMeshObjectData {
  const baseVertices: DecodedMeshObjectData['baseVertices'] = [];
  for (let i = 0; i < vertexAmount; i++) {
    const pos = r.vec3();
    r.seek(4);
    const normal = r.vec3();
    baseVertices.push({ pos: [pos.x, pos.y, pos.z], normal: [normal.x, normal.y, normal.z] });
  }

  const triIndices: DecodedMeshObjectData['triIndices'] = [];
  const triNormals: DecodedMeshObjectData['triNormals'] = [];
  const triUvs: DecodedMeshObjectData['triUvs'] = [];
  for (let i = 0; i < triangleAmount; i++) {
    const a = r.u32();
    const b = r.u32();
    const c = r.u32();
    triIndices.push([a, b, c]);

    const n0 = r.vec3();
    const n1 = r.vec3();
    const n2 = r.vec3();
    triNormals.push([
      [n0.x, n0.y, n0.z],
      [n1.x, n1.y, n1.z],
      [n2.x, n2.y, n2.z],
    ]);

    const readUv = (): [number, number] => {
      const u = r.f32();
      const v = r.f32();
      r.f32(); // padding
      // V is stored top-down (DirectX-style); CompressedTexture doesn't
      // auto-flip like a regular Texture does, so flip it here instead.
      return [u, 1 - v];
    };
    triUvs.push([readUv(), readUv(), readUv()]);
    r.seek(4);
  }

  const weightsByVertex: DecodedMeshObjectData['weightsByVertex'] = new Map();
  if (weightModelType === 1) {
    // The bone-count + bone-name table is part of this object's weight
    // *model* (weightModelType), not its weight *assignment count*
    // (weightAmount) - it's present even when weightAmount is 0 (an
    // object using the indexed model but with no actual per-vertex
    // weights, e.g. ACCRETIA_DEFAULT_UPPER_000.msh's 3rd sub-object).
    // Previously this was nested inside `weightAmount > 0`, so that case
    // silently skipped a real boneAmount field (0 bones, but still 4
    // bytes on disk), misaligning every subsequent read for the rest of
    // the file - the next sub-object's name/parent would come out empty
    // or garbled, cascading into "Offset is outside the bounds of the
    // DataView" once the corrupted counts got large enough to overrun.
    const boneAmount = r.u32();
    const boneNamesForAssignment: string[] = [];
    for (let i = 0; i < boneAmount; i++) boneNamesForAssignment.push(r.fixedString(100, 'euc-kr'));

    for (let i = 0; i < weightAmount; i++) {
      const vertexIndex = r.u32();
      r.u32(); // amount of weights - unused, zero-weight bone slots are marked with index -1 instead
      const boneIndices = [r.i32(), r.i32(), r.i32(), r.i32()];
      const w = [r.f32(), r.f32(), r.f32(), r.f32()];
      const boneNames = boneIndices.map((bi) => (bi !== -1 ? boneNamesForAssignment[bi] : INVALID_NAME));
      weightsByVertex.set(vertexIndex, { boneNames, weights: w });
    }
  } else if (weightAmount > 0) {
    for (let i = 0; i < weightAmount; i++) {
      const vertexIndex = r.u32();
      r.u32(); // amount of weights - unused
      const boneNames = [
        r.fixedString(100, 'euc-kr'),
        r.fixedString(100, 'euc-kr'),
        r.fixedString(100, 'euc-kr'),
        r.fixedString(100, 'euc-kr'),
      ];
      const w = [r.f32(), r.f32(), r.f32(), r.f32()];
      weightsByVertex.set(vertexIndex, { boneNames, weights: w });
    }
  }

  return { baseVertices, triIndices, triNormals, triUvs, weightsByVertex };
}

/**
 * Reads one sub-object's vertex/triangle/bone-group sections in the MESH08
 * layout - structurally unlike the default format: vertices carry their own
 * normal/UV/weight/bone-index data directly (no separate per-triangle
 * normal/UV arrays), and triangles are plain index triples into that vertex
 * list. Ported from the reference Blender addon's own working reader (see
 * parseMesh's own doc comment) - byte shapes and the specific quirks below
 * are its behavior, not independently reverse-engineered:
 *
 * - `weightAmount` (the *default*-format field also present in MESH08's own
 *   shared header, read by the caller) is reused here purely as a
 *   does-this-object-have-any-skinning boolean - MESH08 has no per-vertex
 *   weight *count*, every vertex always carries weight floats/bone indices
 *   inline, used only when this flag is set.
 * - A vertex's weight floats are only its first 3 values - the 4th is
 *   implied as `1 - sum(first 3)` (see MESH08_WEIGHT_TOLERANCE), unless
 *   that sum is already ~1 (then there simply isn't a 4th). Slots that
 *   round out to ~0 weight are dropped here (harmless - a 0-weight bone
 *   contributes nothing to skinning either way), rather than kept as
 *   `INVALID_NAME` placeholders the default format's own -1-sentinel
 *   convention uses - MESH08's bone indices are unsigned (no sentinel to
 *   even carry that meaning).
 * - The `triangleAmount` MESH08 re-reads after the vertex list is a total
 *   *index* count, not a triangle count - divide by 3 for the real
 *   triangle count (confirmed: the reference reader's own loop bound is
 *   `triangle_amount / 3`).
 * - Bone names resolve through a bone-*group* table (own section after the
 *   triangle indices): each group declares 1-4 real bone names padded to a
 *   fixed 4-slot/400-byte record, and a vertex's 4 bone indices index into
 *   the flattened, de-duplicated (first-seen-wins) list of every name
 *   across every group in file order - not a flat per-object bone table
 *   like the default format's `weightModelType === 1` case.
 * - UV's V is negated (`-v`), not flipped as `1 - v` like the default
 *   format's own DirectX-top-down correction - a different, MESH08-
 *   specific convention per the reference reader, not the same fix reused.
 */
function decodeMesh08Object(r: BinaryReader, weightAmount: number): DecodedMeshObjectData {
  const vertexAmount = r.u16();
  const baseVertices: DecodedMeshObjectData['baseVertices'] = [];
  const uvsByVertex: [number, number][] = [];
  const boneIndicesByVertex: [number, number, number, number][] = [];
  const resolvedWeightsByVertex: number[][] = [];

  for (let i = 0; i < vertexAmount; i++) {
    const pos = r.vec3();
    const w0 = r.f32();
    const w1 = r.f32();
    const w2 = r.f32();
    const bi0 = r.u16();
    const bi1 = r.u16();
    const bi2 = r.u16();
    const bi3 = r.u16();
    const normal = r.vec3();
    const u = r.f32();
    const v = r.f32();
    r.seek(12); // binormal(?) - unused

    baseVertices.push({ pos: [pos.x, pos.y, pos.z], normal: [normal.x, normal.y, normal.z] });
    uvsByVertex.push([u, -v]);
    boneIndicesByVertex.push([bi0, bi1, bi2, bi3]);

    if (weightAmount > 0) {
      const sum = w0 + w1 + w2;
      const weights = sum < 1 - MESH08_WEIGHT_TOLERANCE ? [w0, w1, w2, 1 - sum] : [w0, w1, w2, 0];
      resolvedWeightsByVertex.push(weights.reduce((a, b) => a + b, 0) < 1e-6 ? [1, 0, 0, 0] : weights);
    }
  }

  const triangleIndexCount = r.u16();
  const triIndices: DecodedMeshObjectData['triIndices'] = [];
  for (let i = 0; i < Math.floor(triangleIndexCount / 3); i++) {
    const a = r.u16();
    const b = r.u16();
    const c = r.u16();
    triIndices.push([a, b, c]);
  }

  const boneGroupAmount = r.u16();
  const uniqueBoneNames: string[] = [];
  for (let g = 0; g < boneGroupAmount; g++) {
    const groupBoneAmount = r.u32();
    for (let i = 0; i < groupBoneAmount; i++) {
      const boneName = r.fixedString(100, 'euc-kr');
      if (!uniqueBoneNames.includes(boneName)) uniqueBoneNames.push(boneName);
    }
    r.seek((4 - groupBoneAmount) * 100); // pad remaining slots up to the fixed 4-slot record
  }

  const weightsByVertex: DecodedMeshObjectData['weightsByVertex'] = new Map();
  if (weightAmount > 0) {
    for (let i = 0; i < vertexAmount; i++) {
      const weights = resolvedWeightsByVertex[i];
      const boneIndices = boneIndicesByVertex[i];
      const boneNames: string[] = [];
      const weightValues: number[] = [];
      for (let k = 0; k < weights.length; k++) {
        if (weights[k] > 1e-6) {
          boneNames.push(uniqueBoneNames[boneIndices[k]] ?? INVALID_NAME);
          weightValues.push(weights[k]);
        }
      }
      if (boneNames.length > 0) weightsByVertex.set(i, { boneNames, weights: weightValues });
    }
  }

  const triNormals: DecodedMeshObjectData['triNormals'] = triIndices.map((tri) => tri.map((idx) => baseVertices[idx].normal) as [number, number, number][]);
  const triUvs: DecodedMeshObjectData['triUvs'] = triIndices.map((tri) => tri.map((idx) => uvsByVertex[idx]) as [number, number][]);

  return { baseVertices, triIndices, triNormals, triUvs, weightsByVertex };
}
