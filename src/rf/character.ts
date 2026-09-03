import {
  AnimationClip,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
} from 'three';
import type { Texture } from 'three';
import { buildAnimationClip, parseAnimation } from './animation';
import type { BindPose } from './animation';
import { parseMesh } from './mesh';
import type { RfMeshObject } from './mesh';
import { resolveWeaponMesh } from './resource';
import type { WeaponMeshInfo } from './resource';
import { findRfsEntry, parseRfs, readRfsEntry } from './rfs';
import type { RfsArchive, RfsEntry } from './rfs';
import { buildThreeSkeleton, parseSkeleton } from './skeleton';
import type { BuiltSkeleton, RfSkeleton } from './skeleton';
import { decodeRftTexture } from './texture';

const ASSET_BASE = '/game-assets/character/player';
// SkinnedMesh.bind() only ever reads from the bindMatrix it's given (copies
// out of it, never writes into it), so this one instance is safe to reuse
// across every skinned part - see the comment at its call site below.
const IDENTITY_MATRIX = new Matrix4();

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

export interface RaceAssets {
  skeletonBuffer: ArrayBuffer;
  meshArchive: RfsArchive;
  texArchive: RfsArchive;
  aniArchive: RfsArchive;
  /** Per-weapon-category combat walk/run/stand clips (character/player/Ani/{race}COA.RFS) - see getWeaponClip(). */
  weaponAniArchive: RfsArchive;
}

/**
 * Builds the ready-to-attach three.js object(s) from an already-parsed set
 * of mesh sub-objects - geometry, material/texture, and either a skinned
 * mesh bound to the given skeleton or a rigid mesh already parented to its
 * bone (by name, looked up in `built`). Shared by every mesh source: the
 * initial default body, a body-part item equip, and a weapon equip (see
 * buildMeshPartObjects and loadWeaponMeshObjects below) - all go through
 * identical mesh-building logic. Rigid parts with a matching bone are
 * already attached to it on return; anything still parentless (skinned
 * meshes, or a rigid part whose bone wasn't found) is the caller's to add.
 */
function buildObjectsFromParsedMesh(
  objects: RfMeshObject[],
  texture: Texture | null,
  built: BuiltSkeleton,
  namePrefix: string,
  // The skeleton a rigid part's objectMatrix is actually expressed
  // relative to, for computing its local offset from its parent bone -
  // normally the same as `built` (a body part is authored against the
  // exact race skeleton it's equipped onto), but weapons are authored
  // against one fixed reference skeleton regardless of who wields them
  // (see loadWeaponMeshObjects), so that case passes a different one here.
  // Only matters for rigid (unweighted) objects; skinned meshes always
  // bind to `built` itself.
  rigidReference: BuiltSkeleton = built,
): Object3D[] {
  const built3d: Object3D[] = [];
  // Some multi-part meshes chain a piece's parentName to *another
  // sub-object in this same file* instead of (or in addition to - via a
  // longer chain) a skeleton bone - e.g. a staff's ornamental head parented
  // to its own stick object, itself parented to the hand bone. Verified
  // against real weapon meshes (BELCOR_WEAPON_TSTAFF_135.msh's W02→W00→
  // W01→"Bip01 R Finger0" chain): without resolving these, the head fell
  // through to the "no parent found" case below, got added directly under
  // the character's root instead of the stick, and visibly separated from
  // it the instant the wielding bone animated (the stick correctly follows
  // the bone; the head, parented to the static root, doesn't move at all).
  // File order is parent-before-child in every real example seen, so a
  // single forward pass recording each processed object's own name here is
  // enough - no second pass/topological sort needed.
  const siblingsByName = new Map<string, { object3D: Object3D; objectMatrix: Matrix4 }>();

  for (const obj of objects) {
    if (obj.vertices.length === 0) continue;

    const geometry = buildGeometry(obj);
    const material = new MeshStandardMaterial({
      map: texture ?? undefined,
      color: texture ? 0xffffff : 0xcccccc,
      side: DoubleSide,
    });

    let builtObject: Object3D;

    if (obj.skinBoneNames && obj.skinWeights) {
      const { skinIndices, skinWeights } = buildSkinAttributes(obj, built.nameToIndex);
      geometry.setAttribute('skinIndex', new BufferAttribute(skinIndices, 4));
      geometry.setAttribute('skinWeight', new BufferAttribute(skinWeights, 4));

      const skinnedMesh = new SkinnedMesh(geometry, material);
      skinnedMesh.name = obj.name || `${namePrefix}_${objects.indexOf(obj)}`;
      // SkinnedMesh.bind(skeleton) with no explicit bindMatrix calls
      // skeleton.calculateInverses() internally, recomputing boneInverses
      // from the bones' *current* world matrices - and Skeleton is one
      // object shared by every body-part mesh, so that silently corrupts
      // the bind pose for every already-equipped part too, not just this
      // one. Harmless at initial load (nothing has animated yet, so
      // "current" happens to equal bind pose), but equipping later while
      // the character is mid-animation was overwriting boneInverses with
      // garbage and breaking the whole character. Vertex data is already
      // baked into bind/world space (see mesh.ts), so an explicit identity
      // bindMatrix is exactly correct here and skips that recompute entirely.
      skinnedMesh.bind(built.skeleton, IDENTITY_MATRIX);
      built3d.push(skinnedMesh);
      builtObject = skinnedMesh;
    } else {
      // Rigid (unweighted) part: attach directly to its parent bone (or
      // parent sub-object - see above) so it follows the pose.
      const mesh = new Mesh(geometry, material);
      mesh.name = obj.name || `${namePrefix}_${objects.indexOf(obj)}`;

      const parentIndex = built.nameToIndex.get(obj.parentName);
      const parentBone = parentIndex !== undefined ? built.bones[parentIndex] : null;
      const referenceIndex = rigidReference.nameToIndex.get(obj.parentName);
      const parentSibling = siblingsByName.get(obj.parentName);

      if (parentBone && referenceIndex !== undefined) {
        // Use the reference skeleton's precomputed bind-pose inverse, not
        // the (possibly different) attach target bone's *current*
        // matrixWorld - this can run well after the initial load (equipping
        // an item mid-animation), by which point the bone has moved from
        // its bind pose. objectMatrix is always bind-pose (baked into the
        // .msh at export time, relative to whatever skeleton it was
        // authored against), so mixing it with a live, posed bone matrix
        // computes a bogus static offset that then gets carried along as
        // the bone keeps animating - the part appears to fly around.
        // boneInverses is fixed at skeleton construction time (true bind
        // pose), so this is correct however the *target* pose has moved -
        // and using the reference skeleton's own inverse (rather than the
        // target's) is what makes this correct even when the two skeletons
        // differ, as they do for a wielding character mounting a weapon
        // authored against a different one.
        const bindInverse = rigidReference.skeleton.boneInverses[referenceIndex];
        const localMatrix = bindInverse.clone().multiply(obj.objectMatrix);
        localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        parentBone.add(mesh);
      } else if (parentSibling) {
        // Chained to another sub-object in this file rather than a bone -
        // both objectMatrix values live in the same shared per-file
        // reference space, so the parent's own raw objectMatrix serves
        // exactly the same role its bind-pose inverse does in the bone
        // case above (canceling out that shared space to leave only the
        // relative offset between the two).
        const localMatrix = parentSibling.objectMatrix.clone().invert().multiply(obj.objectMatrix);
        localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        parentSibling.object3D.add(mesh);
      } else {
        obj.objectMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      }
      built3d.push(mesh);
      builtObject = mesh;
    }

    siblingsByName.set(obj.name, { object3D: builtObject, objectMatrix: obj.objectMatrix });
  }
  return built3d;
}

/**
 * Builds the ready-to-attach three.js object(s) for one named mesh entry
 * (a body part, or an equipped item's mesh) inside a race's Mesh/Tex RFS
 * archives. Shared by the initial default-body build and by equipping a
 * specific body-part item onto a slot later, so both go through identical
 * mesh-building logic.
 */
export function buildMeshPartObjects(
  stem: string,
  meshArchive: RfsArchive,
  texArchive: RfsArchive,
  built: BuiltSkeleton,
): Object3D[] {
  const meshEntry = findRfsEntry(meshArchive, `${stem}.msh`);
  if (!meshEntry) {
    console.warn(`No "${stem}.msh" entry in the Mesh archive`);
    return [];
  }
  const meshBuffer = readRfsEntry(meshArchive, meshEntry);

  const texEntry = findRfsEntry(texArchive, `${stem}.RFT`);
  let texture: Texture | null = null;
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
    console.warn(`Failed to parse "${stem}.msh" (entry size ${meshEntry.size} bytes):`, err);
    return [];
  }

  return buildObjectsFromParsedMesh(objects, texture, built, stem);
}

const WEAPON_MESH_BASE = '/game-assets/item/Weapon/Mesh';
const WEAPON_TEX_BASE = '/game-assets/item/Weapon/Tex';

// Weapon meshes/textures are packed into these RFS archives, same as
// player body parts - NOT loose files (itemResource.json's PathName/
// TexutrePath point at a bare directory for most entries, with no archive
// name encoded, so which of these actually holds a given item isn't
// knowable ahead of time; see loadWeaponMeshObjects). Discovered by
// listing public/game-assets/item/Weapon/{Mesh,Tex} - there's no
// client-side directory listing API, so this has to be a fixed list, same
// as RACE_CONFIGS' archive names elsewhere in this file. Ordered with the
// common numbered archives first (WEM00 in particular - confirmed to hold
// COM_WEAPON_*, the everyday weapon prefix) since a hit there resolves
// fastest for the common case; the named ones after are smaller, more
// specialized sets (siege kits, event/PvP weapons, elf-only weapons, ...).
const WEAPON_MESH_ARCHIVE_NAMES = [
  'WEM00', 'WEM01', 'WEM02', 'WEM03', 'WEM04', 'WEM05', 'WEM06', 'WEM07', 'WEM08', 'WEM09', 'WEM10', 'WEM11', 'WEM12',
  'WEVM00', 'GEM00', 'NEM00', 'ELFWPM01', 'PVPWP', 'ORI70', 'ORI70SIEG', 'SIEGEORISS', '75siegeMesh', 'ori6770w',
];
const WEAPON_TEX_ARCHIVE_NAMES = [
  'WET00', 'WET01', 'WET02', 'WET03', 'WET04', 'WET05', 'WET06', 'WET07', 'WET08', 'WET09', 'WET10', 'WET11', 'WET12', 'WET13',
  'WEVT00', 'GET00', 'NET55', 'ELFWPT01', 'PVPWP', 'ORI70', 'ORI70SIEG', 'SIEGEORISS', 'ori6770',
];

// Lazily fetched and cached per archive name (not just per race like
// raceAssetCache) - equipping one weapon only needs the one or two archives
// that actually hold that item, not this whole ~150MB set. preloadWeaponMeshes
// below does eventually touch every archive at least one currently-existing
// item resolves into, but each individual lookup still only awaits as many
// as it takes to find its own hit - see findInWeaponArchives. Promises are
// cached up front (same reasoning as raceAssetCache above), so two
// concurrent lookups that need the same archive share one fetch instead of
// racing separate ones; a failed load resolves to null (not a rejection) so
// it's cached as "confirmed absent" rather than retried forever.
const weaponMeshArchiveCache = new Map<string, Promise<RfsArchive | null>>();
const weaponTexArchiveCache = new Map<string, Promise<RfsArchive | null>>();

function loadWeaponArchive(
  base: string,
  name: string,
  cache: Map<string, Promise<RfsArchive | null>>,
): Promise<RfsArchive | null> {
  let cached = cache.get(name);
  if (!cached) {
    cached = fetchRfsArchive(`${base}/${name}.RFS`).catch((err: unknown) => {
      console.warn(`Failed to load weapon archive "${name}":`, err);
      return null;
    });
    cache.set(name, cached);
  }
  return cached;
}

/** Searches a fixed list of archives in order for one named entry, fetching (and caching) only as many as it takes to find a hit. */
async function findInWeaponArchives(
  archiveNames: string[],
  base: string,
  cache: Map<string, Promise<RfsArchive | null>>,
  entryName: string,
): Promise<{ archive: RfsArchive; entry: RfsEntry } | null> {
  for (const name of archiveNames) {
    const archive = await loadWeaponArchive(base, name, cache);
    if (!archive) continue;
    const entry = findRfsEntry(archive, entryName);
    if (entry) return { archive, entry };
  }
  return null;
}

// Weapon meshes' rigid sub-objects have a parentName that names a bone
// that exists on any character's skeleton (verified against a real
// weapon .msh: "Bip01 R Finger0"/"Bip01 R Hand" etc), so no separate
// per-weapon skeleton needs to be *loaded* - but their objectMatrix isn't
// actually expressed relative to the wielding character's own skeleton.
// Every weapon mesh checked (a one-handed knife and a two-handed sword,
// both across multiple races) has an objectMatrix that lines up almost
// exactly (a small, consistent residual - presumably the real grip
// offset) with Accretia's own skeleton specifically, not Bell/Cora's -
// and each weapon's shipped .bn file (itself unused for skinning, since
// weapons are rigid, not skinned) independently confirms this: its bone
// world positions match Accretia's real skeleton almost to the decimal.
// So every weapon was authored/rigged against ONE fixed reference
// skeleton (Accretia's), regardless of which race can equip it - using
// the *wielding* character's own skeleton for the bind-pose inverse (as
// body-part items correctly do, since those really are authored per-race)
// silently misplaces the weapon for every other race. Loaded once and
// cached, reused for every weapon equip.
let weaponReferenceSkeletonPromise: Promise<BuiltSkeleton> | null = null;
function loadWeaponReferenceSkeleton(): Promise<BuiltSkeleton> {
  if (!weaponReferenceSkeletonPromise) {
    weaponReferenceSkeletonPromise = getRaceAssets(RaceGender.Accretia).then(({ skeletonBuffer }) =>
      buildThreeSkeleton(parseSkeleton(skeletonBuffer)),
    );
  }
  return weaponReferenceSkeletonPromise;
}

interface ParsedWeaponMesh {
  objects: RfMeshObject[];
  /**
   * Tagged with userData.pooled = true below - shared across every equip of
   * this stem (by any character, present or future), not owned by any one
   * of them, so CharacterController's generic disposeObject3D() must skip
   * disposing it on an individual unequip. Its geometry doesn't need the
   * same treatment: buildObjectsFromParsedMesh still allocates a fresh
   * BufferGeometry (wrapping the same underlying vertex arrays, which is
   * safe to share - only the GPU-side buffer built from them at upload time
   * is per-BufferGeometry-instance) on every call, so each equip's geometry
   * is already its own, safely disposable object.
   */
  texture: Texture | null;
}

// Keyed by mesh stem, not by wielder/race - see loadWeaponMeshObjects' own
// doc comment on why weapon geometry/texture don't vary by whoever equips
// them. Caches the *parsed* data (raw vertex arrays + decoded texture), not
// built three.js objects - buildObjectsFromParsedMesh still runs fresh per
// equip (cheap: a BufferGeometry alloc + bone attach, no network/parsing),
// so re-equipping the same weapon later (on any character) never re-fetches
// or re-parses. In-flight promises are cached too, not just settled
// results, same reasoning as raceAssetCache below. See preloadWeaponMeshes
// for warming this up front instead of relying purely on first-equip.
const weaponMeshPoolCache = new Map<string, Promise<ParsedWeaponMesh | null>>();

function loadParsedWeaponMesh(stem: string): Promise<ParsedWeaponMesh | null> {
  let cached = weaponMeshPoolCache.get(stem);
  if (!cached) {
    cached = (async (): Promise<ParsedWeaponMesh | null> => {
      const meshHit = await findInWeaponArchives(WEAPON_MESH_ARCHIVE_NAMES, WEAPON_MESH_BASE, weaponMeshArchiveCache, `${stem}.msh`);
      if (!meshHit) {
        console.warn(`No "${stem}.msh" entry in any weapon Mesh archive`);
        return null;
      }
      const meshBuffer = readRfsEntry(meshHit.archive, meshHit.entry);

      let texture: Texture | null = null;
      const texHit = await findInWeaponArchives(WEAPON_TEX_ARCHIVE_NAMES, WEAPON_TEX_BASE, weaponTexArchiveCache, `${stem}.RFT`);
      if (texHit) {
        try {
          texture = decodeRftTexture(readRfsEntry(texHit.archive, texHit.entry));
          texture.userData.pooled = true;
        } catch (err) {
          console.warn(`Texture decode failed for ${stem}:`, err);
        }
      }

      let objects: RfMeshObject[];
      try {
        objects = parseMesh(meshBuffer);
      } catch (err) {
        console.warn(`Failed to parse "${stem}.msh":`, err);
        return null;
      }

      return { objects, texture };
    })();
    weaponMeshPoolCache.set(stem, cached);
  }
  return cached;
}

/**
 * Builds the ready-to-attach three.js object(s) for an equipped weapon.
 * `built` is the wielding character's own skeleton, used to find the
 * actual bone object to attach onto (so the weapon follows that
 * character's own pose) - see loadWeaponReferenceSkeleton above for why
 * the *placement math* needs a different, fixed skeleton instead. Most
 * weapon items reference a model variant not present in this asset drop,
 * so an empty result (mesh not found in any weapon archive) is common -
 * callers should treat that as "no visual mesh available," not an error.
 * The actual fetch+parse is pooled by stem (see loadParsedWeaponMesh) and
 * normally already warm by the time this runs - see preloadWeaponMeshes.
 */
export async function loadWeaponMeshObjects(stem: string, built: BuiltSkeleton): Promise<Object3D[]> {
  const parsed = await loadParsedWeaponMesh(stem);
  if (!parsed) return [];

  const referenceSkeleton = await loadWeaponReferenceSkeleton();
  return buildObjectsFromParsedMesh(parsed.objects, parsed.texture, built, stem, referenceSkeleton);
}

const WEAPON_PRELOAD_CONCURRENCY = 8;

/**
 * Warms the weapon mesh pool (see loadParsedWeaponMesh) for every given
 * item Model id, so a later equip of any of them is instant - no network
 * fetch or binary parse left to do. Call with every *currently existing*
 * weapon item's Model id (see items.ts's IsExist filtering) - most won't
 * resolve to an actual mesh in this asset drop (see resolveWeaponMesh) and
 * are skipped for free; the rest de-duplicate down to a much smaller set of
 * distinct mesh stems (many item variants - different upgrade levels, mostly -
 * share one underlying mesh) before anything is fetched.
 *
 * Mirrors Unity's own recommended pattern for pooled prefabs: warm the pool
 * once up front (typically at a loading screen) rather than instantiating
 * cold on first use, so runtime hitches never happen - see preloadAllRaces
 * for this project's equivalent for player body assets, which this is
 * meant to run alongside.
 *
 * Runs with bounded concurrency (WEAPON_PRELOAD_CONCURRENCY at a time)
 * rather than firing every stem's load at once - there can be a couple
 * thousand distinct stems, and letting them all queue through fetch()
 * simultaneously doesn't finish any faster (the browser serializes/queues
 * connections per origin regardless) while making the progress readout
 * jump in one huge burst near the end instead of advancing steadily.
 */
export async function preloadWeaponMeshes(modelIds: string[], onProgress?: (loaded: number, total: number) => void): Promise<void> {
  const resolved = await Promise.all(modelIds.map((modelId) => resolveWeaponMesh(modelId)));
  const stems = [...new Set(resolved.filter((r): r is WeaponMeshInfo => r !== null).map((r) => r.stem))];

  const total = stems.length;
  let loaded = 0;
  onProgress?.(loaded, total);

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < stems.length) {
      const stem = stems[nextIndex++];
      await loadParsedWeaponMesh(stem);
      loaded += 1;
      onProgress?.(loaded, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(WEAPON_PRELOAD_CONCURRENCY, stems.length) }, worker));
}

// Keyed by race so a preload (or a repeat visit to an already-loaded race)
// never re-fetches. In-flight promises are cached too, not just settled
// results, so two overlapping requests for the same not-yet-loaded race
// (e.g. preloadAllRaces() racing a user's manual race switch) share one
// fetch instead of doubling it up.
const raceAssetCache = new Map<RaceGender, Promise<RaceAssets>>();

/** Exposes the (cached) per-race archives, so equipping an item later can reuse them without re-fetching. */
export function getRaceAssets(raceGender: RaceGender): Promise<RaceAssets> {
  return loadRaceAssets(raceGender);
}

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
    // COA, not MOA: COA turns out to be a near-superset of MOA (every
    // BW/FW/LF/RT walk/run entry MOA has, minus 8 redundant PEACE_* ones
    // already covered by the ETA archive) plus the per-weapon-token
    // COMBAT_STAND clip that MOA doesn't carry at all.
    trackedFetchRfsArchive(`${ASSET_BASE}/Ani/${race.aniCode}COA.RFS`),
  ]).then(([skeletonBuffer, meshArchive, texArchive, aniArchive, weaponAniArchive]) => ({
    skeletonBuffer,
    meshArchive,
    texArchive,
    aniArchive,
    weaponAniArchive,
  }));
  // Cache the promise up front (not after it resolves) so concurrent callers
  // join it instead of starting their own fetch; a failed load is evicted so
  // a later retry can actually try again rather than replaying the same rejection.
  raceAssetCache.set(raceGender, promise);
  promise.catch(() => raceAssetCache.delete(raceGender));
  return promise;
}

const ALL_RACES = Object.values(RaceGender).filter((v): v is RaceGender => typeof v === 'number');
const FILES_PER_RACE = 5;

/**
 * Fetches and caches every race's assets up front, so switching races later
 * never blocks on the network. Reports progress in units of "files fetched"
 * (5 per race: bone, mesh, tex, ani, weapon-ani), not races, for a smoother
 * readout.
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

/**
 * Loads a race/gender's skeleton and base animation clips into a
 * ready-to-render (but bodiless) character - the caller is responsible for
 * equipping every body-part slot (see buildMeshPartObjects/getRaceAssets),
 * which CharacterController.mount() does immediately with the default
 * parts. Splitting it this way means the initial default body and a later
 * item swap go through the exact same mesh-building + tracking path,
 * instead of the default parts being built here untracked and then
 * silently doubled-up under whatever a later equip adds.
 */
export async function loadCharacter(raceGender: RaceGender = RaceGender.Bell_Female): Promise<RfCharacter> {
  const race = RACE_CONFIGS[raceGender];
  const { skeletonBuffer, aniArchive } = await loadRaceAssets(raceGender);

  const rfSkeleton = parseSkeleton(skeletonBuffer);
  const built = buildThreeSkeleton(rfSkeleton);

  const group = new Group();
  group.name = race.nameToken;
  group.add(built.root);

  const bindPoseByBone = getCachedBindPose(raceGender, rfSkeleton);

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

// A race's bind pose (per-bone rest position/rotation/scale) is pure data
// derived from its skeleton buffer, with no per-character identity - unlike
// builtSkeleton (real three.js Bone objects, one independent set per
// mounted character), it's safe and cheap to compute once per race and
// reuse for every character of that race, including later lazily-built
// weapon clips (see getWeaponClip) that need it long after the character
// that first requested it may be gone.
const bindPoseCache = new Map<RaceGender, Map<string, BindPose>>();

function getCachedBindPose(raceGender: RaceGender, rfSkeleton: RfSkeleton): Map<string, BindPose> {
  let cached = bindPoseCache.get(raceGender);
  if (!cached) {
    cached = new Map(
      rfSkeleton.bones.map((b) => [
        b.name,
        { position: b.localPosition, rotation: b.localRotation, scale: b.localScale },
      ]),
    );
    bindPoseCache.set(raceGender, cached);
  }
  return cached;
}

async function getBindPoseByBoneAsync(raceGender: RaceGender): Promise<Map<string, BindPose>> {
  const cached = bindPoseCache.get(raceGender);
  if (cached) return cached;
  const { skeletonBuffer } = await loadRaceAssets(raceGender);
  return getCachedBindPose(raceGender, parseSkeleton(skeletonBuffer));
}

/** Cache key (also the character.clips key) for a weapon-conditional walk/run/stand clip. */
export function weaponClipKey(kind: 'walk' | 'run' | 'stand', weaponToken: string): string {
  return `${kind}:${weaponToken}`;
}

// Accretia's COA archive names walk/run with a directional FW prefix
// ("ACCRETIA_COMBAT_FWWALK_<token>_NONE_01_00") - and also carries a
// second, plain non-directional form alongside it ("..._COMBAT_WALK_...").
// Every other race (Bell/Cora, both genders) only ever has the plain form
// - verified by counting entries: 0 FWWALK/FWRUN matches across all of
// BMCOA/BFCOA/CMCOA/CFCOA, 56 in ACCOA alongside 56 plain ones. Since our
// character always faces its travel direction, the plain form is exactly
// what "forward" needs anyway on those races - it's their only combat
// walk/run, not a different animation. Both spellings are tried, FW first
// since it's the more explicit match when both exist. STAND has no
// directional variant on any race.
const WEAPON_CLIP_SEGMENTS: Record<'walk' | 'run' | 'stand', string[]> = {
  walk: ['FWWALK', 'WALK'],
  run: ['FWRUN', 'RUN'],
  stand: ['STAND'],
};

/**
 * Lazily builds (and caches onto `character.clips`) the combat walk/run/
 * stand clip for a given weapon category token (see resolveWeaponMesh's
 * weaponToken, e.g. "RKNIFE"/"TSWORD"/"DAXE"). Not every race has a combat
 * animation for every weapon token (some heavy weapons are Accretia-only,
 * for instance), so this commonly resolves to null; callers should fall
 * back to the unarmed clip, not treat it as an error.
 */
export async function getWeaponClip(
  raceGender: RaceGender,
  character: RfCharacter,
  kind: 'walk' | 'run' | 'stand',
  weaponToken: string,
): Promise<AnimationClip | null> {
  const key = weaponClipKey(kind, weaponToken);
  const cached = character.clips[key];
  if (cached) return cached;

  const race = RACE_CONFIGS[raceGender];
  const { weaponAniArchive } = await getRaceAssets(raceGender);

  let aniEntry: RfsEntry | null = null;
  let fileName = '';
  for (const segment of WEAPON_CLIP_SEGMENTS[kind]) {
    fileName = `${race.nameToken}_COMBAT_${segment}_${weaponToken}_NONE_01_00.ANI`;
    aniEntry = findRfsEntry(weaponAniArchive, fileName);
    if (aniEntry) break;
  }
  if (!aniEntry) return null;

  try {
    const buffer = readRfsEntry(weaponAniArchive, aniEntry);
    const bindPoseByBone = await getBindPoseByBoneAsync(raceGender);
    const clip = buildAnimationClip(key, parseAnimation(buffer), bindPoseByBone);
    character.clips[key] = clip;
    return clip;
  } catch (err) {
    console.warn(`Skipping weapon animation "${fileName}":`, err);
    return null;
  }
}
