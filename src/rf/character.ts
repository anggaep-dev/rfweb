import {
  AnimationClip,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
} from 'three';
import { buildAnimationClip, parseAnimation } from './animation';
import { parseMesh } from './mesh';
import type { RfMeshObject } from './mesh';
import { buildThreeSkeleton, parseSkeleton } from './skeleton';
import type { BuiltSkeleton } from './skeleton';
import { loadRftTexture } from './texture';

const ASSET_BASE = '/game-assets';

const MESH_PART_NAMES = ['FACE', 'GLOVES', 'HELMET', 'LOWER', 'SHOES', 'UPPER'] as const;

export const ANIMATION_FILES: Record<string, string> = {
  stand: 'BELFEMALE_PEACE_STAND_NONE_NONE_01_00.ANI',
  walk: 'BELFEMALE_PEACE_WALK_NONE_NONE_01_00.ANI',
  run: 'BELFEMALE_PEACE_RUN_NONE_NONE_01_00.ANI',
  sit: 'BELFEMALE_COMMON_SIT_NONE_NONE_01_00.ANI',
};

export interface RfCharacter {
  /** Add this to your scene. Keep its transform at identity - skin binding assumes it. */
  group: Group;
  builtSkeleton: BuiltSkeleton;
  mixer: AnimationMixer;
  clips: Record<string, AnimationClip>;
}

/**
 * A player character's persistent save-game record, as stored server-side
 * (account/currency/equip-slot/timestamp fields) - the data-model
 * counterpart to RfCharacter's render state above. Not wired into the
 * loader/renderer; kept here as the shared type for whenever that data is
 * fetched and needs displaying alongside the model.
 */
export interface PlayerCharacterData {
  Serial: number;
  DCK: boolean;
  Lock: number;
  Name: string;
  AccountSerial: number;
  Account: string;
  Slot: number;
  Race: number;
  Class: string;
  Lv: number;
  Dalant: number;
  Gold: number;
  EK0: number;
  EU0: number;
  EK1: number;
  EU1: number;
  EK2: number;
  EU2: number;
  EK3: number;
  EU3: number;
  EK4: number;
  EU4: number;
  EK5: number;
  EU5: number;
  EK6: number;
  EU6: number;
  EK7: number;
  EU7: number;
  LastConnTime: number;
  CreateTime: string;
  DeleteTime: string | null;
  DeleteName: string | null;
  FirstConnTime: string;
  HomeServer: string;
  Arrange: number;
  ES0: bigint;
  ET0: number;
  ES1: bigint;
  ET1: number;
  ES2: bigint;
  ET2: number;
  ES3: bigint;
  ET3: number;
  ES4: bigint;
  ET4: number;
  ES5: bigint;
  ET5: number;
  ES6: bigint;
  ET6: number;
  ES7: bigint;
  ET7: number;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

function buildSkinAttributes(meshObj: RfMeshObject, nameToIndex: Map<string, number>) {
  const vertexCount = meshObj.vertices.length / 3;
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    const names = meshObj.skinBoneNames![i];
    const weights = meshObj.skinWeights![i];
    const count = Math.min(4, names.length);
    let sum = 0;
    for (let k = 0; k < count; k++) sum += weights[k];

    for (let k = 0; k < count; k++) {
      skinIndices[i * 4 + k] = nameToIndex.get(names[k]) ?? 0;
      skinWeights[i * 4 + k] = sum > 0 ? weights[k] / sum : 0;
    }
  }
  return { skinIndices, skinWeights };
}

function buildGeometry(meshObj: RfMeshObject): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(meshObj.vertices, 3));
  geometry.setAttribute('normal', new BufferAttribute(meshObj.normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(meshObj.uvs, 2));
  return geometry;
}

/** Loads BelFemale's skeleton, equipped mesh parts and animation clips into a ready-to-render character. */
export async function loadCharacter(): Promise<RfCharacter> {
  const skeletonBuffer = await fetchBuffer(`${ASSET_BASE}/bone/BelFemale.bn`);
  const rfSkeleton = parseSkeleton(skeletonBuffer);
  const built = buildThreeSkeleton(rfSkeleton);

  const group = new Group();
  group.name = 'BelFemale';
  group.add(built.root);

  for (const part of MESH_PART_NAMES) {
    const stem = `BELFEMALE_DEFAULT_${part}_000`;

    let meshBuffer: ArrayBuffer;
    try {
      meshBuffer = await fetchBuffer(`${ASSET_BASE}/mesh/${stem}.msh`);
    } catch (err) {
      console.warn(`Skipping mesh part ${part}:`, err);
      continue;
    }

    const texture = await loadRftTexture(`${ASSET_BASE}/tex/${stem}.RFT`).catch((err) => {
      console.warn(`Texture load failed for ${stem}:`, err);
      return null;
    });

    const objects = parseMesh(meshBuffer);
    for (const obj of objects) {
      if (obj.vertices.length === 0) continue;

      const geometry = buildGeometry(obj);
      const material = new MeshStandardMaterial({
        map: texture ?? undefined,
        color: texture ? 0xffffff : 0xcccccc,
        side: DoubleSide,
      });

      if (obj.skinBoneNames && obj.skinWeights) {
        const { skinIndices, skinWeights } = buildSkinAttributes(obj, built.nameToIndex);
        geometry.setAttribute('skinIndex', new BufferAttribute(skinIndices, 4));
        geometry.setAttribute('skinWeight', new BufferAttribute(skinWeights, 4));

        const skinnedMesh = new SkinnedMesh(geometry, material);
        skinnedMesh.name = obj.name || `${stem}_${objects.indexOf(obj)}`;
        skinnedMesh.bind(built.skeleton);
        group.add(skinnedMesh);
      } else {
        // Rigid (unweighted) part: attach directly to its parent bone so it follows the pose.
        const mesh = new Mesh(geometry, material);
        mesh.name = obj.name || `${stem}_${objects.indexOf(obj)}`;

        const parentIndex = built.nameToIndex.get(obj.parentName);
        const parentBone = parentIndex !== undefined ? built.bones[parentIndex] : null;
        if (parentBone) {
          parentBone.updateMatrixWorld(true);
          const localMatrix = parentBone.matrixWorld.clone().invert().multiply(obj.objectMatrix);
          localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
          parentBone.add(mesh);
        } else {
          obj.objectMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
          group.add(mesh);
        }
      }
    }
  }

  const bindPoseByBone = new Map(
    rfSkeleton.bones.map((b) => [
      b.name,
      { position: b.localPosition, rotation: b.localRotation, scale: b.localScale },
    ]),
  );

  const mixer = new AnimationMixer(group);
  const clips: Record<string, AnimationClip> = {};
  for (const [clipName, fileName] of Object.entries(ANIMATION_FILES)) {
    try {
      const buffer = await fetchBuffer(`${ASSET_BASE}/ani/${fileName}`);
      clips[clipName] = buildAnimationClip(clipName, parseAnimation(buffer), bindPoseByBone);
    } catch (err) {
      console.warn(`Skipping animation ${clipName}:`, err);
    }
  }

  return { group, builtSkeleton: built, mixer, clips };
}
