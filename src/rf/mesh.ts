import { Matrix3, Matrix4, Vector3 } from 'three';
import { BinaryReader } from './BinaryReader';
import { convertMatrix } from './coords';

const INVALID_NAME = 'NULL';

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
 * Parses a .msh file (the "default", non-MESH08 variant used by these
 * character part meshes). A single file can contain several sub-objects.
 */
export function parseMesh(buffer: ArrayBuffer): RfMeshObject[] {
  const r = new BinaryReader(buffer);

  const magicBytes = new Uint8Array(buffer, 0, 6);
  const magicText = new TextDecoder('ascii').decode(magicBytes);
  const isMesh08 = magicText === 'MESH08';
  if (isMesh08) {
    throw new Error('MESH08 mesh format is not supported yet');
  }

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

    const baseVertices: { pos: [number, number, number]; normal: [number, number, number] }[] = [];
    for (let i = 0; i < vertexAmount; i++) {
      const pos = r.vec3();
      r.seek(4);
      const normal = r.vec3();
      baseVertices.push({ pos: [pos.x, pos.y, pos.z], normal: [normal.x, normal.y, normal.z] });
    }

    const triIndices: [number, number, number][] = [];
    const triNormals: [number, number, number][][] = [];
    const triUvs: [number, number][][] = [];
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

    const weightsByVertex = new Map<number, { boneNames: string[]; weights: number[] }>();
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
