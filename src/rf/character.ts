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
  Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three';
import type { Texture } from 'three';
import { buildAnimationClip, parseAnimation } from './animation';
import type { BindPose } from './animation';
import { parseMesh } from './mesh';
import type { RfMeshObject } from './mesh';
import { findRfsEntry, parseRfs, readRfsEntry } from './rfs';
import type { RfsArchive, RfsEntry } from './rfs';
import { buildThreeSkeleton, parseSkeleton } from './skeleton';
import type { BuiltSkeleton, RfSkeleton } from './skeleton';
import { decodeRftTexture } from './texture';
import type { TextureAlphaInfo } from './texture';

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

/** Human-readable label per race/gender - used by the character-creation race picker and character-info display. */
export const RACE_LABELS: Record<RaceGender, string> = {
  [RaceGender.Bell_Male]: 'Bellato (Male)',
  [RaceGender.Bell_Female]: 'Bellato (Female)',
  [RaceGender.Cora_Male]: 'Cora (Male)',
  [RaceGender.Cora_Female]: 'Cora (Female)',
  [RaceGender.Accretia]: 'Accretia',
};

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

/**
 * Real backward/strafe locomotion, not a facing hack: RF's own Ani archives
 * carry dedicated BW(alk)/RT(walk)/LF(walk) - and the RUN equivalents -
 * clips where the character visibly walks backward or sideways while still
 * facing forward, confirmed present for every race in the unarmed (ETA)
 * archive (see directionalAnimationFileNames). "fw" isn't a real direction
 * here - moving mostly-forward (with or without a slight strafe) just uses
 * the plain walk/run clip and faces the way it's moving, same as always.
 */
export type LocomotionDirection = 'bw' | 'lf' | 'rt';

const DIRECTION_SEGMENT_PREFIX: Record<LocomotionDirection, string> = { bw: 'BW', lf: 'LF', rt: 'RT' };
const DIRECTIONAL_LOCOMOTION_KINDS = ['walk', 'run'] as const;
export const LOCOMOTION_DIRECTIONS: LocomotionDirection[] = ['bw', 'lf', 'rt'];

/** Cache key (also the character.clips key) for an unarmed directional walk/run clip - see LocomotionDirection. */
function directionalClipKey(kind: 'walk' | 'run', direction: LocomotionDirection): string {
  return `${kind}:${direction}`;
}

function directionalAnimationFileNames(nameToken: string): { key: string; fileName: string }[] {
  const entries: { key: string; fileName: string }[] = [];
  for (const kind of DIRECTIONAL_LOCOMOTION_KINDS) {
    for (const direction of LOCOMOTION_DIRECTIONS) {
      entries.push({
        key: directionalClipKey(kind, direction),
        fileName: `${nameToken}_PEACE_${DIRECTION_SEGMENT_PREFIX[direction]}${kind.toUpperCase()}_NONE_NONE_01_00.ANI`,
      });
    }
  }
  return entries;
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

/** Fetches+parses+builds each named clip from an Ani archive into `clips`, keyed by `key` - shared by loadCharacter()'s base and directional clip passes. A missing/unparsable entry just skips that one key (warned, not thrown) - callers fall back to a base clip when a specific key isn't present. */
function loadClipsInto(
  clips: Record<string, AnimationClip>,
  aniArchive: RfsArchive,
  entries: { key: string; fileName: string }[],
  bindPoseByBone: Map<string, BindPose>,
): void {
  for (const { key, fileName } of entries) {
    const aniEntry = findRfsEntry(aniArchive, fileName);
    if (!aniEntry) {
      console.warn(`Skipping animation ${key}: no "${fileName}" entry in the Ani archive`);
      continue;
    }
    try {
      const buffer = readRfsEntry(aniArchive, aniEntry);
      clips[key] = buildAnimationClip(key, parseAnimation(buffer), bindPoseByBone);
    } catch (err) {
      console.warn(`Skipping animation ${key}:`, err);
    }
  }
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
  /** The DEFAULT{code}.RFS body - always sufficient for the default/base-appearance stem (see CharacterController.equipHelmet/equipItem's null branch); a real armor item may need getRaceArmorArchives() instead. */
  meshArchive: RfsArchive;
  texArchive: RfsArchive;
  aniArchive: RfsArchive;
  /** Per-weapon-category combat walk/run/stand clips (character/player/Ani/{race}COA.RFS) - see getWeaponClip(). */
  weaponAniArchive: RfsArchive;
  /**
   * Directional (backward/strafe) combat walk/run clips (character/player/
   * Ani/{race}MOA.RFS) - see getWeaponClip(). COA's own BW/LF/RT/FW-
   * prefixed entries only exist for Accretia (confirmed by direct count:
   * zero across Bell/Cora's COA archives); MOA carries the same directional
   * set - full token-for-token coverage matching COA's plain-form tokens,
   * confirmed by comparison - for every race, but has no COMBAT_STAND at
   * all, so it's only ever consulted for walk/run direction lookups, never
   * as a general COA substitute.
   */
  weaponMoaArchive: RfsArchive;
}

const scratchWielderPos = new Vector3();
const scratchWielderRot = new Quaternion();
const scratchWielderScale = new Vector3();
const scratchRefPos = new Vector3();
const scratchRefRot = new Quaternion();
const scratchRefScale = new Vector3();

/**
 * Empirical per-weapon-token corrections applied on top of the computed
 * rigid placement (see getCorrectedRigidBindInverse), found via the
 * %wpedit gizmo: equip the token, drag the gizmo to where it actually
 * looks right, read the panel's "Original"/"Edited" Euler-degree transforms
 * back off, and convert to this local-space quaternion delta (NOT a plain
 * per-axis degree subtraction, which isn't exact for a rotation this size -
 * see the reconstruction below). This exists for whatever residual is left
 * once getCorrectedRigidBindInverse's own retargeting is as good as it can
 * be - a genuine per-weapon-mesh authoring quirk this project has no way to
 * derive from first principles, so it's captured by hand instead.
 *
 * Keyed by weaponToken only (not race) - a correction measured here should
 * hold across every race, since it's layered on top of placement math that
 * itself now retargets rotation essentially exactly (~0.003° residual,
 * verified across every race) rather than leaving a race-dependent
 * leftover error for a token-only fixup to accidentally absorb. (History:
 * a fixup for TCROSSBOW measured against an earlier, less-exact version of
 * getCorrectedRigidBindInverse worked on Cora but made Accretia/Bell worse
 * - not because the correction genuinely varies by race, but because that
 * older math left a real 2-7° residual that varied by race, and the Cora
 * measurement silently baked that race's own leftover error in alongside
 * the weapon's real quirk. Fixed at the source (see
 * getCorrectedRigidBindInverse's doc comment) rather than by keying this
 * table on race too - that entry is cleared below pending a fresh
 * measurement against the corrected math.)
 */
interface WeaponPlacementFixup {
  /** Added directly to the computed local position (same units/space, i.e. relative to the attach bone). */
  positionDelta: [number, number, number];
  /**
   * Local-space rotation delta as a quaternion [x, y, z, w] - reconstructed
   * from %wpedit's reported Euler-degree "Original"/"Edited" transforms via
   * `fixupQuat = originalQuat^-1 * editedQuat` (so that
   * `computedQuat.multiply(fixupQuat)` reproduces the edited transform
   * exactly for the race it was measured on) - never store this as a bare
   * Euler-degree delta, composing those linearly is only exact for
   * infinitesimal rotations, not one this large.
   */
  rotationDelta: [number, number, number, number];
}

const WEAPON_PLACEMENT_FIXUPS: Record<string, WeaponPlacementFixup> = {
  // Re-measured against the fixed getCorrectedRigidBindInverse - Original
  // pos=[-0.1568,-0.0214,0.4768] rotDeg=[88.9,2.3,-62.8], Edited
  // pos=[-0.1568,-0.0214,0.4768] rotDeg=[88.7,2.3,-68.6] - a small ~5.7°
  // single-axis twist, no position change, vs. the ~35° + 1.4-unit
  // correction the old (buggy-retargeting) measurement needed. That drop
  // alone is strong confirmation the retargeting fix actually worked - see
  // the "Rigid weapon retargeting" entry in rf-format-notes.md's "Known
  // bugs" section.
  TCROSSBOW: {
    positionDelta: [0, 0, 0],
    rotationDelta: [-0.000718, -0.001589, -0.050663, 0.998714],
  },
};

const fixupQuatScratch = new Quaternion();
const fixupPosScratch = new Vector3();

/** Applies a weapon token's placement fixup (if any) to an already-placed rigid part's local transform - see WEAPON_PLACEMENT_FIXUPS. No-op when the token has no registered fixup. */
function applyWeaponPlacementFixup(object: Object3D, weaponToken: string | null | undefined): void {
  if (!weaponToken) return;
  const fixup = WEAPON_PLACEMENT_FIXUPS[weaponToken];
  if (!fixup) return;
  object.position.add(fixupPosScratch.set(...fixup.positionDelta));
  object.quaternion.multiply(fixupQuatScratch.set(...fixup.rotationDelta));
}

/**
 * Computes the bind-pose inverse used to place a rigid part on the wielder's
 * own attach bone (`built`'s bone at `parentIndex`), keeping `rigidReference`
 * (Accretia)'s authored position/scale but substituting the WIELDER's own
 * bind-pose rotation for that exact same bone, in place of Accretia's.
 *
 * Weapons are authored in `rigidReference`'s bind-pose world space, so
 * naively retargeting via `rigidReference`'s raw bone-inverse assumes
 * `rigidReference`'s and `built`'s arm bind poses point the same way. They
 * don't - by up to 20-40° at "Bip01 R Finger0" for a non-Accretia race,
 * confirmed by parsing every race's real .bn skeleton. A 20-40° error at
 * the wrist is invisible on a ~15cm knife blade but swings a ~1m
 * two-handed weapon's muzzle wildly off - the cause of the "long weapons
 * visibly misplaced, short ones fine" pattern this was built to fix.
 *
 * An earlier version of this function corrected via the attach bone's
 * *parent* (e.g. hand, for a Finger0 attach point) instead of the attach
 * bone itself, preserving what was assumed to be a race-invariant
 * "Finger0-relative-to-hand" local offset from Accretia. That assumption
 * was wrong: comparing the SAME bone (Finger0) directly, as done here,
 * measurably eliminates the retarget rotation error entirely (down to
 * ~0.003°, i.e. floating-point noise, verified on Bell/Cora Male/Female)
 * where the parent-relative version left a real 2-7° residual that varied
 * *by race* - larger for Cora than Bell. That residual is exactly what
 * made an empirical per-weapon correction (see WEAPON_PLACEMENT_FIXUPS)
 * measured on one race come out wrong on the others: it silently baked in
 * that race's own leftover retargeting error along with the weapon's real
 * quirk, and reapplying it elsewhere reintroduced the wrong race's error
 * instead of correcting it. Comparing the attach bone directly leaves no
 * such residual to contaminate a fixup measured on any one race.
 *
 * Position and scale are left exactly as Accretia authored them - already
 * validated as correct (the position residual against Accretia's own hand
 * position is the genuine grip offset, not an error - see the .bn section
 * of rf-format-notes.md); only rotation is substituted. Everything here
 * comes from `boneInverses` (fixed at skeleton construction, i.e. true
 * bind pose) - never a bone's live `matrixWorld` - so this stays correct
 * regardless of what pose the character happens to be animating through
 * when a weapon is equipped (see the "must use skeleton.boneInverses, not
 * live matrixWorld" bug this project already fixed once for the same
 * reason).
 *
 * Falls back to `rigidReference`'s raw inverse when this exact bone isn't
 * present in `built` (shouldn't happen for a real attach point, but safer
 * than throwing).
 */
function getCorrectedRigidBindInverse(built: BuiltSkeleton, rigidReference: BuiltSkeleton, parentIndex: number, referenceIndex: number): Matrix4 {
  const referenceBindInverse = rigidReference.skeleton.boneInverses[referenceIndex];
  const wielderBindInverse = built.skeleton.boneInverses[parentIndex];
  if (!wielderBindInverse) return referenceBindInverse;

  const referenceBindWorld = referenceBindInverse.clone().invert();
  referenceBindWorld.decompose(scratchRefPos, scratchRefRot, scratchRefScale);

  wielderBindInverse.clone().invert().decompose(scratchWielderPos, scratchWielderRot, scratchWielderScale);

  const correctedReferenceBindWorld = new Matrix4().compose(scratchRefPos, scratchWielderRot, scratchRefScale);
  return correctedReferenceBindWorld.invert();
}

/**
 * Reads a decoded texture's alpha classification (see classifyAlpha in
 * texture.ts) back into MeshStandardMaterial options. `mask` (a hard
 * cutout - hair strands, helmet grating/visor holes) uses alphaTest rather
 * than `transparent`, since real alpha blending between several overlapping
 * body-part meshes on one character has no reliable draw-order and would
 * show through in the wrong places depending on camera angle; alphaTest
 * discards below-threshold fragments outright instead, same depth-tested
 * opaque rendering as everything else. Textures with no meaningful alpha
 * (the common case) fall through to three.js's own defaults - this is what
 * was missing before: every material always fell through, even for a
 * texture that genuinely needed one of the other two modes.
 */
function materialAlphaOptions(texture: Texture | null): { transparent: boolean; alphaTest: number } {
  const alphaInfo = (texture?.userData as { rfAlpha?: TextureAlphaInfo } | undefined)?.rfAlpha;
  if (alphaInfo?.alphaMode === 'blend') return { transparent: true, alphaTest: 0 };
  if (alphaInfo?.alphaMode === 'mask') return { transparent: false, alphaTest: alphaInfo.alphaTest ?? 0.5 };
  return { transparent: false, alphaTest: 0 };
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
  // Only set for a weapon equip (see loadWeaponMeshObjects) - looks up an
  // empirical WEAPON_PLACEMENT_FIXUPS correction for each rigid part, on
  // top of the computed placement. Undefined for body parts (no such table
  // for them) and for skinned parts (fixups only apply to rigid attaches).
  weaponToken?: string | null,
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
      ...materialAlphaOptions(texture),
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

      if (parentIndex !== undefined && parentBone && referenceIndex !== undefined) {
        // Use a bind-pose inverse, not the (possibly different) attach
        // target bone's *current* matrixWorld - this can run well after the
        // initial load (equipping an item mid-animation), by which point
        // the bone has moved from its bind pose. objectMatrix is always
        // bind-pose (baked into the .msh at export time, relative to
        // whatever skeleton it was authored against), so mixing it with a
        // live, posed bone matrix computes a bogus static offset that then
        // gets carried along as the bone keeps animating - the part appears
        // to fly around. See getCorrectedRigidBindInverse's own doc comment
        // for why this isn't simply rigidReference's raw bind inverse - a
        // wielding race's arm bind pose doesn't orient the same way
        // Accretia's does, which barely matters for a short weapon but
        // swings a long one's far end wildly off.
        const bindInverse = getCorrectedRigidBindInverse(built, rigidReference, parentIndex, referenceIndex);
        const localMatrix = bindInverse.clone().multiply(obj.objectMatrix);
        localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        applyWeaponPlacementFixup(mesh, weaponToken);
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

/** Searches a fixed list of already-loaded archives in order for one named entry - the same archive-list-search shape as findInNamedArchives below, minus the lazy fetch/cache (these are all preloaded up front, see loadRaceAssets). Nulls (a tier archive that failed/doesn't exist for this race) are skipped. */
function findEntryInArchives(
  archives: (RfsArchive | null)[],
  name: string,
): { archive: RfsArchive; entry: RfsEntry } | null {
  for (const archive of archives) {
    if (!archive) continue;
    const entry = findRfsEntry(archive, name);
    if (entry) return { archive, entry };
  }
  return null;
}

interface ParsedBodyMesh {
  objects: RfMeshObject[];
  /** Tagged with userData.pooled = true below - same reasoning as ParsedWeaponMesh.texture: shared across every equip of this stem, so disposeObject3D() must skip disposing it on an individual unequip. */
  texture: Texture | null;
}

// Keyed by stem alone (globally, not per-race) - a resolved stem is already
// a unique, self-describing name ("BELFEMALE_ARMOR_UPPER_084",
// "ACCRETIA_DEFAULT_HELMET_000", ...), so re-equipping the same item (on
// the same character, or switching back after wearing something else)
// never re-fetches the archive entry or re-parses/re-decodes it - only the
// (per-equip, per-skeleton) three.js objects in buildObjectsFromParsedMesh
// below are ever rebuilt. Same pooling shape as weaponMeshPoolCache, and
// for the same reason: on-demand loading (see getRaceArmorArchives) must
// not mean "re-parse from scratch" every time something already seen once
// gets equipped again.
const bodyMeshParseCache = new Map<string, ParsedBodyMesh | null>();

function parseBodyMeshEntry(
  stem: string,
  meshArchives: (RfsArchive | null)[],
  texArchives: (RfsArchive | null)[],
): ParsedBodyMesh | null {
  const cached = bodyMeshParseCache.get(stem);
  if (cached !== undefined) return cached;

  const meshHit = findEntryInArchives(meshArchives, `${stem}.msh`);
  if (!meshHit) {
    console.warn(`No "${stem}.msh" entry in any Mesh archive`);
    bodyMeshParseCache.set(stem, null);
    return null;
  }
  const meshBuffer = readRfsEntry(meshHit.archive, meshHit.entry);

  const texHit = findEntryInArchives(texArchives, `${stem}.RFT`);
  let texture: Texture | null = null;
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
    console.warn(`Failed to parse "${stem}.msh" (entry size ${meshHit.entry.size} bytes):`, err);
    bodyMeshParseCache.set(stem, null);
    return null;
  }

  const parsed: ParsedBodyMesh = { objects, texture };
  bodyMeshParseCache.set(stem, parsed);
  return parsed;
}

/**
 * Builds the ready-to-attach three.js object(s) for one named mesh entry
 * (a body part, or an equipped item's mesh) inside a race's Mesh/Tex RFS
 * archives. Shared by the initial default-body build and by equipping a
 * specific body-part item onto a slot later, so both go through identical
 * mesh-building logic. Each parameter is searched in order (default archive
 * first, then the per-race armor archives, when the caller passes those -
 * see getRaceArmorArchives) since a resolved stem doesn't say which
 * specific archive actually holds it. The actual fetch+parse is pooled by
 * stem (see parseBodyMeshEntry above) - only the per-call, per-skeleton
 * three.js build below ever redoes work for an already-seen stem.
 */
export function buildMeshPartObjects(
  stem: string,
  meshArchives: (RfsArchive | null)[],
  texArchives: (RfsArchive | null)[],
  built: BuiltSkeleton,
): Object3D[] {
  const parsed = parseBodyMeshEntry(stem, meshArchives, texArchives);
  if (!parsed) return [];

  return buildObjectsFromParsedMesh(parsed.objects, parsed.texture, built, stem);
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
// that actually hold that item, not this whole ~150MB set; each individual
// lookup only awaits as many archives as it takes to find its own hit - see
// findInNamedArchives. Promises are
// cached up front (same reasoning as raceAssetCache above), so two
// concurrent lookups that need the same archive share one fetch instead of
// racing separate ones; a failed load resolves to null (not a rejection) so
// it's cached as "confirmed absent" rather than retried forever. Shared with
// cloak archive loading below (own cache instances, same generic helpers).
const weaponMeshArchiveCache = new Map<string, Promise<RfsArchive | null>>();
const weaponTexArchiveCache = new Map<string, Promise<RfsArchive | null>>();

function loadNamedArchive(
  base: string,
  name: string,
  cache: Map<string, Promise<RfsArchive | null>>,
): Promise<RfsArchive | null> {
  let cached = cache.get(name);
  if (!cached) {
    cached = fetchRfsArchive(`${base}/${name}.RFS`).catch((err: unknown) => {
      console.warn(`Failed to load archive "${name}":`, err);
      return null;
    });
    cache.set(name, cached);
  }
  return cached;
}

/** Searches a fixed list of archives in order for one named entry, fetching (and caching) only as many as it takes to find a hit. */
async function findInNamedArchives(
  archiveNames: string[],
  base: string,
  cache: Map<string, Promise<RfsArchive | null>>,
  entryName: string,
): Promise<{ archive: RfsArchive; entry: RfsEntry } | null> {
  for (const name of archiveNames) {
    const archive = await loadNamedArchive(base, name, cache);
    if (!archive) continue;
    const entry = findRfsEntry(archive, entryName);
    if (entry) return { archive, entry };
  }
  return null;
}

const CLOAK_MESH_BASE = '/game-assets/item/Armor/Mesh';
const CLOAK_TEX_BASE = '/game-assets/item/Armor/Tex';
// Discovered the same way WEAPON_MESH_ARCHIVE_NAMES was - listing
// public/game-assets/item/Armor/{Mesh,Tex} directly, no client-side listing
// API. Only 4 mesh archives but 2 tex archives; buildMeshPartObjects
// searches whichever archives are actually loaded regardless, so a texture
// living in a differently-named archive than its mesh isn't a problem.
const CLOAK_MESH_ARCHIVE_NAMES = ['AKM00', 'NewCloakM', 'PHBP01', 'XMC'];
const CLOAK_TEX_ARCHIVE_NAMES = ['AKT00', 'NewCloakT'];
const cloakMeshArchiveCache = new Map<string, Promise<RfsArchive | null>>();
const cloakTexArchiveCache = new Map<string, Promise<RfsArchive | null>>();

/**
 * Cloak meshes (see resolveCloakMeshStem in resource.ts) live in this small,
 * fixed set of race-agnostic archives under item/Armor/ - not the per-race
 * character/player/Mesh armor archives (RaceAssets.armorMeshArchives),
 * which was the wrong place: verified zero "_CLOAK_" entries there, for any
 * race. Small enough (4 mesh + 2 tex) to just fetch every archive up front
 * rather than search incrementally like loadWeaponMeshObjects does for its
 * much larger 12+13-archive set - buildMeshPartObjects does its own
 * per-entry search across whatever's returned here anyway.
 */
export function loadCloakArchives(): Promise<{
  meshArchives: (RfsArchive | null)[];
  texArchives: (RfsArchive | null)[];
}> {
  return Promise.all([
    Promise.all(CLOAK_MESH_ARCHIVE_NAMES.map((name) => loadNamedArchive(CLOAK_MESH_BASE, name, cloakMeshArchiveCache))),
    Promise.all(CLOAK_TEX_ARCHIVE_NAMES.map((name) => loadNamedArchive(CLOAK_TEX_BASE, name, cloakTexArchiveCache))),
  ]).then(([meshArchives, texArchives]) => ({ meshArchives, texArchives }));
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
// results, same reasoning as raceAssetCache below - loaded purely on
// demand, on whichever equip first needs a given stem (no eager warm-up).
const weaponMeshPoolCache = new Map<string, Promise<ParsedWeaponMesh | null>>();

function loadParsedWeaponMesh(stem: string): Promise<ParsedWeaponMesh | null> {
  let cached = weaponMeshPoolCache.get(stem);
  if (!cached) {
    cached = (async (): Promise<ParsedWeaponMesh | null> => {
      const meshHit = await findInNamedArchives(WEAPON_MESH_ARCHIVE_NAMES, WEAPON_MESH_BASE, weaponMeshArchiveCache, `${stem}.msh`);
      if (!meshHit) {
        console.warn(`No "${stem}.msh" entry in any weapon Mesh archive`);
        return null;
      }
      const meshBuffer = readRfsEntry(meshHit.archive, meshHit.entry);

      let texture: Texture | null = null;
      const texHit = await findInNamedArchives(WEAPON_TEX_ARCHIVE_NAMES, WEAPON_TEX_BASE, weaponTexArchiveCache, `${stem}.RFT`);
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
 * The actual fetch+parse is pooled by stem (see loadParsedWeaponMesh) -
 * loaded on demand here, not warmed ahead of time, so the first equip of a
 * given weapon has a real (background, non-blocking) load delay; every
 * later equip of the same stem is then instant, on any character.
 * `weaponToken` (see resolveWeaponMesh) is only used to look up a
 * WEAPON_PLACEMENT_FIXUPS entry - pass it whenever known (it always is at
 * the one real call site, CharacterController.equipWeapon) so a weapon
 * with a registered correction actually gets it.
 */
export async function loadWeaponMeshObjects(stem: string, built: BuiltSkeleton, weaponToken?: string | null): Promise<Object3D[]> {
  const parsed = await loadParsedWeaponMesh(stem);
  if (!parsed) return [];

  const referenceSkeleton = await loadWeaponReferenceSkeleton();
  return buildObjectsFromParsedMesh(parsed.objects, parsed.texture, built, stem, referenceSkeleton, weaponToken);
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

/** The 3 armor categories x 5 tiers RFSInfo.dat lists per race, e.g. "BFR00".."BFR40", "BFW00".."BFW40", "BFF00".."BFF40" for Bell_Female. */
const ARMOR_CATEGORIES = ['R', 'W', 'F'] as const;
const ARMOR_TIERS = ['00', '10', '20', '30', '40'] as const;

function armorArchiveNames(meshTexCode: string): string[] {
  const names: string[] = [];
  for (const category of ARMOR_CATEGORIES) {
    for (const tier of ARMOR_TIERS) names.push(`${meshTexCode}${category}${tier}`);
  }
  return names;
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

  // Only the character's own default body - small (~6MB/race) and needed
  // the instant a character mounts, so this is the one thing worth staying
  // eager for. Real armor-tier archives (~90MB/race) are loaded lazily
  // instead, on whichever race's first actual equip needs them - see
  // getRaceArmorArchives.
  const promise = Promise.all([
    trackedFetchBuffer(`${ASSET_BASE}/Bone/${race.boneFile}.bn`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Mesh/DEFAULT${race.meshTexCode}.RFS`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Tex/DEFAULT${race.meshTexCode}.RFS`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Ani/${race.aniCode}ETA.RFS`),
    // COA carries the per-weapon-token COMBAT_STAND clip MOA doesn't have
    // at all, plus the plain (non-directional) combat walk/run every race
    // needs - so it's still the primary weapon-ani archive. But COA's own
    // BW/FW/LF/RT-directional walk/run entries turn out to be Accretia-only
    // (confirmed by direct count: zero across Bell/Cora's COA archives,
    // despite this comment previously claiming otherwise) - MOA is what
    // actually carries that directional set for every *other* race, with
    // full token-for-token coverage matching COA's plain tokens. So both
    // archives are fetched; see getWeaponClip's COA-then-MOA fallback for
    // directional walk/run lookups.
    trackedFetchRfsArchive(`${ASSET_BASE}/Ani/${race.aniCode}COA.RFS`),
    trackedFetchRfsArchive(`${ASSET_BASE}/Ani/${race.aniCode}MOA.RFS`),
  ]).then(([skeletonBuffer, meshArchive, texArchive, aniArchive, weaponAniArchive, weaponMoaArchive]) => ({
    skeletonBuffer,
    meshArchive,
    texArchive,
    aniArchive,
    weaponAniArchive,
    weaponMoaArchive,
  }));
  // Cache the promise up front (not after it resolves) so concurrent callers
  // join it instead of starting their own fetch; a failed load is evicted so
  // a later retry can actually try again rather than replaying the same rejection.
  raceAssetCache.set(raceGender, promise);
  promise.catch(() => raceAssetCache.delete(raceGender));
  return promise;
}

interface RaceArmorArchives {
  meshArchives: (RfsArchive | null)[];
  texArchives: (RfsArchive | null)[];
}

const raceArmorArchiveCache = new Map<RaceGender, Promise<RaceArmorArchives>>();

/**
 * Lazily fetches (once per race, cached forever after - same reasoning as
 * raceAssetCache) the real armor-tier archives (character/player/{Mesh,Tex}/
 * {code}{R,W,F}{00,10,20,30,40}.RFS - 15 each, ~90MB/race) - everything
 * resolveItemMeshStem() resolves for a real armor item lives in one of
 * these, never in getRaceAssets()'s DEFAULT_* archive. Not part of
 * loadRaceAssets/preloadAllRaces any more - eagerly fetching this for
 * every race up front was most of the slow startup (~450MB before anyone
 * even reached the login screen); on-demand per race, triggered by
 * CharacterController's equip methods only when an item actually needs it,
 * fixes that without changing what's ultimately available.
 *
 * Individual archives resolve to `null` on failure/absence (confirmed real
 * gap: Accretia has no Face tier-1/tier-2 textures) rather than rejecting
 * the whole race - findEntryInArchives skips nulls.
 */
export function getRaceArmorArchives(raceGender: RaceGender): Promise<RaceArmorArchives> {
  let cached = raceArmorArchiveCache.get(raceGender);
  if (!cached) {
    const race = RACE_CONFIGS[raceGender];
    const armorNames = armorArchiveNames(race.meshTexCode);
    const fetchOptional = (url: string) =>
      fetchRfsArchive(url).catch((err: unknown) => {
        console.warn(`Armor archive "${url}" unavailable, skipping:`, err);
        return null;
      });
    cached = Promise.all([
      Promise.all(armorNames.map((name) => fetchOptional(`${ASSET_BASE}/Mesh/${name}.RFS`))),
      Promise.all(armorNames.map((name) => fetchOptional(`${ASSET_BASE}/Tex/${name}.RFS`))),
    ]).then(([meshArchives, texArchives]) => ({ meshArchives, texArchives }));
    raceArmorArchiveCache.set(raceGender, cached);
    cached.catch(() => raceArmorArchiveCache.delete(raceGender));
  }
  return cached;
}

const ALL_RACES = Object.values(RaceGender).filter((v): v is RaceGender => typeof v === 'number');
/** bone, mesh, tex, ani, weapon-ani, weapon-moa - the small default-body set. Armor tiers/weapons are no longer eagerly preloaded, see getRaceArmorArchives/loadParsedWeaponMesh. */
const FILES_PER_RACE = 6;

/**
 * Fetches and caches every race's default-body assets up front, so
 * switching races later never blocks on the network. Reports progress in
 * units of "files fetched" (6 per race: bone, mesh, tex, ani, weapon-ani,
 * weapon-moa), not races, for a smoother readout. Deliberately excludes
 * armor-tier archives and weapon meshes - those are loaded on demand
 * instead (see getRaceArmorArchives, loadParsedWeaponMesh), so this stays
 * fast regardless of how much equipment data exists.
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
  const baseEntries = Object.entries(animationFileNames(race.nameToken)).map(([key, fileName]) => ({ key, fileName }));
  loadClipsInto(clips, aniArchive, baseEntries, bindPoseByBone);
  // Directional backward/strafe walk/run - see LocomotionDirection. Loaded
  // eagerly alongside the base clips (same already-fetched ETA archive, six
  // small extra entries) rather than lazily like weapon clips, since every
  // race always has these and CharacterController needs them the instant
  // WASD/joystick strafing starts, not after an await.
  loadClipsInto(clips, aniArchive, directionalAnimationFileNames(race.nameToken), bindPoseByBone);

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

/** Cache key (also the character.clips key) for a weapon-conditional walk/run/stand clip - optionally further keyed by LocomotionDirection (walk/run only; STAND has no directional variant anywhere, see getWeaponClip). */
export function weaponClipKey(kind: 'walk' | 'run' | 'stand', weaponToken: string, direction?: LocomotionDirection): string {
  return direction ? `${kind}:${weaponToken}:${direction}` : `${kind}:${weaponToken}`;
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
 * weaponToken, e.g. "RKNIFE"/"TSWORD"/"DAXE"), optionally the directional
 * (backward/strafe - see LocomotionDirection) variant of walk/run. A
 * directional lookup tries COA first, then MOA: COA's own BW/LF/RT/FW
 * entries are Accretia-only (verified: zero across Bell/Cora's COA
 * archives), but MOA carries the same directional set - full token-for-
 * token coverage matching COA's plain tokens, confirmed by comparison - for
 * every other race, just under COA's plain (non-directional) walk/run and
 * MOA doesn't have STAND at all, so MOA is never consulted for those. Not
 * every race/token/direction combination exists even so (some heavy
 * weapons are Accretia-only full stop), so this can still resolve to null;
 * callers should fall back through the plain armed clip to the unarmed
 * directional one, not treat it as an error (see
 * CharacterController.resolveClipName).
 */
export async function getWeaponClip(
  raceGender: RaceGender,
  character: RfCharacter,
  kind: 'walk' | 'run' | 'stand',
  weaponToken: string,
  direction?: LocomotionDirection,
): Promise<AnimationClip | null> {
  const key = weaponClipKey(kind, weaponToken, direction);
  const cached = character.clips[key];
  if (cached) return cached;

  const race = RACE_CONFIGS[raceGender];
  const { weaponAniArchive, weaponMoaArchive } = await getRaceAssets(raceGender);
  const archives = direction ? [weaponAniArchive, weaponMoaArchive] : [weaponAniArchive];
  const segments = direction ? [`${DIRECTION_SEGMENT_PREFIX[direction]}${kind.toUpperCase()}`] : WEAPON_CLIP_SEGMENTS[kind];

  let aniEntry: RfsEntry | null = null;
  let fileName = '';
  let sourceArchive = weaponAniArchive;
  search: for (const archive of archives) {
    for (const segment of segments) {
      fileName = `${race.nameToken}_COMBAT_${segment}_${weaponToken}_NONE_01_00.ANI`;
      aniEntry = findRfsEntry(archive, fileName);
      if (aniEntry) {
        sourceArchive = archive;
        break search;
      }
    }
  }
  if (!aniEntry) return null;

  try {
    const buffer = readRfsEntry(sourceArchive, aniEntry);
    const bindPoseByBone = await getBindPoseByBoneAsync(raceGender);
    const clip = buildAnimationClip(key, parseAnimation(buffer), bindPoseByBone);
    character.clips[key] = clip;
    return clip;
  } catch (err) {
    console.warn(`Skipping weapon animation "${fileName}":`, err);
    return null;
  }
}
