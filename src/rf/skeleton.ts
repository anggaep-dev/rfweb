import { Bone, Quaternion, Skeleton, Vector3 } from 'three';
import { BinaryReader } from './BinaryReader';

const INVALID_NAME = 'NULL';

export interface RfBone {
  name: string;
  parentName: string;
  parentId: number;
  /** Transform relative to the parent bone (already three.js-space). */
  localPosition: Vector3;
  localRotation: Quaternion;
  localScale: Vector3;
}

export interface RfSkeleton {
  boneCount: number;
  bones: RfBone[];
  nameToId: Map<string, number>;
}

/**
 * Parses a .bn skeleton file. Bone "shape" collision geometry stored
 * alongside each bone is skipped (we only need the hierarchy + bind pose).
 */
export function parseSkeleton(buffer: ArrayBuffer): RfSkeleton {
  const r = new BinaryReader(buffer);
  const boneCount = r.u16();
  const bones: RfBone[] = [];
  const nameToId = new Map<string, number>();

  for (let i = 0; i < boneCount; i++) {
    const name = r.fixedString(100, 'ascii');
    const parentName = r.fixedString(100, 'ascii');
    nameToId.set(name, i);

    r.matrix4Raw(); // world/absolute matrix - unused, hierarchy is rebuilt from local matrices
    const localMatrix = r.matrix4Raw();
    r.matrix4Raw(); // parent-inverse matrix - unused

    const localPositionRaw = new Vector3();
    const localRotationRaw = new Quaternion();
    const localScale = new Vector3();
    localMatrix.decompose(localPositionRaw, localRotationRaw, localScale);

    const localPosition = new Vector3(-localPositionRaw.x, localPositionRaw.z, localPositionRaw.y);
    const localRotation = new Quaternion(
      -localRotationRaw.x,
      localRotationRaw.z,
      localRotationRaw.y,
      localRotationRaw.w,
    );

    const shapeVertexAmount = r.u16();
    const shapeFaceAmount = r.u16();
    const unknownAmount = r.u16();

    r.seek(204);
    r.seek(12); // hit box max
    r.seek(12); // hit box min
    r.seek(67);

    r.seek(shapeVertexAmount * 28); // vec3 vertex + 4 padding + vec3 normal

    r.seek(4); // leading face index
    r.seek(shapeFaceAmount * 88); // 2x u32 + 76 padding + trailing face index

    if (unknownAmount > 0) {
      r.seek(100 + 40 * unknownAmount);
    }

    bones.push({
      name,
      parentName,
      parentId: -1,
      localPosition,
      localRotation,
      localScale,
    });
  }

  for (const bone of bones) {
    bone.parentId = bone.parentName === INVALID_NAME ? -1 : (nameToId.get(bone.parentName) ?? -1);
  }

  return { boneCount, bones, nameToId };
}

export interface BuiltSkeleton {
  bones: Bone[];
  skeleton: Skeleton;
  root: Bone;
  nameToIndex: Map<string, number>;
}

/** Builds a three.js Bone hierarchy + Skeleton (bind pose) from parsed data. */
export function buildThreeSkeleton(rf: RfSkeleton): BuiltSkeleton {
  const bones = rf.bones.map((b) => {
    const bone = new Bone();
    bone.name = b.name;
    bone.position.copy(b.localPosition);
    bone.quaternion.copy(b.localRotation);
    bone.scale.copy(b.localScale);
    return bone;
  });

  let root: Bone | null = null;
  for (let i = 0; i < rf.bones.length; i++) {
    const parentId = rf.bones[i].parentId;
    if (parentId >= 0) {
      bones[parentId].add(bones[i]);
    } else if (!root) {
      root = bones[i];
    } else {
      // Multiple root-level bones: keep the scene graph single-rooted.
      root.add(bones[i]);
    }
  }

  if (!root) throw new Error('Skeleton has no root bone');
  root.updateMatrixWorld(true);

  const skeleton = new Skeleton(bones);
  const nameToIndex = new Map(rf.bones.map((b, i) => [b.name, i]));

  return { bones, skeleton, root, nameToIndex };
}
