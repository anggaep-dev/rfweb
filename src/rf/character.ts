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
import { findRfsEntry, parseRfs, readRfsEntry } from './rfs';
import type { RfsArchive } from './rfs';
import { buildThreeSkeleton, parseSkeleton } from './skeleton';
import type { BuiltSkeleton } from './skeleton';
import { decodeRftTexture } from './texture';

const ASSET_BASE = '/game-assets/character/player';

const MESH_PART_NAMES = ['FACE', 'GLOVES', 'HELMET', 'LOWER', 'SHOES', 'UPPER'] as const;

export const CLIP_NAMES = ['stand', 'walk', 'run', 'sit'] as const;

/**
 * Playable race/gender bodies, matching the client's RACEGENDER enum
 * (public/raw/include_client_resource.bt) - not to be confused with that
 * same file's separate, differently-scoped RaceGender (uint16, used inside
 * MODEL_ID for armor variants).
 */
export enum RaceGender {
  Bell_Male = 0,
  Bell_Female = 1,
  Cora_Male = 2,
  Cora_Female = 3,
  Accretia = 4,
}

interface RaceConfig {
  /** Filename prefix used throughout mesh/animation entries, e.g. "BELFEMALE". */
  nameToken: string;
  /** 2-letter code for the character/player/{Mesh,Tex}/DEFAULT{code}.RFS archives. */
  meshTexCode: string;
  /** 2-letter code for the character/player/Ani/{code}ETA.RFS archive (Accretia's differs from its mesh/tex code). */
  aniCode: string;
  /** Bone file stem under character/player/Bone/, exact on-disk casing. */
  boneFile: string;
}

const RACE_CONFIGS: Record<RaceGender, RaceConfig> = {
  [RaceGender.Bell_Male]: { nameToken: 'BELMALE', meshTexCode: 'BM', aniCode: 'BM', boneFile: 'BelMale' },
  [RaceGender.Bell_Female]: { nameToken: 'BELFEMALE', meshTexCode: 'BF', aniCode: 'BF', boneFile: 'BelFemale' },
  [RaceGender.Cora_Male]: { nameToken: 'CORMALE', meshTexCode: 'CM', aniCode: 'CM', boneFile: 'CorMale' },
  [RaceGender.Cora_Female]: { nameToken: 'CORFEMALE', meshTexCode: 'CF', aniCode: 'CF', boneFile: 'CorFemale' },
  [RaceGender.Accretia]: { nameToken: 'ACCRETIA', meshTexCode: 'AA', aniCode: 'AC', boneFile: 'Accretia' },
};

function animationFileNames(nameToken: string): Record<(typeof CLIP_NAMES)[number], string> {
  return {
    stand: `${nameToken}_PEACE_STAND_NONE_NONE_01_00.ANI`,
    walk: `${nameToken}_PEACE_WALK_NONE_NONE_01_00.ANI`,
    run: `${nameToken}_PEACE_RUN_NONE_NONE_01_00.ANI`,
    sit: `${nameToken}_COMMON_SIT_NONE_NONE_01_00.ANI`,
  };
}

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

async function fetchRfsArchive(url: string): Promise<RfsArchive> {
  return parseRfs(await fetchBuffer(url));
}

interface RaceAssets {
  skeletonBuffer: ArrayBuffer;
  meshArchive: RfsArchive;
  texArchive: RfsArchive;
  aniArchive: RfsArchive;
}

// Keyed by race so a preload (or a repeat visit to an already-loaded race)
// never re-fetches. In-flight promises are cached too, not just settled
// results, so two overlapping requests for the same not-yet-loaded race
// (e.g. preloadAllRaces() racing a user's manual race switch) share one
// fetch instead of doubling it up.
const raceAssetCache = new Map<RaceGender, Promise<RaceAssets>>();

function loadRaceAssets(raceGender: RaceGender, onFileLoaded?: () => void): Promise<RaceAssets> {
  const cached = raceAssetCache.get(raceGender);
  if (cached) return cached;

  const race = RACE_CONFIGS[raceGender];
  const trackedFetchBuffer = (url: string) =>
    fetchBuffer(url).then((buffer) => {
      onFileLoaded?.();
      return buffer;
    });
  const trackedFetchRfsArchive = (url: string) =>
    fetchRfsArchive(url).then((archive) => {
      onFileLoaded?.();
      return archive;
    });

  const promise = Promise.all([
    trackedFetchBuffer(`${ASSET_BASE}/Bone/${race.boneFile}.bn`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Mesh/DEFAULT${race.meshTexCode}.RFS`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Tex/DEFAULT${race.meshTexCode}.RFS`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Ani/${race.aniCode}ETA.RFS`),
  ]).then(([skeletonBuffer, meshArchive, texArchive, aniArchive]) => ({
    skeletonBuffer,
    meshArchive,
    texArchive,
    aniArchive,
  }));
  // Cache the promise up front (not after it resolves) so concurrent callers
  // join it instead of starting their own fetch; a failed load is evicted so
  // a later retry can actually try again rather than replaying the same rejection.
  raceAssetCache.set(raceGender, promise);
  promise.catch(() => raceAssetCache.delete(raceGender));
  return promise;
}

const ALL_RACES = Object.values(RaceGender).filter((v): v is RaceGender => typeof v === 'number');
const FILES_PER_RACE = 4;

/**
 * Fetches and caches every race's assets up front, so switching races later
 * never blocks on the network. Reports progress in units of "files fetched"
 * (4 per race: bone, mesh, tex, ani), not races, for a smoother readout.
 */
export async function preloadAllRaces(onProgress?: (loaded: number, total: number) => void): Promise<void> {
  const total = ALL_RACES.length * FILES_PER_RACE;
  let loaded = 0;
  onProgress?.(loaded, total);
  await Promise.all(
    ALL_RACES.map((race) =>
      loadRaceAssets(race, () => {
        loaded += 1;
        onProgress?.(loaded, total);
      }),
    ),
  );
}

/** Loads a race/gender's skeleton, default equipped mesh parts and base animation clips into a ready-to-render character. */
export async function loadCharacter(raceGender: RaceGender = RaceGender.Bell_Female): Promise<RfCharacter> {
  const race = RACE_CONFIGS[raceGender];
  const { skeletonBuffer, meshArchive, texArchive, aniArchive } = await loadRaceAssets(raceGender);

  const rfSkeleton = parseSkeleton(skeletonBuffer);
  const built = buildThreeSkeleton(rfSkeleton);

  const group = new Group();
  group.name = race.nameToken;
  group.add(built.root);

  for (const part of MESH_PART_NAMES) {
    const stem = `${race.nameToken}_DEFAULT_${part}_000`;

    const meshEntry = findRfsEntry(meshArchive, `${stem}.msh`);
    if (!meshEntry) {
      console.warn(`Skipping mesh part ${part}: no "${stem}.msh" entry in the Mesh archive`);
      continue;
    }
    const meshBuffer = readRfsEntry(meshArchive, meshEntry);

    const texEntry = findRfsEntry(texArchive, `${stem}.RFT`);
    let texture = null;
    if (texEntry) {
      try {
        texture = decodeRftTexture(readRfsEntry(texArchive, texEntry));
      } catch (err) {
        console.warn(`Texture decode failed for ${stem}:`, err);
      }
    }

    let objects;
    try {
      objects = parseMesh(meshBuffer);
    } catch (err) {
      console.warn(`Skipping mesh part ${part}: failed to parse "${stem}.msh" (entry size ${meshEntry.size} bytes):`, err);
      continue;
    }
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
  for (const [clipName, fileName] of Object.entries(animationFileNames(race.nameToken))) {
    const aniEntry = findRfsEntry(aniArchive, fileName);
    if (!aniEntry) {
      console.warn(`Skipping animation ${clipName}: no "${fileName}" entry in the Ani archive`);
      continue;
    }
    try {
      const buffer = readRfsEntry(aniArchive, aniEntry);
      clips[clipName] = buildAnimationClip(clipName, parseAnimation(buffer), bindPoseByBone);
    } catch (err) {
      console.warn(`Skipping animation ${clipName}:`, err);
    }
  }

  return { group, builtSkeleton: built, mixer, clips };
}
