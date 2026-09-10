import { Box3, LoopOnce, LoopRepeat, Matrix4, Object3D, Quaternion, SkeletonHelper, Vector3 } from 'three';
import type { AnimationAction, AnimationClip, Bone, Camera, Frustum, Group, Scene } from 'three';
import { ANI_FPS } from '../rf/animation';
import {
  CLOAK_CDN_BASE,
  LOCOMOTION_DIRECTIONS,
  RaceGender,
  buildMeshPartObjects,
  characterCdnBase,
  getWeaponClip,
  loadCloakAnimationRig,
  loadWeaponMeshObjects,
  weaponClipKey,
} from '../rf/character';
import type { CloakAnimationRig, LocomotionDirection, RfCharacter } from '../rf/character';
import { applyGradeLiveValues, buildGradeOverlay, clamp01, disposeGradeOverlay } from '../rf/gradeEffect';
import type { GradeLiveValues, GradeOverlay } from '../rf/gradeEffect';
import type { MaterialLayer } from '../rf/materialScript';
import {
  GLOW_SCROLL_UV_PER_SEC,
  GLOW_SPEED_BASE_BYTE,
  applySurfaceShine,
  buildGlowOverlay,
  buildSocketGlow,
  describeSocketEffect,
  disposeSocketGlow,
  resolveWeaponParticles,
} from '../rf/glowEffect';
import type { GlowOverlay, SocketEffectInfo, SocketGlow } from '../rf/glowEffect';
import { ALL_MODEL_TYPES, MODEL_TYPE_TO_PART_TOKEN, ModelType } from '../rf/items';
import type { ItemDefinition } from '../rf/items';
import { ParticleEffect, describeParticleEntity } from '../rf/particleSystem';
import type { ParticleEntityDebugInfo, ParticleLiveValues } from '../rf/particleSystem';
import { resolveCloakMeshStem, resolveItemMeshStem, resolveWeaponMesh } from '../rf/resource';

const ARRIVE_FRACTION_OF_RADIUS = 0.04;
/**
 * A real `.spt`'s own position/drift units (e.g. `400p.spt`'s "pos box
 * -19 0.3 0") need NO extra scale correction at all - this project
 * originally guessed a small fudge factor (0.05) on the assumption that a
 * character is "on the order of 1-2 units tall" and -19 was therefore
 * huge, but that assumption turned out to be wrong. Confirmed by direct
 * measurement: `COM_WEAPON_TSWORD_003.msh`'s own visible mesh spans
 * 28.46 raw units along its blade's own long axis - the *same* raw
 * coordinate space `.spt` position/gravity/power values are authored in
 * (both are original-client data meant to be used together) - and
 * nothing in the skeleton/weapon pipeline ever rescales that raw space
 * down: every real bone's own parsed scale is identity (verified across
 * all 30 of Accretia's bones), `buildThreeSkeleton` copies bone
 * position/scale directly with no conversion, and `CameraController.
 * frameOnCharacter` sizes the camera *proportionally to the character's
 * own computed bounding radius* rather than assuming any fixed "normal"
 * character size - the whole scene adapts to whatever raw scale the
 * mesh/skeleton data naturally has, rather than that data being
 * rescaled to fit the scene. So a socket's own local space (parented
 * weapon sub-objects, `.eff` glow billboards at a flat `SOCKET_GLOW_SIZE
 * = 0.5`, already confirmed to look correctly proportioned - see
 * glowEffect.ts) already **is** properly-scaled scene space, with no
 * extra factor needed for anything else parented there either. 1 (no
 * scaling) is therefore the real, derived value here - not a starting
 * guess - still exposed live via setDebugSocketParticleScale/
 * debugSocketParticleScale for cases this reasoning doesn't cover.
 */
const DEBUG_SOCKET_PARTICLE_SCALE = 1;
/** Exported for OnlineScene - it derives a server-units-to-scene-units scale by matching the server's own walk speed constant against this one. */
export const WALK_SPEED_RADIUS_PER_SEC = 0.9;
/** How much faster running is than walking - the actual client's ratio isn't in this data set, so this is a reasonable-looking approximation. */
const RUN_SPEED_MULTIPLIER = 1.8;
/** How much faster a "Booster" cloak (see equipCloak's isBoosterEquipped doc comment) makes running - like RUN_SPEED_MULTIPLIER, the real client's value isn't in this data set: cloakItem.json's BoostSpd field looked promising but isn't booster-specific (it's "9" for 1263 of 1572 cloak rows, including plenty of non-booster capes), so this is a reasonable-looking approximation instead. Only applies while running, not walking - matches how the original client's booster is described as a run-speed item. */
const BOOSTER_SPEED_MULTIPLIER = 1.35;
/** Cloak flight's own fixed speed (see setFlying/isFlying) - independent of the walk/run toggle entirely, not just a multiplier layered on top of one like BOOSTER_SPEED_MULTIPLIER is. No real value for this exists in the data set either; picked to read as "faster than a boosted run" while airborne. */
const FLY_SPEED_MULTIPLIER = 2.2;
const TURN_SPEED_RAD_PER_SEC = Math.PI * 2.2;
// The model's authored "forward" faces the opposite way from three.js's
// lookAt convention (-Z), so the computed facing needs a 180 degree
// correction around the character's up axis.
const FACING_CORRECTION = new Quaternion(0, 1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const CROSSFADE_SECONDS = 0.25;
/** A bone rotating more than this in a single frame is almost certainly a pop, not real motion. */
const SUSPICIOUS_ANGLE_RAD = Math.PI / 2;
const STEP_SECONDS = 1 / ANI_FPS;
const HIPS_BONE_NAME = 'Bip01 Pelvis';
const HEAD_BONE_NAME = 'Bip01 Head';

export interface CharacterBounds {
  box: Box3;
  center: Vector3;
  radius: number;
}

export interface ParticlePerformanceStats {
  effects: number;
  totalInstances: number;
  simulatedInstances: number;
  culledEffects: number;
  updateMs: number;
}

/** Camera data built once by ViewerScene each frame, then shared by the player and every bot particle controller. */
export interface ParticleCullingContext {
  frustum: Frustum;
  cameraPosition: Vector3;
}

export interface CharacterControllerCallbacks {
  onClipChange?: (name: string) => void;
  onFrameLabelChange?: (label: string) => void;
}

export type EquipResult = 'equipped' | 'default' | 'unavailable' | 'no-character';

/** The original client's battle toggle: War shows the wielded weapon and switches walk/run to their combat variant; Peace hides it and stays on the unarmed clips. */
export type BattleMode = 'peace' | 'war';
/** Which locomotion clip (and speed) click-to-move uses - independent of BattleMode, which only decides *whether* the combat variant of walk/run/stand plays. */
export type MoveMode = 'walk' | 'run';

/**
 * Every debug-relevant variable about the currently-equipped weapon in one
 * place - item catalog fields, resolved animation token/mesh stem, and both
 * cosmetic overlay systems' raw resolved parameters (glow's .eff section,
 * grade's parsed .mst layer) - see getWeaponDebugInfo. Built for
 * WeaponEditPanel's "copy for chat" readout rather than any rendering
 * logic; `glow`/`grade` being null means "no effect registered for this
 * item" (the common case), not missing data.
 */
export interface WeaponDebugInfo {
  item: ItemDefinition;
  token: string | null;
  stem: string | null;
  glow: {
    effPath: string;
    surfaceTexture: string | null;
    glowTexture: string | null;
    movementMode: number;
    speedByte: number;
  } | null;
  grade:
    | {
        letter: string;
        /** Live-editable - see GradeLiveValues/setWeaponGradeLiveValues. Starts as a copy of the parsed .mst's values, then reflects whatever's been live-edited since. */
        live: GradeLiveValues;
        /** Parsed straight from the .mst layer, read-only display - none of these are wired to rendering yet (see gradeEffect.ts's buildGradeOverlay doc comment), unlike `live`'s fields. */
        readOnly: Pick<MaterialLayer, 'type' | 'mapName' | 'uvEnv' | 'uvScale' | 'uvScaleEnd' | 'uvScaleSpeed' | 'uvRotate' | 'aniTexFrame' | 'aniTexSpeed'>;
      }
    | null;
  /** How many "effectN" sockets the weapon's own .msh carries (0 for most items) and how many of them actually got a glow billboard (see glowEffect.ts's buildSocketGlow) - socketsWithGlow < socketCount just means fewer glow-bearing .eff sections than sockets, not an error. When socketsWithGlow > 0, `glow` above is null - see applyGlowOverlay's doc comment on why the two are mutually exclusive. */
  effectSockets: { socketCount: number; socketsWithGlow: number };
  /** How many "P0N" sockets the weapon's own .msh carries (see getEquippedWeaponParticleSockets) - a separate, coexisting attachment convention from effectSockets above, found by inspecting a real weapon mesh in Blender. Not every weapon has these. */
  particleSocketCount: number;
  /** How many real `.spt` particle instances are currently spawned on this weapon (see slotParticles' own doc comment) - each one resolved from this item's own `.eff` ParticleID fields via Chef/Particle.ini, not a hardcoded stand-in. 0 is the common case (most items register no particle data at all). Cloaks carry the same real mechanism (see slotParticles) but aren't reflected here - this struct is weapon-only debug info. */
  particlesSpawned: number;
}

/**
 * Everything real about one specific weapon socket, gathered on demand
 * for `%efedit`'s per-socket click inspector - see getSocketDebugInfo.
 * `sections` is glowEffect.ts's own SocketEffectInfo.sections (`.eff`
 * data: surface/glow texture names, movement/speed bytes, raw particle
 * ids); `particles` resolves each of those ids' own `.spt` path one step
 * further, down to its real material (`.mst` or `.r3m`/`.r3t`) and
 * texture filename - `entity` is null only when that .spt itself failed
 * to load or has no entity_file at all, same "commonly missing" meaning
 * as everywhere else in this file.
 */
export interface SocketDebugInfo extends SocketEffectInfo {
  particles: { sptPath: string; entity: ParticleEntityDebugInfo | null }[];
}

/**
 * Everything `%efedit`'s per-socket inspector panel needs for one click:
 * `info` is the resolved-but-not-necessarily-running `.eff`/`.spt`/`.mst`
 * data (see getSocketDebugInfo - reports what *should* exist regardless
 * of whether anything is actually spawned right now), `liveEffects` is
 * whatever `ParticleEffect` instance(s) are *actually* attached to this
 * same socket at this moment (see getSocketParticleEffects) - the ones
 * `%efedit`'s own live-tune controls (getParticleLiveTemplate/
 * setParticleLiveValues) actually edit. A real `.spt` path in `info` can
 * have no matching entry here at all (particle test off, or still
 * mid-load) - the UI falls back to read-only display for that case.
 */
export interface EffectSocketInspection {
  info: SocketDebugInfo;
  liveEffects: { sptPath: string; effect: ParticleEffect }[];
}

/**
 * Live state for one equipped cloak's own animation rig (see
 * character.ts's loadCloakAnimationRig) - just the mixer/clips, since the
 * rig plays directly on the cloak's own already-built, already-correctly-
 * placed rigid objects (by name - "Wing00".."Wing07"/"Cloak Cover"/their
 * pivots) rather than a separate skeleton needing per-frame delta math.
 */
interface CloakSwayState {
  rig: CloakAnimationRig;
}

/** A CloakSwayState mid-UNUSE after a real unequip - see departingCloakAnimations. */
interface DepartingCloakSwayState extends CloakSwayState {
  action: AnimationAction;
  objectsToDispose: Object3D[];
}
/** The animation-token equivalent of "no weapon" in the combat clip archive - "COMBAT_FWWALK_NONE_NONE_01_00" etc, the empty-handed War-mode locomotion. */
const UNARMED_WEAPON_TOKEN = 'NONE';

/** Fetches (and caches onto character.clips) every combat clip a weapon token needs - walk/run/stand, plus walk/run's directional (backward/strafe) variants - in parallel. Best-effort: a race/token/direction combination missing one just means resolveClipName() falls back down the chain (directional armed -> plain armed -> directional unarmed -> plain unarmed). */
async function prewarmWeaponClips(raceGender: RaceGender, character: RfCharacter, weaponToken: string): Promise<void> {
  const tasks: Promise<unknown>[] = (['walk', 'run', 'stand'] as const).map((kind) =>
    getWeaponClip(raceGender, character, kind, weaponToken).catch(() => null),
  );
  for (const kind of ['walk', 'run'] as const) {
    for (const direction of LOCOMOTION_DIRECTIONS) {
      tasks.push(getWeaponClip(raceGender, character, kind, weaponToken, direction).catch(() => null));
    }
  }
  await Promise.all(tasks);
}

function disposeObject3D(root: Object3D): void {
  root.traverse((obj) => {
    const renderable = obj as { geometry?: { dispose(): void }; material?: unknown };
    renderable.geometry?.dispose();
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    for (const material of materials as { map?: { dispose(): void; userData?: Record<string, unknown> }; dispose(): void }[]) {
      // A pooled weapon texture (see character.ts's loadParsedWeaponMesh) is
      // shared across every equip of that weapon, not owned by this one -
      // disposing it here would break every other currently-equipped
      // instance of the same weapon (present or future - bots don't equip
      // weapons yet, but nothing stops that later). Its geometry needs no
      // equivalent guard: each equip gets its own fresh BufferGeometry
      // instance regardless (see loadWeaponMeshObjects), safe to dispose
      // individually even though the underlying vertex arrays are shared.
      if (!material.map?.userData?.pooled) material.map?.dispose();
      material.dispose();
    }
  });
}

/**
 * Owns the currently-mounted RfCharacter: adding/disposing its group and
 * skeleton helper, per-slot equipping (including the default body, which
 * goes through the exact same path so a later item swap correctly replaces
 * it instead of rendering underneath it), click-to-move movement + facing,
 * animation clip crossfades, the frame-stepping debug tools, and the
 * pose-anomaly watchdog. Scene-aware only enough to add/remove its own
 * objects - camera framing and the click-to-move target marker are the
 * caller's job (they're cross-cutting scene concerns, not character state).
 */
export class CharacterController {
  private character: RfCharacter | null = null;
  private raceGender: RaceGender | null = null;
  private skeletonHelper: SkeletonHelper | null = null;
  private hipsBone: Bone | null = null;
  private headBone: Bone | null = null;

  /** The three.js objects currently equipped per slot, so a later swap knows exactly what to remove. */
  private equippedObjects: Partial<Record<ModelType, Object3D[]>> = {};
  /**
   * The Chef/ glow-effect overlay (see glowEffect.ts) attached per slot,
   * if that slot's item has one registered - siblings of equippedObjects'
   * meshes, not their children, so they aren't caught by
   * disposeObject3D()'s traversal when a slot is re-equipped; disposed
   * explicitly wherever equippedObjects[slot] is replaced.
   */
  private equippedGlowOverlays: Partial<Record<ModelType, GlowOverlay>> = {};

  /** weaponItem.json's Grade-driven Chef/GradeEffect/ cosmetic overlay (see gradeEffect.ts) - only ever populated for ModelType.Weapon (no other item file carries a Grade field), same disposal/lifecycle reasoning as equippedGlowOverlays above. */
  private equippedGradeOverlays: Partial<Record<ModelType, GradeOverlay>> = {};

  /** Per-socket glow billboards (see glowEffect.ts's buildSocketGlow) - weapon-only (no other slot has "effectN" attachment sockets), and mutually exclusive with equippedGlowOverlays[Weapon]: applyGlowOverlay uses this instead of the whole-mesh-surface aura whenever the equipped weapon actually has sockets, falling back to the whole-mesh path otherwise. */
  private equippedSocketGlow: SocketGlow | null = null;

  /**
   * Debug/test-only (WeaponEditPanel's upgrade-level dropdown - see
   * setDebugWeaponUpgradeLevel): simulates weaponItem.json's real
   * per-item upgrade level (+0..+7, not tracked anywhere else in this
   * project - every other equip path implicitly assumes +0), which
   * PatternList.txt uses to pick a different .eff for the same item (see
   * glowEffect.ts's patternColumnForUpgradeLevel). 0 (the default) behaves
   * identically to every code path that doesn't know this exists.
   */
  private debugWeaponUpgradeLevel = 0;

  /**
   * The currently-equipped item's REAL particle set, per slot (see
   * particleSystem.ts's ParticleEffect) - one instance per (socket,
   * .spt path) pair resolved by glowEffect.ts's resolveWeaponParticles,
   * which reads each `.eff` section's own ParticleID1/2/3 fields and
   * looks each up in `Chef/Particle.ini` to get a real path (confirmed
   * end-to-end: `Unick_TSWORDlv1.EFF`'s "EFFECT1"-labeled section
   * resolves to `Chef/Unick_up/C_W_TSWORD/400p.spt`, the exact file this
   * project had previously been hardcoding here as an unconfirmed guess -
   * see docs/rf-format-notes.md). Not weapon-only: cloaks carry the exact
   * same mechanism (confirmed on the "Premium Booster"/"Blood Booster"
   * cloak's own real `.eff`, `Chef/Eff/Armor/BELMALE_A_CLOAK.EFF`, whose
   * particle-bearing sections are labeled "BALL00".."BALL03"/"P03" - a
   * *third* socket-naming convention alongside weapons' "effectN"/"P0N",
   * which is why particle-socket candidates for this map are every one of
   * the slot's own equipped sub-objects (see spawnSlotParticles), not
   * either weapon-specific name filter). An item with no registered
   * particle data at all (most items) just leaves its slot unset here -
   * not every item has one, same as glow.
   */
  private slotParticles: Partial<Record<ModelType, ParticleEffect[]>> = {};
  /** Which socket + resolved .spt path each entry in slotParticles came from - side bookkeeping `spawnSlotParticles` fills in alongside `slotParticles` itself, purely so `%efedit`'s per-socket inspector (getSocketParticleEffects) can find "the effect(s) currently running for socket X" without slotParticles itself needing to change shape (it's iterated elsewhere - setDebugSocketParticleScale, updateDebugSocketParticle - as a flat per-slot array, which stays simplest for those). Cleared alongside its effect in disposeSlotParticles. */
  private particleEffectMeta = new Map<ParticleEffect, { socket: Object3D; sptPath: string }>();
  private particlePerformance: ParticlePerformanceStats = { effects: 0, totalInstances: 0, simulatedInstances: 0, culledEffects: 0, updateMs: 0 };
  /** Live-tunable via setDebugSocketParticleScale - see DEBUG_SOCKET_PARTICLE_SCALE's own doc comment on why 1 (no scaling) is the actual derived value, not just a starting guess. */
  private debugSocketParticleScale = DEBUG_SOCKET_PARTICLE_SCALE;
  /**
   * User intent, separate from slotParticles' own on/off state - defaults
   * to true so an item's real particle set is visible out of the box
   * instead of needing "%particletest 1" typed every session. equipWeapon/
   * equipCloak each re-check this after building their new item's own
   * objects so the effect follows whatever's currently equipped
   * automatically instead of only attaching once. Only
   * setDebugSocketParticleEnabled's own explicit `enabled` argument
   * (RfViewer's %particletest command) changes this - re-equipping never
   * does.
   */
  private debugSocketParticleWanted = true;

  /**
   * Which of the 5 pre-made DEFAULT_{PART}_00{0-4} variants each base slot
   * (see ALL_MODEL_TYPES) uses when nothing's equipped there - the
   * character-creation-time customization (hair for Bell/Cora's Helmet
   * slot, face, body shape, ...). Unset means variant 0, matching this
   * project's original hardcoded "_000" behavior. See setBaseAppearance.
   */
  private baseAppearance: Partial<Record<ModelType, number>> = {};
  /** Which real item (if any) currently covers each body slot - lets setBaseAppearance know whether changing the base variant should visually apply immediately or just be remembered for later. Weapon tracks its own equivalent (currentWeaponItem) instead, since it goes through equipWeapon, not this. */
  private currentBodyItem: Partial<Record<ModelType, ItemDefinition | null>> = {};

  /**
   * The Helmet slot's base-appearance objects (hair, on Bell/Cora) - kept
   * alive (and visible) for as long as the character exists, rather than
   * disposed/rebuilt every time a real Helmet item is equipped or removed
   * like every other base slot's default mesh. Both this and
   * equippedObjects[Helmet] (the real item, if any) exist and render
   * simultaneously - a helmet overlays on top of hair, it doesn't hide it
   * (matches the real client). See equipHelmet.
   */
  private helmetBaseObjects: Object3D[] = [];
  /** Which variant helmetBaseObjects was actually built for, so equipHelmet only rebuilds it when baseAppearance[Helmet] has genuinely changed since (not on every equip/unequip). Null before the first build. */
  private helmetBaseVariant: number | null = null;

  /** The currently-wielded weapon's animation-set token (see resolveWeaponMesh), or null when unarmed - consulted by update() to pick the armed vs. unarmed walk/run clip. */
  private currentWeaponToken: string | null = null;
  /** The currently-equipped weapon item itself (id/name/model), or null when unarmed - kept alongside currentWeaponToken purely for debug display (StatsPanel), not consulted by animation/placement logic. */
  private currentWeaponItem: ItemDefinition | null = null;
  /** The resolved weapon mesh stem (see resolveWeaponMesh) actually loaded for the current weapon - the .msh whose parentName/objectMatrix drive placement, useful for debugging a specific item's rigid-attach math. Debug display only, same as currentWeaponItem. */
  private currentWeaponStem: string | null = null;
  /** Peace/War toggle - see BattleMode. Only War shows the weapon mesh and plays combat walk/run; Peace always plays the unarmed clips regardless of what's equipped. */
  private battleMode: BattleMode = 'peace';

  /** Whether the currently-equipped cloak is a "Booster" item (see equipCloak) - consulted by getCurrentSpeed() to apply BOOSTER_SPEED_MULTIPLIER while running. Not a separate equip slot in the real game; just a cosmetically-distinct cloak. */
  private isBoosterEquipped = false;

  /** Player-invoked "Fly" toggle (see setFlying) - independent of isBoosterEquipped/getCurrentSpeed's automatic run-speed mechanic above. While true, getDesiredLocomotionClip/getIdleClip both resolve to "fly" (and its own backward/left/right variants) regardless of moveMode or whether anything is actually moving. */
  private isFlying = false;

  /** The currently-equipped cloak's own animation rig (see applyCloakAnimation) - null for the common case of a cloak with no bone/ani data, or no cloak equipped at all. */
  private cloakAnimation: CloakSwayState | null = null;
  /**
   * Cloak sway states mid-UNUSE (retract) after a real unequip - kept
   * alive and updated independently of cloakAnimation (already cleared by
   * the time these exist) purely so their retract animation can finish
   * playing before their objects are actually disposed - see equipCloak's
   * `!item` branch. A re-equip happening while one of these is still
   * playing doesn't touch it; it just finishes on its own and gets pruned.
   */
  private departingCloakAnimations: DepartingCloakSwayState[] = [];

  private moveTarget: Vector3 | null = null;
  /** Continuous move input (e.g. from a mobile joystick or WASD), world-space XZ - magnitude 0-1 scales speed. Takes priority over moveTarget; see setMoveDirection. */
  private moveDirection: Vector3 | null = null;
  /** Which way to face while moveDirection is active - usually moveDirection itself, but a pure sideways input (see ViewerScene) passes just the forward component here instead, so strafing doesn't spin the character 90° to face directly sideways. */
  private faceDirection: Vector3 | null = null;
  /** Which real backward/strafe clip to play instead of plain walk/run while moveDirection is active - see LocomotionDirection and resolveClipName. Null means "mostly forward" (plain walk/run, face the way you're moving - unchanged default behavior). */
  private moveLocomotionDirection: LocomotionDirection | null = null;
  private walkSpeed = 1;
  private arriveThreshold = 0.05;
  /** Walk vs run - see MoveMode. Only affects click-to-move (moveTo()); a manual setClip('run') from a debug button is unaffected. */
  private moveMode: MoveMode = 'walk';

  // The render loop reads desiredClip every frame to decide whether to start
  // a transition - not React state, so there's no gap between "caller asked
  // for this clip" and "the mixer actually starts blending toward it".
  private desiredClip = 'stand';
  private currentClipKey: string | null = null;
  private activeAction: AnimationAction | null = null;
  private debugPaused = false;
  private showBones = false;

  private readonly lastQuatByBone = new Map<string, Quaternion>();
  private readonly lookMatrix = new Matrix4();
  private readonly lookTargetQuat = new Quaternion();
  private readonly worldYawQuat = new Quaternion();

  constructor(
    private readonly scene: Scene,
    private readonly callbacks: CharacterControllerCallbacks = {},
  ) {}

  get group(): Group | null {
    return this.character?.group ?? null;
  }

  getCharacter(): RfCharacter | null {
    return this.character;
  }

  getHipsBone(): Bone | null {
    return this.hipsBone;
  }

  getHeadBone(): Bone | null {
    return this.headBone;
  }

  isMoving(): boolean {
    return this.moveTarget !== null || this.moveDirection !== null;
  }

  /** The resolved animation clip key actually playing right now (e.g. "walk:TCROSSBOW:rt", "stand"), or null before the first frame resolves one - see resolveClipName. Debug display only (StatsPanel). */
  getCurrentClipKey(): string | null {
    return this.currentClipKey;
  }

  /** The currently-equipped weapon (item + resolved animation token + mesh stem), or null when unarmed. Debug display only (StatsPanel) - see currentWeaponItem/currentWeaponToken/currentWeaponStem. */
  getCurrentWeapon(): { item: ItemDefinition; token: string | null; stem: string | null } | null {
    return this.currentWeaponItem ? { item: this.currentWeaponItem, token: this.currentWeaponToken, stem: this.currentWeaponStem } : null;
  }

  /** See WeaponDebugInfo - null when unarmed. `glow`/`grade` are only populated once their respective fire-and-forget applyGlowOverlay/applyGradeOverlay have actually resolved (both fast, same-tick-or-next in practice), and stay null forever for the common case of an item with no registered effect. */
  getWeaponDebugInfo(): WeaponDebugInfo | null {
    if (!this.currentWeaponItem) return null;
    const glowOverlay = this.equippedGlowOverlays[ModelType.Weapon];
    const gradeOverlay = this.equippedGradeOverlays[ModelType.Weapon];
    return {
      item: this.currentWeaponItem,
      token: this.currentWeaponToken,
      stem: this.currentWeaponStem,
      glow:
        glowOverlay?.effPath && glowOverlay.section
          ? {
              effPath: glowOverlay.effPath,
              surfaceTexture: glowOverlay.section.surfaceTexture,
              glowTexture: glowOverlay.section.glowTexture,
              movementMode: glowOverlay.section.movementMode,
              speedByte: glowOverlay.section.speedByte,
            }
          : null,
      grade:
        gradeOverlay?.letter && gradeOverlay.layer && gradeOverlay.liveValues
          ? {
              letter: gradeOverlay.letter,
              live: gradeOverlay.liveValues,
              readOnly: {
                type: gradeOverlay.layer.type,
                mapName: gradeOverlay.layer.mapName,
                uvEnv: gradeOverlay.layer.uvEnv,
                uvScale: gradeOverlay.layer.uvScale,
                uvScaleEnd: gradeOverlay.layer.uvScaleEnd,
                uvScaleSpeed: gradeOverlay.layer.uvScaleSpeed,
                uvRotate: gradeOverlay.layer.uvRotate,
                aniTexFrame: gradeOverlay.layer.aniTexFrame,
                aniTexSpeed: gradeOverlay.layer.aniTexSpeed,
              },
            }
          : null,
      effectSockets: {
        socketCount: this.getEquippedWeaponEffectSockets().length,
        socketsWithGlow: this.equippedSocketGlow?.objects.length ?? 0,
      },
      particleSocketCount: this.getEquippedWeaponParticleSockets().length,
      particlesSpawned: this.slotParticles[ModelType.Weapon]?.length ?? 0,
    };
  }

  /** Live-editable grade-overlay values for the currently-equipped weapon, or null if it has no grade overlay - see GradeLiveValues/setWeaponGradeLiveValues. */
  getWeaponGradeLiveValues(): GradeLiveValues | null {
    return this.equippedGradeOverlays[ModelType.Weapon]?.liveValues ?? null;
  }

  /**
   * Debug/tuning tool (WeaponEditPanel): overrides any subset of the
   * currently-equipped weapon's grade-overlay values, taking effect
   * immediately (opacity/color right away via applyGradeLiveValues; uv
   * scroll/alpha-flicker on the very next updateGradeAnimation tick, since
   * that reads liveValues fresh every frame) - lets a real value be found
   * by eye and reported back rather than guessed at from the source .mst
   * alone. No-op if the current weapon has no grade overlay at all.
   */
  setWeaponGradeLiveValues(patch: Partial<GradeLiveValues>): void {
    const overlay = this.equippedGradeOverlays[ModelType.Weapon];
    if (!overlay?.liveValues) return;
    applyGradeLiveValues(overlay, { ...overlay.liveValues, ...patch });
  }

  /** The currently-equipped weapon's rendered rigid part (e.g. "W00" - see buildObjectsFromParsedMesh), or null when unarmed. Every real weapon checked so far resolves to exactly one non-empty sub-object, so the first is returned; a weapon with more than one visible part would only expose the first here. Debug-only (the %wpedit gizmo attaches to this directly - its .position/.quaternion already ARE the local offset from the bone it's rigidly parented to, the same values the placement math in character.ts computes). */
  getEquippedWeaponObject(): Object3D | null {
    return this.equippedObjects[ModelType.Weapon]?.[0] ?? null;
  }

  /**
   * Named "effectN" dummy pivot sub-objects on the currently-equipped
   * weapon's own .msh (e.g. "effect1"/"effect2" on COM_WEAPON_TMACE_156,
   * confirmed by parsing the real file) - one of two coexisting attachment-
   * socket naming conventions a real `.eff` section's own label
   * (EffSection.socketLabel) can name-match against (see
   * getEquippedWeaponParticleSockets for the other, "P0N"). Both glow
   * sections (buildSocketGlow) and particle-bearing sections
   * (resolveWeaponParticles) target sockets from either convention by
   * name - "effectN" is not glow-only, confirmed on a real weapon
   * (`Unick_DAXElv7.EFF`'s own particle-bearing sections are labeled
   * "EFFECT1"/"EFFECT3", not "P0N"). Empty (0-vertex) Object3D nodes,
   * already correctly positioned/parented by buildObjectsFromParsedMesh -
   * equippedObjects already holds every sub-object flat (not just visible
   * ones), so this is just a name filter, nothing to compute. Debug-only
   * (the %efedit visual markers - see ViewerScene.setEffectEditEnabled -
   * attach directly to whatever this returns).
   */
  getEquippedWeaponEffectSockets(): Object3D[] {
    return (this.equippedObjects[ModelType.Weapon] ?? []).filter((obj) => /^effect\d*$/i.test(obj.name));
  }

  /**
   * Named "P0N" dummy pivot sub-objects on the currently-equipped
   * weapon's own .msh (e.g. "P01".."P04" on COM_WEAPON_TSWORD_003,
   * confirmed by parsing the real file, alongside that same weapon's own
   * "effect1"/"effect2" - the two naming conventions coexist, not one
   * replacing the other) - found by inspecting a real weapon mesh
   * directly in Blender. Not exclusively for particles, and not every
   * weapon has these (confirmed absent on COM_WEAPON_DSWORD_200/
   * COM_WEAPON_TMACE_156, which only have "effectN") - see
   * getEquippedWeaponEffectSockets's own doc comment on why a real
   * `.eff` section can target either convention by name regardless of
   * whether it carries a glow texture, particle ids, or both. Same "just
   * a name filter, already-built and correctly placed" reasoning as
   * getEquippedWeaponEffectSockets.
   */
  getEquippedWeaponParticleSockets(): Object3D[] {
    return (this.equippedObjects[ModelType.Weapon] ?? []).filter((obj) => /^p\d+$/i.test(obj.name));
  }

  /**
   * Debug-only: everything real about one specific weapon socket - which
   * `.eff` section(s) explicitly target it by name, their glow/surface
   * texture names, and every real `.spt` particle path they resolve to,
   * each further resolved down to its own real material (`.mst` or
   * `.r3m`/`.r3t`) and texture filename (see glowEffect.ts's
   * describeSocketEffect / particleSystem.ts's describeParticleEntity for
   * how each half is gathered). Built for `%efedit`'s per-socket click
   * inspector (ViewerScene) - null while unarmed, since there's no
   * `.eff` chain to resolve at all without an equipped weapon.
   */
  async getSocketDebugInfo(socket: Object3D): Promise<SocketDebugInfo | null> {
    const item = this.currentWeaponItem;
    if (!item) return null;

    const effInfo = await describeSocketEffect(item.model, socket.name, this.debugWeaponUpgradeLevel);
    const particles = await Promise.all(
      effInfo.particlePaths.map(async (sptPath) => ({ sptPath, entity: await describeParticleEntity(sptPath) })),
    );

    return { ...effInfo, particles };
  }

  /**
   * Every currently-running `ParticleEffect` actually attached to one
   * specific socket right now (see particleEffectMeta's own doc comment)
   * - not the same thing as getSocketDebugInfo's own `particles` list,
   * which reports what *should* resolve from the `.eff`/`Particle.ini`
   * chain regardless of whether anything is actually spawned (e.g.
   * `%particletest` turned off, or still mid-load). Used by `%efedit`'s
   * inspector panel to find the live `ParticleEffect` instance(s) a
   * displayed `.spt` path's live-tune controls should actually edit - the
   * panel reads each one's current values directly via its own public
   * `getLiveTemplate()` (see setParticleLiveValues below for the write
   * side).
   */
  getSocketParticleEffects(socket: Object3D): { sptPath: string; effect: ParticleEffect }[] {
    const result: { sptPath: string; effect: ParticleEffect }[] = [];
    for (const [effect, meta] of this.particleEffectMeta) {
      if (meta.socket === socket) result.push({ sptPath: meta.sptPath, effect });
    }
    return result;
  }

  /** Live-tunes one running particle effect's own template values in place - see ParticleEffect.setLiveValues for what rebuilding on every change actually means for the fields involved. Built for `%efedit`'s inspector panel. */
  setParticleLiveValues(effect: ParticleEffect, patch: Partial<ParticleLiveValues>): void {
    effect.setLiveValues(patch);
  }

  /** Only fires onClipChange when the resolved desired clip actually changes, so continuous per-frame callers (the joystick) don't spam it every frame. */
  private setDesiredClip(name: string): void {
    if (this.desiredClip === name) return;
    this.desiredClip = name;
    this.callbacks.onClipChange?.(name);
  }

  setShowBones(show: boolean): void {
    this.showBones = show;
    if (this.skeletonHelper) this.skeletonHelper.visible = show;
  }

  /** Debug-only: which animation states the currently-equipped cloak's own rig actually has (see applyCloakAnimation) - empty if no cloak is equipped, or it has no bone/ani data at all. For populating a manual clip-preview dropdown; not consulted by the real EQUIP->USE->UNUSE state machine. */
  getCloakAnimationStateNames(): string[] {
    return this.cloakAnimation ? Object.keys(this.cloakAnimation.rig.clips) : [];
  }

  /**
   * Debug-only: force-plays one of the current cloak rig's clips directly,
   * looping so it stays visible for inspection instead of playing once and
   * freezing on the last frame - bypasses the real EQUIP->USE->UNUSE state
   * machine entirely (this is for previewing a specific clip in isolation,
   * not simulating a real equip/unequip). No-op if there's no active cloak
   * rig, or it doesn't have this particular state.
   */
  playCloakAnimationState(stateName: string): void {
    const rig = this.cloakAnimation?.rig;
    if (!rig) return;
    const clip = (rig.clips as Record<string, AnimationClip | undefined>)[stateName];
    if (!clip) return;
    console.log(`[anim-debug] cloak sway: manually previewing "${stateName}" (duration ${clip.duration.toFixed(3)}s)`);
    rig.mixer.stopAllAction();
    rig.mixer.clipAction(clip).reset().setLoop(LoopRepeat, Infinity).play();
  }

  getBattleMode(): BattleMode {
    return this.battleMode;
  }

  /**
   * Toggles Peace/War, same as the original client's battle-mode button.
   * Only the weapon mesh's visibility and update()'s clip resolution
   * (resolveClipName) change synchronously here - the war-mode walk/run/
   * stand clips for whatever's currently in hand (or the empty-handed
   * variant, if nothing is) are fetched in the background and just aren't
   * ready for a frame or two after a fresh equip+toggle; resolveClipName()
   * falls back to the unarmed clip transparently until they land, same as
   * any other "commonly missing" animation lookup in this codebase.
   */
  setBattleMode(mode: BattleMode): void {
    this.battleMode = mode;
    this.applyWeaponVisibility();

    if (mode === 'war' && this.character && this.raceGender !== null) {
      void prewarmWeaponClips(this.raceGender, this.character, this.currentWeaponToken ?? UNARMED_WEAPON_TOKEN);
    }
  }

  /** A wielded weapon (and its grade overlay, if it has any) is only ever visible in War mode - see setBattleMode/equipWeapon. Whole-mesh glow no longer has a separate object to toggle - it's injected directly into the weapon mesh's own material (see glowEffect.ts's attachGlowInjection), so it's already hidden/shown along with `weaponObjects` above. */
  private applyWeaponVisibility(): void {
    const visible = this.battleMode === 'war';
    const weaponObjects = this.equippedObjects[ModelType.Weapon];
    if (weaponObjects) for (const obj of weaponObjects) obj.visible = visible;
    const gradeOverlay = this.equippedGradeOverlays[ModelType.Weapon];
    if (gradeOverlay) for (const obj of gradeOverlay.objects) obj.visible = visible;
    if (this.equippedSocketGlow) for (const obj of this.equippedSocketGlow.objects) obj.visible = visible;
  }

  /** Drops the stale scrollingMaterials bookkeeping for one slot before a re-equip - there's no separate glow object to dispose anymore (see glowEffect.ts's attachGlowInjection/GlowOverlay doc comments): the injected material lives inside the mesh itself, already torn down by the normal disposeObject3D traversal when that mesh is disposed. */
  private disposeGlowOverlayFor(modelType: ModelType): void {
    delete this.equippedGlowOverlays[modelType];
  }

  private disposeSocketGlowForWeapon(): void {
    if (!this.equippedSocketGlow) return;
    disposeSocketGlow(this.equippedSocketGlow);
    this.equippedSocketGlow = null;
  }

  private disposeGradeOverlayFor(modelType: ModelType): void {
    const overlay = this.equippedGradeOverlays[modelType];
    if (!overlay) return;
    disposeGradeOverlay(overlay);
    delete this.equippedGradeOverlays[modelType];
  }

  /**
   * Best-effort, fire-and-forget: resolves and attaches a Chef/ glow
   * overlay (see glowEffect.ts) for a just-equipped item, if the Chef/
   * effect tables have one registered for it - most items don't, and
   * that's not an error. Deliberately not awaited by equipItem/
   * equipWeapon, since glow is a purely cosmetic addition that shouldn't
   * delay the equip result the caller is waiting on. `sourceObjects` is
   * compared against the slot's *current* equippedObjects entry once this
   * resolves (not just this.character, unlike other awaits in this class)
   * because a slot can be re-equipped again before this lands without the
   * character itself changing.
   *
   * For a weapon whose own .msh actually has "effectN" attachment sockets
   * (see getEquippedWeaponEffectSockets/glowEffect.ts's buildSocketGlow),
   * this renders one small glow billboard per socket instead of the usual
   * whole-mesh-surface aura - a real multi-record .eff carries one
   * independent glow per attachment point (confirmed on
   * COM_WEAPON_TMACE_144_1.EFF), so smearing just the first one across the
   * entire weapon surface (the old, and still the fallback, behavior) is
   * the less accurate rendering whenever sockets are actually present.
   * Falls through to the whole-mesh path if the weapon has no sockets, or
   * the socket build came back empty despite the item having a registered
   * effect (e.g. its .eff has sections but none carry a glowTexture at
   * all - buildGlowOverlay would find that out itself below anyway).
   */
  private async applyGlowOverlay(
    modelType: ModelType,
    item: ItemDefinition | null,
    character: RfCharacter,
    sourceObjects: Object3D[],
  ): Promise<void> {
    if (!item) return; // defaults/unequips have no catalog entry to look up a glow effect for

    const upgradeLevel = modelType === ModelType.Weapon ? this.debugWeaponUpgradeLevel : 0;

    if (modelType === ModelType.Weapon) {
      const sockets = this.getEquippedWeaponEffectSockets();
      if (sockets.length > 0) {
        const socketGlow = await buildSocketGlow(item.model, sockets, upgradeLevel);
        if (this.character !== character || this.equippedObjects[modelType] !== sourceObjects) {
          disposeSocketGlow(socketGlow); // superseded mid-await - character swapped, or this slot got equipped again
          return;
        }
        if (socketGlow.objects.length > 0) {
          this.equippedSocketGlow = socketGlow;
          this.applyWeaponVisibility();
          return; // handled per-socket - skip the whole-mesh-surface aura below entirely
        }
        disposeSocketGlow(socketGlow); // built but empty - fall through to the whole-mesh path
      }
    }

    const overlay = await buildGlowOverlay(item.model, sourceObjects, upgradeLevel);
    // No disposal needed on the superseded-mid-await path here (unlike the
    // socket-glow branch above) - buildGlowOverlay injects straight into
    // sourceObjects' own materials rather than creating anything separate,
    // so a stale write just lands on meshes that are already detached and
    // about to be garbage-collected, same reasoning applySurfaceShineFor's
    // own doc comment gives.
    if (this.character !== character || this.equippedObjects[modelType] !== sourceObjects) return;
    if (overlay.appliedCount === 0) return;

    this.equippedGlowOverlays[modelType] = overlay;
    if (modelType === ModelType.Weapon) this.applyWeaponVisibility();
  }

  /**
   * Per-frame upkeep for every currently-active per-socket glow billboard
   * (see glowEffect.ts's buildSocketGlow) - each one now renders through a
   * shared per-texture SocketGlowBatch (see glowEffect.ts's own doc
   * comment), so this just delegates to each billboard's own `update()`,
   * which repositions its batch row to face the camera and advances its UV
   * scroll for whichever ones came from a movementMode-2 (scrolling)
   * section. No-op (and cheap) when unarmed or the weapon has no socket
   * glow.
   */
  updateSocketGlowBillboards(camera: Camera, delta: number): void {
    const glow = this.equippedSocketGlow;
    if (!glow) return;
    for (const billboard of glow.objects) billboard.update(camera, delta);
  }

  /**
   * Best-effort, fire-and-forget: resolves and attaches a Chef/GradeEffect/
   * weapon-grade overlay (see gradeEffect.ts) for a just-equipped item, if
   * its Grade field (weaponItem.json only) maps to one - grade 0 ("Common")
   * and every other slot's items never do. Same staleness-check/lifecycle
   * pattern as applyGlowOverlay above (a separate overlay+bookkeeping map,
   * not folded into it, since a weapon can have both a glow *and* a grade
   * overlay at once - they're independent Chef/ mechanisms).
   */
  private async applyGradeOverlay(
    modelType: ModelType,
    item: ItemDefinition | null,
    character: RfCharacter,
    sourceObjects: Object3D[],
  ): Promise<void> {
    if (!item) return; // defaults/unequips have no catalog entry to look up a grade for

    const overlay = await buildGradeOverlay(item.grade, sourceObjects);
    if (this.character !== character || this.equippedObjects[modelType] !== sourceObjects) {
      disposeGradeOverlay(overlay); // superseded mid-await - character swapped, or this slot got equipped again
      return;
    }
    if (overlay.objects.length === 0) return;

    this.equippedGradeOverlays[modelType] = overlay;
    if (modelType === ModelType.Weapon) this.applyWeaponVisibility();
  }

  /**
   * Best-effort, fire-and-forget: applies a Chef/ surface-shine effect (see
   * applySurfaceShine's doc comment) for a just-equipped item, if it has
   * one registered. Unlike applyGlowOverlay, no staleness check or
   * disposal bookkeeping is needed here - applySurfaceShine mutates
   * sourceObjects' own mesh materials in place rather than adding separate
   * objects, so a stale/superseded write just lands on a mesh that's
   * already been detached and is about to be garbage collected, which is
   * harmless.
   */
  private async applySurfaceShineFor(item: ItemDefinition | null, sourceObjects: Object3D[], upgradeLevel = 0): Promise<void> {
    if (!item) return; // defaults/unequips have no catalog entry to look up an effect for
    await applySurfaceShine(item.model, sourceObjects, upgradeLevel);
  }

  /** Advances every currently-active scrolling glow texture (movementMode 2 - see glowEffect.ts) by one frame - mutates each injected material's own uvOffset uniform holder (see attachGlowInjection) rather than a texture's .offset, since the glow texture is shared across every mesh currently using it (loadChefTexture's own cache) and no longer has a dedicated material of its own to carry a per-mesh offset. */
  private updateGlowAnimation(delta: number): void {
    for (const overlay of Object.values(this.equippedGlowOverlays)) {
      for (const { uvOffset, speedByte } of overlay.scrollingMaterials) {
        const speedFactor = 2 ** (speedByte - GLOW_SPEED_BASE_BYTE);
        uvOffset.value = (uvOffset.value + speedFactor * GLOW_SCROLL_UV_PER_SEC * delta) % 1;
      }
    }
  }

  /** Advances every currently-active grade overlay's uv-scroll and alpha-flicker by one frame, reading straight from its (possibly live-edited - see setWeaponGradeLiveValues) liveValues every time rather than a value baked in at build time. scrollU/scrollV are already plain UV-units/second, unlike updateGlowAnimation's exponential speed-byte decode. */
  private updateGradeAnimation(delta: number): void {
    for (const overlay of Object.values(this.equippedGradeOverlays)) {
      const values = overlay.liveValues;
      if (!values || overlay.materials.length === 0) continue;

      overlay.phase = (overlay.phase + delta * values.aniAlphaFlicker) % 1;
      const baseOpacity = clamp01(values.alpha / 255);
      const minOpacity = clamp01(baseOpacity * values.aniAlphaFlickerStart);
      const maxOpacity = clamp01(baseOpacity * values.aniAlphaFlickerEnd);
      const t = (Math.sin(overlay.phase * Math.PI * 2) + 1) / 2; // 0..1, one full cycle per "aniAlphaFlicker" seconds - a no-op (always baseOpacity) when min===max
      const opacity = minOpacity + (maxOpacity - minOpacity) * t;

      for (const material of overlay.materials) {
        material.opacity = opacity;
        const texture = material.map;
        if (!texture) continue;
        texture.offset.x = (texture.offset.x + values.uvScrollU * delta) % 1;
        texture.offset.y = (texture.offset.y + values.uvScrollV * delta) % 1;
      }
    }
  }

  /** Advances one cloak sway rig's mixer by one frame - the clip drives the cloak's own already-placed rigid objects directly by name (see loadCloakAnimationRig's doc comment), no extra per-frame math needed. Shared by the active cloakAnimation and every still-finishing departingCloakAnimations entry. */
  private updateCloakSway(state: CloakSwayState, delta: number): void {
    state.rig.mixer.update(delta);
  }

  /**
   * Best-effort, fire-and-forget: loads a just-equipped cloak's own
   * animation clips (see character.ts's loadCloakAnimationRig), if it has
   * any - most cloaks don't, and that's not an error, same reasoning as
   * applyGlowOverlay. Finds the one object among `sourceObjects` actually
   * parented to a real character bone (everything else in the rigid
   * sibling chain - see buildObjectsFromParsedMesh - hangs off it already)
   * to use as both the clip's target and its bind-pose source, and starts
   * EQUIP (falling through to a looping USE once it finishes, or
   * immediately if EQUIP is missing).
   */
  private async applyCloakAnimation(stem: string, character: RfCharacter, sourceObjects: Object3D[]): Promise<void> {
    const boneSet = new Set<Object3D>(character.builtSkeleton.bones);
    const target = sourceObjects.find((o) => o.parent && boneSet.has(o.parent));
    if (!target) return; // no sub-object is directly parented to a real skeleton bone - nothing to animate from

    const rig = await loadCloakAnimationRig(stem, target);
    if (this.character !== character || this.equippedObjects[ModelType.Cloak] !== sourceObjects) return; // superseded mid-await
    if (!rig) return; // common case - this cloak has no ani data

    const state: CloakSwayState = { rig };
    this.cloakAnimation = state;

    const equipClip = rig.clips.EQUIP;
    const useClip = rig.clips.USE;
    if (equipClip) {
      const equipAction = rig.mixer.clipAction(equipClip).reset();
      equipAction.setLoop(LoopOnce, 1);
      equipAction.clampWhenFinished = true;
      equipAction.play();
      if (useClip) {
        const onEquipFinished = (e: { action: AnimationAction }) => {
          if (e.action !== equipAction) return;
          rig.mixer.removeEventListener('finished', onEquipFinished);
          // clampWhenFinished keeps equipAction "running" (frozen on its last
          // frame, still contributing weight) even after this fires - left
          // alone, the mixer blends that frozen pose together with useClip's
          // loop instead of replacing it, damping the idle sway down to
          // near-invisible. Stop it explicitly so useClip has the track to
          // itself.
          equipAction.stop();
          rig.mixer.clipAction(useClip).reset().setLoop(LoopRepeat, Infinity).play();
        };
        rig.mixer.addEventListener('finished', onEquipFinished);
      }
    } else if (useClip) {
      rig.mixer.clipAction(useClip).reset().setLoop(LoopRepeat, Infinity).play();
    }
  }

  setDebugPaused(paused: boolean): void {
    this.debugPaused = paused;
    const active = this.activeAction;
    if (!active) return;

    if (paused && this.character) {
      // Pausing freezes the mixer's global clock - but that clock is also
      // what drives an in-progress crossfade's blend weight, so pausing
      // mid-fade would otherwise lock in a permanent blend of two different
      // clips instead of one clean pose. Snap straight to the target clip.
      for (const clip of Object.values(this.character.clips)) {
        const action = this.character.mixer.existingAction(clip);
        if (action && action !== active) action.stop();
      }
      active.enabled = true;
      active.setEffectiveWeight(1);
    }

    active.paused = paused;
  }

  /** Manual clip selection (e.g. a debug button), overriding whatever click-to-move was doing. */
  setClip(name: string): void {
    this.moveTarget = null;
    this.moveDirection = null;
    this.moveLocomotionDirection = null;
    this.setDesiredClip(name);
  }

  getMoveMode(): MoveMode {
    return this.moveMode;
  }

  /** Toggles walk/run for click-to-move / joystick movement. Takes effect immediately if already mid-move, not just on the next moveTo() - going through getDesiredLocomotionClip (not just `mode` directly) so this doesn't briefly stomp "fly" while isFlying/isBoosterEquipped is active. */
  setMoveMode(mode: MoveMode): void {
    this.moveMode = mode;
    if (this.moveTarget || this.moveDirection) this.setDesiredClip(this.getDesiredLocomotionClip());
  }

  getIsBoosterEquipped(): boolean {
    return this.isBoosterEquipped;
  }

  /**
   * Debug/test-only: forces isBoosterEquipped without actually equipping a
   * real "Booster" cloak item (see equipCloak's doc comment on how that
   * flag is normally set/reset). Real equip/unequip and mount() still take
   * priority whenever they run - this is for scenes with no cloak-equip UI
   * wired up yet that just want to verify getCurrentSpeed()'s multiplier
   * and the run clip visually, independent of CDN mesh/texture
   * availability for the real booster items.
   */
  setDebugBoosterEnabled(enabled: boolean): void {
    this.isBoosterEquipped = enabled;
  }

  getDebugWeaponUpgradeLevel(): number {
    return this.debugWeaponUpgradeLevel;
  }

  /**
   * Debug/test-only (WeaponEditPanel's upgrade-level dropdown): simulates
   * a different +N upgrade level for the currently-equipped weapon's Chef/
   * effect resolution (see debugWeaponUpgradeLevel's own doc comment),
   * then fully re-equips it so glow/socket-glow/surface-shine all rebuild
   * fresh against the new level - simpler and more correct than trying to
   * patch the existing overlays/materials in place (applySurfaceShine in
   * particular only ever applies a matcap, never reverts one, so leaving
   * the old materials around risks a stale effect surviving a level that
   * no longer has one). No-op while unarmed.
   */
  setDebugWeaponUpgradeLevel(level: number): void {
    this.debugWeaponUpgradeLevel = level;
    if (this.currentWeaponItem) void this.equipWeapon(this.currentWeaponItem);
  }

  /** Tears down every currently-spawned particle for one slot (see slotParticles' own doc comment) - ParticleEffect.dispose() only touches its own per-instance materials, never the shared cached R3E geometry, so this is always safe to call independently of that slot's own item mesh lifecycle. No-op if that slot has none spawned. */
  private disposeSlotParticles(modelType: ModelType): void {
    const list = this.slotParticles[modelType];
    if (!list) return;
    for (const effect of list) {
      effect.dispose();
      this.particleEffectMeta.delete(effect);
    }
    delete this.slotParticles[modelType];
  }

  /**
   * Resolves and spawns one slot's REAL particle set (see glowEffect.ts's
   * resolveWeaponParticles/EffSection.particleIds for how this was
   * confirmed) - fire-and-forget, called from trySpawnSlotParticles once
   * an item is known to be equipped there. `sourceObjects` (that slot's
   * own `equippedObjects` entry) doubles as the *candidate socket list*
   * passed straight to resolveWeaponParticles, unfiltered by any naming
   * convention - deliberate, not a shortcut: weapons use "effectN"/"P0N"
   * sockets but cloaks use a third, different convention entirely
   * ("BALL00".."BALL03"/"P03", confirmed on `Chef/Eff/Armor/
   * BELMALE_A_CLOAK.EFF`), and resolveWeaponParticles's own name-matching
   * (EffSection.socketLabel against Object3D.name) already does the real
   * filtering - every real particle-bearing section checked so far
   * (weapon and cloak alike) carries an exact label, so passing every
   * sub-object through costs nothing extra. Same staleness-check pattern
   * as applyGlowOverlay: discards its result silently if the character
   * was swapped, this slot got re-equipped, or the caller turned this
   * back off again, all before the (two-step: .eff file, then
   * Particle.ini) resolution finished.
   */
  private async spawnSlotParticles(modelType: ModelType, item: ItemDefinition, character: RfCharacter, sourceObjects: Object3D[], upgradeLevel: number): Promise<void> {
    const spawns = await resolveWeaponParticles(item.model, sourceObjects, upgradeLevel);
    if (this.character !== character || this.equippedObjects[modelType] !== sourceObjects || !this.debugSocketParticleWanted) {
      return;
    }

    const list = this.slotParticles[modelType] ?? [];
    this.slotParticles[modelType] = list;
    for (const { socket, sptPath } of spawns) {
      const effect = new ParticleEffect();
      // No extra scale needed - a .spt's own position/drift units share
      // the same raw coordinate space as the .msh mesh/socket they're
      // attached to (see DEBUG_SOCKET_PARTICLE_SCALE's own doc comment
      // for the real, measured evidence) - still exposed live via
      // setDebugSocketParticleScale for any case that reasoning misses.
      effect.group.scale.setScalar(this.debugSocketParticleScale);
      socket.add(effect.group);
      list.push(effect);
      this.particleEffectMeta.set(effect, { socket, sptPath });
      void effect.load(sptPath);
    }
  }

  /** Kicks off spawnSlotParticles for one slot if it isn't already running and there's an equipped item with a real object list to search - skips silently (returns false) for an empty/unarmed slot. Shared by setDebugSocketParticleEnabled(true) and the equip-time "follow the newly-equipped item" hook in equipWeapon/equipCloak. */
  private trySpawnSlotParticles(modelType: ModelType, item: ItemDefinition | null, upgradeLevel: number): boolean {
    if ((this.slotParticles[modelType]?.length ?? 0) > 0) return true; // already on
    const character = this.character;
    const sourceObjects = this.equippedObjects[modelType];
    if (!character || !item || !sourceObjects || sourceObjects.length === 0) return false;

    void this.spawnSlotParticles(modelType, item, character, sourceObjects, upgradeLevel);
    return true;
  }

  /**
   * Toggle for every equipped slot's real, `.eff`/`Particle.ini`-driven
   * particle set (see spawnSlotParticles/resolveWeaponParticles) - no
   * longer a hardcoded, weapon-only stand-in (see slotParticles/
   * debugSocketParticleWanted's own doc comments on why this defaults to
   * on and why it now covers Weapon and Cloak both). Returns true if
   * either slot had (or now has) something to attach to, false only if
   * neither Weapon nor Cloak is currently equipped with any object at
   * all - so the caller (RfViewer's %particletest handler) can tell
   * "turned on" from "nothing equipped to attach to" - this synchronous
   * result doesn't reflect whether either item's `.eff` actually turns
   * out to reference any real particle (resolved asynchronously
   * afterward; an equipped item with no registered particle data just
   * ends up spawning nothing, same as "no glow" elsewhere in this file).
   * Turning it off (or re-equipping/unequipping either slot, which calls
   * disposeSlotParticles directly) always tears every spawned instance in
   * that slot down cleanly - ParticleEffect.dispose() only touches its
   * own per-instance materials, never the shared cached R3E geometry, so
   * this is safe to dispose independently of that slot's own item mesh
   * lifecycle.
   */
  setDebugSocketParticleEnabled(enabled: boolean): boolean {
    this.debugSocketParticleWanted = enabled;
    if (!enabled) {
      this.disposeSlotParticles(ModelType.Weapon);
      this.disposeSlotParticles(ModelType.Cloak);
      return true;
    }

    const weaponOk = this.trySpawnSlotParticles(ModelType.Weapon, this.currentWeaponItem, this.debugWeaponUpgradeLevel);
    const cloakOk = this.trySpawnSlotParticles(ModelType.Cloak, this.currentBodyItem[ModelType.Cloak] ?? null, 0);
    return weaponOk || cloakOk;
  }

  /**
   * Debug/test-only (WeaponEditPanel or a %particlescale command):
   * live-tunes every currently-spawned particle's scale, across every
   * slot (see DEBUG_SOCKET_PARTICLE_SCALE's own doc comment on why the
   * built-in default of 1 is the real, derived value, not a fudge factor
   * to hand-tune away from) - takes effect immediately on whatever's
   * already running, and is remembered for the next equip's own
   * spawnSlotParticles call.
   */
  setDebugSocketParticleScale(scale: number): void {
    this.debugSocketParticleScale = scale;
    for (const list of Object.values(this.slotParticles)) {
      for (const effect of list ?? []) effect.group.scale.setScalar(scale);
    }
  }

  rebuildParticlesForRandomnessChange(): void {
    for (const list of Object.values(this.slotParticles)) {
      for (const effect of list ?? []) effect.rebuildForRandomnessChange();
    }
  }

  getDebugSocketParticleScale(): number {
    return this.debugSocketParticleScale;
  }

  /** Snapshot from the most recent particle pass, consumed by ViewerScene's half-second debug stats update. */
  getParticlePerformanceStats(): ParticlePerformanceStats {
    return this.particlePerformance;
  }

  getParticleEffectCount(): number {
    let count = 0;
    for (const list of Object.values(this.slotParticles)) count += list?.length ?? 0;
    return count;
  }

  /** Per-frame upkeep for every currently-spawned particle, across every slot. ViewerScene builds culling once and shares it with every character, so off-screen effects can skip simulation and dynamic buffer uploads. */
  updateDebugSocketParticle(camera: Camera, delta: number, culling: ParticleCullingContext): void {
    const startedAt = performance.now();
    let effects = 0;
    let totalInstances = 0;
    let simulatedInstances = 0;
    let culledEffects = 0;

    for (const list of Object.values(this.slotParticles)) {
      for (const effect of list ?? []) {
        effects += 1;
        effect.update(delta, camera, culling.frustum, culling.cameraPosition);
        totalInstances += effect.getInstanceCount();
        simulatedInstances += effect.getActiveInstanceCount();
        if (effect.isCulled()) culledEffects += 1;
      }
    }
    this.particlePerformance = { effects, totalInstances, simulatedInstances, culledEffects, updateMs: performance.now() - startedAt };
  }

  getIsFlying(): boolean {
    return this.isFlying;
  }

  /** "stand"/"fly" - whichever clip should play while nothing is moving, depending on isFlying. Not resolveClipName's concern (that only handles walk/run/fly's *directional* variants and war-mode) - this is just which name gets passed in for the "stationary" case, same as "stand" always was before flying existed. */
  private getIdleClip(): 'stand' | 'fly' {
    return this.isFlying ? 'fly' : 'stand';
  }

  /**
   * Player-invoked Fly toggle - requires any cloak to be equipped (not
   * specifically a "Booster" item; see isBoosterEquipped for that separate,
   * automatic run-speed mechanic). Turning it on with no cloak equipped is a
   * no-op that returns false, so the caller (RfViewer's Fly button) can show
   * a "must equip a cloak" notice instead of silently doing nothing; turning
   * it off always succeeds. Re-resolves the currently-desired clip
   * immediately either way, covering both "already moving" (getDesiredLocomotionClip)
   * and "standing still" (getIdleClip) - a plain moveMode/battleMode toggle
   * only needs the former since "stand" never depended on either of those,
   * but flying's own idle clip does.
   */
  setFlying(enabled: boolean): boolean {
    if (enabled) {
      if (!this.equippedObjects[ModelType.Cloak]) return false;
      this.isFlying = true;
    } else {
      this.isFlying = false;
    }
    this.setDesiredClip(this.moveTarget || this.moveDirection ? this.getDesiredLocomotionClip() : this.getIdleClip());
    return true;
  }

  moveTo(point: Vector3): void {
    console.log('[anim-debug] click-to-move triggered', {
      from: this.character?.group.position.toArray().map((n) => +n.toFixed(3)),
      to: point.toArray().map((n) => +n.toFixed(3)),
      previousClip: this.desiredClip,
    });
    this.moveDirection = null;
    this.moveLocomotionDirection = null;
    this.moveTarget = point.clone();
    this.setDesiredClip(this.getDesiredLocomotionClip());
  }

  /**
   * Continuous move input for the mobile joystick/WASD (or any future analog
   * input): a world-space XZ vector whose magnitude (0-1) scales speed,
   * applied fresh every frame by update(). `faceDirection` sets which way to
   * turn while moving - defaults to `direction` itself (face the way you're
   * walking) when omitted or too small to matter; pass a different vector
   * (e.g. just the forward component) for a pure-strafe input so the
   * character keeps facing forward instead of snapping to face sideways.
   * `locomotionDirection` picks a real backward/strafe clip (see
   * LocomotionDirection) instead of plain walk/run for that same case -
   * null means "mostly forward," which keeps the existing plain-clip,
   * face-the-way-you're-moving behavior. Pass `direction` as null (or a
   * ~zero vector) to release - drops back to "stand" unless a click-to-move
   * target is still pending. Overrides (and clears) any active click-to-move
   * target the moment it's engaged.
   */
  setMoveDirection(direction: Vector3 | null, faceDirection?: Vector3 | null, locomotionDirection?: LocomotionDirection | null): void {
    if (direction && direction.lengthSq() > 1e-6) {
      this.moveDirection = direction.clone();
      this.faceDirection = faceDirection && faceDirection.lengthSq() > 1e-6 ? faceDirection.clone() : this.moveDirection;
      this.moveLocomotionDirection = locomotionDirection ?? null;
      this.moveTarget = null;
    } else {
      this.moveDirection = null;
      this.faceDirection = null;
      this.moveLocomotionDirection = null;
      if (!this.moveTarget) this.setDesiredClip(this.getIdleClip());
    }
  }

  /**
   * Directly sets the character's world-space yaw (rotation.y-equivalent),
   * bypassing update()'s own lookAt+rotateTowards turn-rate limiting -
   * for a caller that already smooths yaw itself (RemoteEntityController,
   * matching its own position smoothing) and wants that exact value applied
   * immediately, not turned toward gradually on top of its own smoothing.
   *
   * Deliberately does NOT apply FACING_CORRECTION - confirmed by direct
   * numeric comparison that update()'s lookAt(facePoint, character position,
   * up) call (note the swapped eye/target - it looks FROM one step ahead
   * BACK AT the character, not the standard order) already lands its local
   * -Z axis pointing the intended facing direction's way once
   * FACING_CORRECTION is folded in - i.e. that combination nets out to
   * exactly the same thing a plain `setFromAxisAngle(Y, yaw)` gives on its
   * own (which is exactly rotationToYaw's own documented contract: yaw=0
   * faces local forward at world -Z). Applying FACING_CORRECTION a second
   * time here (as this method used to, and as the `rotation.y = yaw +
   * MESH_FACING_CORRECTION_RAD` it replaced always had) double-corrects and
   * faces every remote entity exactly backward from the local player's own
   * rendering of the same yaw - confirmed as the actual cause of remote
   * players appearing to face/turn the opposite way from what they're
   * actually doing.
   */
  setWorldYaw(yaw: number): void {
    const character = this.character;
    if (!character) return;
    this.worldYawQuat.setFromAxisAngle(Y_AXIS, yaw);
    character.group.quaternion.copy(this.worldYawQuat);
  }

  stepFrame(deltaFrames: number): void {
    const action = this.activeAction;
    if (!action) return;
    const duration = action.getClip().duration;
    action.time = (((action.time + deltaFrames * STEP_SECONDS) % duration) + duration) % duration;
    this.character?.mixer.update(0);
    this.callbacks.onFrameLabelChange?.(`t=${action.time.toFixed(4)}s / ${duration.toFixed(4)}s`);
  }

  /** Per-bone quaternion snapshot of the current pose, for the "log now" debug tool. */
  getFrameStateRows(): { rows: Record<string, { x: number; y: number; z: number; w: number; nan: boolean }>; action: AnimationAction } | null {
    const character = this.character;
    const action = this.activeAction;
    if (!character || !action) return null;

    const rows: Record<string, { x: number; y: number; z: number; w: number; nan: boolean }> = {};
    character.group.traverse((obj) => {
      if (!(obj as { isBone?: boolean }).isBone) return;
      const q = obj.quaternion;
      rows[obj.name] = {
        x: +q.x.toFixed(4),
        y: +q.y.toFixed(4),
        z: +q.z.toFixed(4),
        w: +q.w.toFixed(4),
        nan: Number.isNaN(q.x) || Number.isNaN(q.y) || Number.isNaN(q.z) || Number.isNaN(q.w),
      };
    });
    return { rows, action };
  }

  /**
   * Equips one slot: either a specific item (resolved via
   * playerResource.json's Mesh table - most real, non-"Default ..." items
   * aren't in it yet, so this commonly returns 'unavailable') or, when
   * `item` is null, that slot's default body part for the current race.
   * Replaces whatever this controller last equipped in that slot, so
   * calling this - not building meshes some other way - is the only
   * correct way to change a slot, including for the initial default body
   * (see mount()).
   */
  async equipItem(modelType: ModelType, item: ItemDefinition | null): Promise<EquipResult> {
    if (modelType === ModelType.Weapon) return this.equipWeapon(item);
    if (modelType === ModelType.Cloak) return this.equipCloak(item);
    if (modelType === ModelType.Helmet) return this.equipHelmet(item);

    const character = this.character;
    const raceGender = this.raceGender;
    if (!character || raceGender === null) return 'no-character';

    this.currentBodyItem[modelType] = item;

    let stem: string;
    if (item) {
      const resolvedStem = await resolveItemMeshStem(item.model, raceGender);
      if (this.character !== character) return 'no-character'; // superseded mid-await
      if (!resolvedStem) return 'unavailable';
      stem = resolvedStem;
    } else {
      // See baseAppearance's doc comment - this is the character's own
      // chosen variant for this slot, not always "_000".
      const variant = this.baseAppearance[modelType] ?? 0;
      stem = `${character.group.name}_DEFAULT_${MODEL_TYPE_TO_PART_TOKEN[modelType]}_${String(variant).padStart(3, '0')}`;
    }

    // Default appearance and real armor items are both in the same per-race
    // CDN folder now (see characterCdnBase's doc comment in character.ts) -
    // no separate "which archive holds this stem" step needed any more.
    const newObjects = await buildMeshPartObjects(stem, characterCdnBase(raceGender), character.builtSkeleton);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (newObjects.length === 0) return 'unavailable';

    const previous = this.equippedObjects[modelType];
    if (previous) {
      for (const obj of previous) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
      }
    }
    this.disposeGlowOverlayFor(modelType);

    for (const obj of newObjects) {
      if (!obj.parent) character.group.add(obj);
    }
    this.equippedObjects[modelType] = newObjects;
    // Surface shine must resolve first: it fully replaces the mesh's own
    // material, which would silently wipe out an already-injected glow
    // term (see glowEffect.ts's attachGlowInjection) if glow happened to
    // land first - sequenced, not parallel, so the final material is
    // always the one glow actually gets applied to.
    void this.applySurfaceShineFor(item, newObjects).then(() => this.applyGlowOverlay(modelType, item, character, newObjects));

    return item ? 'equipped' : 'default';
  }

  /**
   * Sets which of the 5 pre-made variants a base slot's default mesh uses -
   * the character-creation-time customization (hair for Bell/Cora's Helmet
   * slot, face, body shape, ...) that shows whenever nothing's equipped in
   * that slot. Applies immediately if the slot currently has no item
   * equipped; otherwise it's only remembered for whenever the item is
   * later removed - changing your hairstyle shouldn't visibly do anything
   * while a helmet is covering it.
   */
  async setBaseAppearance(modelType: ModelType, variantIndex: number): Promise<EquipResult> {
    this.baseAppearance[modelType] = variantIndex;
    if (this.currentBodyItem[modelType]) return 'equipped'; // covered by a real item right now - preference stored, nothing to re-render
    return this.equipItem(modelType, null);
  }

  /**
   * Weapon-slot equip: unlike a body part, a weapon has no default mesh (an
   * unarmed character just has empty hands) and its mesh is a rigid part
   * parented straight onto the wielding character's own hand bone rather
   * than a per-race body-part swap - see loadWeaponMeshObjects. Also
   * pre-warms (and caches) the weapon's combat walk/run clips so update()'s
   * per-frame clip lookup stays a synchronous object read.
   */
  private async equipWeapon(item: ItemDefinition | null): Promise<EquipResult> {
    const character = this.character;
    const raceGender = this.raceGender;
    if (!character || raceGender === null) return 'no-character';

    const previous = this.equippedObjects[ModelType.Weapon];

    if (!item) {
      // Must run before `previous` is disposed below - each slotParticles
      // [Weapon] entry's group is a genuine child of one of previous's own
      // socket objects (see setDebugSocketParticleEnabled), so disposing
      // `previous` first would sweep its mesh instances into
      // disposeObject3D's traversal and corrupt their shared, cached R3E
      // geometry (see disposeSlotParticles's own doc comment on why
      // ParticleEffect needs its own, earlier, independent teardown here).
      this.disposeSlotParticles(ModelType.Weapon);
      if (previous) {
        for (const obj of previous) {
          obj.parent?.remove(obj);
          disposeObject3D(obj);
        }
        delete this.equippedObjects[ModelType.Weapon];
      }
      this.disposeGlowOverlayFor(ModelType.Weapon);
      this.disposeGradeOverlayFor(ModelType.Weapon);
      this.disposeSocketGlowForWeapon();
      this.currentWeaponToken = null;
      this.currentWeaponItem = null;
      this.currentWeaponStem = null;
      return 'default';
    }

    const weaponMesh = await resolveWeaponMesh(item.model);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (!weaponMesh) return 'unavailable';

    const newObjects = await loadWeaponMeshObjects(weaponMesh.stem, character.builtSkeleton, weaponMesh.weaponToken);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (newObjects.length === 0) return 'unavailable';

    if (weaponMesh.weaponToken) {
      // Best-effort: a race/token combination with no combat animation
      // just means update() falls back to the unarmed clip below.
      await prewarmWeaponClips(raceGender, character, weaponMesh.weaponToken);
      if (this.character !== character) return 'no-character'; // superseded mid-await
    }

    // Must run before `previous` is disposed below - see the `!item` branch
    // above's identical comment on why.
    this.disposeSlotParticles(ModelType.Weapon);
    if (previous) {
      for (const obj of previous) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
      }
    }
    this.disposeGlowOverlayFor(ModelType.Weapon);
    this.disposeGradeOverlayFor(ModelType.Weapon);
    this.disposeSocketGlowForWeapon();

    for (const obj of newObjects) {
      if (!obj.parent) character.group.add(obj);
    }
    this.equippedObjects[ModelType.Weapon] = newObjects;
    this.currentWeaponToken = weaponMesh.weaponToken;
    this.currentWeaponItem = item;
    this.currentWeaponStem = weaponMesh.stem;
    // Surface shine must resolve first - see equipItem's identical ordering
    // comment on why (it fully replaces the mesh's own material, which
    // would wipe out an already-injected glow term if glow landed first).
    // Grade overlay is unaffected (still a separate clone mesh, like glow
    // used to be), so it's independent and can stay parallel.
    void this.applySurfaceShineFor(item, newObjects, this.debugWeaponUpgradeLevel).then(() =>
      this.applyGlowOverlay(ModelType.Weapon, item, character, newObjects),
    );
    void this.applyGradeOverlay(ModelType.Weapon, item, character, newObjects);
    // Re-attach to whichever real particle data the new weapon's own .eff
    // offers - disposed above along with `previous`, so this is a fresh
    // attach, not a resume. Silently does nothing if this weapon has no
    // registered particle data.
    if (this.debugSocketParticleWanted) this.trySpawnSlotParticles(ModelType.Weapon, item, this.debugWeaponUpgradeLevel);

    // Only actually visible in War mode - see setBattleMode. The combat
    // clips for this weapon were already prewarmed just above, regardless
    // of the current mode, so they're ready the instant the
    // player toggles into War.
    this.applyWeaponVisibility();

    return 'equipped';
  }

  /**
   * Cloak-slot equip: like Weapon, has no default appearance (an unequipped
   * character just shows nothing there) - unlike a weapon, though, a cloak
   * is resolved via resolveCloakMeshStem/CLOAK_CDN_BASE (the race-agnostic
   * item/Armor/ archives, pre-extracted to their own CDN folder) instead of
   * resolveItemMeshStem/characterCdnBase (the per-race character/player/
   * Mesh armor archives) - verified cloak meshes actually live in the
   * former, not the latter. Every real cloak checked turned out to be a
   * *rigid* part attached to "Bip01 Spine1" (not skinned/draping cloth as
   * previously assumed here), same buildObjectsFromParsedMesh path a
   * weapon's rigid attach uses - see applyCloakAnimation for the separate,
   * optional sway rig some cloaks layer on top of that static placement.
   */
  private async equipCloak(item: ItemDefinition | null): Promise<EquipResult> {
    const character = this.character;
    const raceGender = this.raceGender;
    if (!character || raceGender === null) return 'no-character';

    this.currentBodyItem[ModelType.Cloak] = item;
    const previous = this.equippedObjects[ModelType.Cloak];
    // Must run before `previous` is disposed below (either branch, either
    // sub-path - immediate or deferred via onUnuseFinished) - same
    // reasoning as equipWeapon's identical ordering comment: each
    // slotParticles[Cloak] entry's group is a genuine child of one of
    // previous's own socket objects.
    this.disposeSlotParticles(ModelType.Cloak);

    if (!item) {
      // A cloak with a sway rig and a real UNUSE clip gets to play its
      // retract animation before actually disappearing - see
      // departingCloakAnimations' own doc comment. Everything else
      // (no rig, or no UNUSE clip) disposes immediately, same as before.
      const outgoing = this.cloakAnimation;
      this.cloakAnimation = null;
      const unuseClip = outgoing?.rig.clips.UNUSE;

      if (previous && outgoing && unuseClip) {
        // Whatever was previously playing (USE's loop, or a still-frozen
        // EQUIP if it has no USE clip) needs to stop first, same reasoning
        // as applyCloakAnimation's equip->use handoff - otherwise it keeps
        // contributing weight and blends with/dampens the retract clip.
        outgoing.rig.mixer.stopAllAction();
        const action = outgoing.rig.mixer.clipAction(unuseClip).reset();
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        const departing: DepartingCloakSwayState = { ...outgoing, action, objectsToDispose: previous };
        this.departingCloakAnimations.push(departing);
        const onUnuseFinished = (e: { action: AnimationAction }) => {
          if (e.action !== action) return;
          outgoing.rig.mixer.removeEventListener('finished', onUnuseFinished);
          for (const obj of departing.objectsToDispose) {
            obj.parent?.remove(obj);
            disposeObject3D(obj);
          }
          const index = this.departingCloakAnimations.indexOf(departing);
          if (index !== -1) this.departingCloakAnimations.splice(index, 1);
        };
        outgoing.rig.mixer.addEventListener('finished', onUnuseFinished);
      } else {
        if (previous) {
          for (const obj of previous) {
            obj.parent?.remove(obj);
            disposeObject3D(obj);
          }
        }
      }

      delete this.equippedObjects[ModelType.Cloak];
      this.disposeGlowOverlayFor(ModelType.Cloak);
      this.isBoosterEquipped = false;
      // Flying requires a cloak (see setFlying) - none left to require it of.
      if (this.isFlying) this.setFlying(false);
      return 'default';
    }

    const stem = await resolveCloakMeshStem(item.model, raceGender);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (!stem) return 'unavailable';

    const newObjects = await buildMeshPartObjects(stem, CLOAK_CDN_BASE, character.builtSkeleton);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (newObjects.length === 0) return 'unavailable';

    // "Booster" items (cloakItem.json's "Premium Booster"/"Blood Booster[N
    // Grade]" rows) aren't a separate mechanic - they're ordinary cloaks
    // whose mesh happens to live under a "COSTUMEARMOR_CLOAK" stem instead
    // of the regular "ARMOR_CLOAK" one (see character.ts's
    // boosterTextureName doc comment for the full naming story). That's
    // the only signal available to tell them apart - cloakItem.json's own
    // BoostSpd stat isn't booster-specific (see BOOSTER_SPEED_MULTIPLIER).
    // Set only now that the mesh actually resolved - an 'unavailable' equip
    // above must leave the previous booster state untouched, not silently
    // grant/revoke the speed boost for an item that never actually equipped.
    this.isBoosterEquipped = stem.includes('COSTUMEARMOR_CLOAK');

    // Swapping to a different cloak, not a genuine unequip - the outgoing
    // one's sway state (if any) is dropped immediately (its objects are
    // about to be disposed below anyway), no UNUSE flourish (see
    // equipCloak's `!item` branch for where that happens).
    this.cloakAnimation = null;
    if (previous) {
      for (const obj of previous) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
      }
    }
    this.disposeGlowOverlayFor(ModelType.Cloak);

    for (const obj of newObjects) {
      if (!obj.parent) character.group.add(obj);
    }
    this.equippedObjects[ModelType.Cloak] = newObjects;
    void this.applyGlowOverlay(ModelType.Cloak, item, character, newObjects);
    void this.applyCloakAnimation(stem, character, newObjects);
    // Re-attach to whichever real particle data the new cloak's own .eff
    // offers - disposed above along with `previous`, so this is a fresh
    // attach, not a resume. Silently does nothing if this cloak has no
    // registered particle data (most cloaks - confirmed present on the
    // "Premium Booster"/"Blood Booster" cloaks at least, see
    // slotParticles' own doc comment).
    if (this.debugSocketParticleWanted) this.trySpawnSlotParticles(ModelType.Cloak, item, 0);

    return 'equipped';
  }

  /**
   * Helmet-slot equip: on Bell/Cora, the base-appearance mesh here is the
   * character's hairstyle, not armor - a real Helmet item doesn't replace
   * it, it overlays on top of it, the same way the real client renders
   * hair alongside a worn helmet rather than hiding it. So unlike every
   * other body slot, the base appearance and an equipped item aren't
   * mutually exclusive builds of one slot - helmetBaseObjects (hair) and
   * equippedObjects[Helmet] (the item) both stay in the scene and both
   * stay visible at once. Hair is built once per chosen variant and
   * reused - equipping/removing a helmet never touches it at all.
   */
  private async equipHelmet(item: ItemDefinition | null): Promise<EquipResult> {
    const character = this.character;
    const raceGender = this.raceGender;
    if (!character || raceGender === null) return 'no-character';

    this.currentBodyItem[ModelType.Helmet] = item;

    const desiredVariant = this.baseAppearance[ModelType.Helmet] ?? 0;
    if (this.helmetBaseVariant !== desiredVariant) {
      for (const obj of this.helmetBaseObjects) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
      }
      this.helmetBaseObjects = [];

      const stem = `${character.group.name}_DEFAULT_${MODEL_TYPE_TO_PART_TOKEN[ModelType.Helmet]}_${String(desiredVariant).padStart(3, '0')}`;
      // Base appearance and real armor items are both in the same per-race
      // CDN folder - see characterCdnBase's doc comment in character.ts.
      this.helmetBaseObjects = await buildMeshPartObjects(stem, characterCdnBase(raceGender), character.builtSkeleton);
      if (this.character !== character) return 'no-character'; // superseded mid-await

      for (const obj of this.helmetBaseObjects) {
        if (!obj.parent) character.group.add(obj);
      }
      this.helmetBaseVariant = desiredVariant;
    }

    const previousItemObjects = this.equippedObjects[ModelType.Helmet];

    if (!item) {
      if (previousItemObjects) {
        for (const obj of previousItemObjects) {
          obj.parent?.remove(obj);
          disposeObject3D(obj);
        }
        delete this.equippedObjects[ModelType.Helmet];
      }
      this.disposeGlowOverlayFor(ModelType.Helmet);
      return 'default';
    }

    const resolvedStem = await resolveItemMeshStem(item.model, raceGender);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (!resolvedStem) return 'unavailable';

    const newObjects = await buildMeshPartObjects(resolvedStem, characterCdnBase(raceGender), character.builtSkeleton);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (newObjects.length === 0) return 'unavailable';

    if (previousItemObjects) {
      for (const obj of previousItemObjects) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
      }
    }
    this.disposeGlowOverlayFor(ModelType.Helmet);

    for (const obj of newObjects) {
      if (!obj.parent) character.group.add(obj);
    }
    this.equippedObjects[ModelType.Helmet] = newObjects;
    // Surface shine must resolve first - see equipItem's identical ordering
    // comment on why.
    void this.applySurfaceShineFor(item, newObjects).then(() => this.applyGlowOverlay(ModelType.Helmet, item, character, newObjects));

    return 'equipped';
  }

  /**
   * Swaps in a freshly loaded (bodiless) character: disposes the previous
   * one (group + skeleton helper), resets all movement/animation state,
   * equips every slot's default body part, and returns the resulting
   * bounding box for the caller to frame the camera/ground with (units/scale
   * differ per race, so that can't be baked in ahead of time).
   */
  async mount(character: RfCharacter, raceGender: RaceGender): Promise<CharacterBounds> {
    // Must run before prevGroup is disposed below - same reasoning as
    // equipWeapon's own identical ordering comment (each slotParticles
    // entry's group is a descendant of that slot's own socket, itself a
    // descendant of prevGroup here).
    this.disposeSlotParticles(ModelType.Weapon);
    this.disposeSlotParticles(ModelType.Cloak);
    const prevGroup = this.character?.group;
    if (prevGroup) {
      this.scene.remove(prevGroup);
      disposeObject3D(prevGroup);
    }
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
    }

    this.character = character;
    this.raceGender = raceGender;
    this.equippedObjects = {};
    this.baseAppearance = {};
    this.currentBodyItem = {};
    // Already disposed by the disposeObject3D(prevGroup) traversal above if
    // this is a real character swap - these are stale references at this
    // point either way, so drop them rather than let equipHelmet think
    // they're still valid for the new character.
    this.helmetBaseObjects = [];
    this.helmetBaseVariant = null;
    // Not individually disposed here - every glow/grade overlay mesh is a
    // descendant of prevGroup (parented to either the group itself or one
    // of its bones), so the disposeObject3D(prevGroup) traversal above
    // already freed them; this just drops the now-stale bookkeeping so
    // update()/applyWeaponVisibility() stop iterating dangling entries.
    this.equippedGlowOverlays = {};
    this.equippedGradeOverlays = {};
    this.equippedSocketGlow = null;
    // Same reasoning as equippedGlowOverlays above - the cloak rig plays
    // directly on the cloak's own objects, which are descendants of
    // prevGroup, already freed by disposeObject3D(prevGroup); this just
    // drops the now-stale bookkeeping.
    this.cloakAnimation = null;
    this.departingCloakAnimations = [];
    this.scene.add(character.group);

    // The toggle button only renders once status is 'ready', so there's no
    // toggle to race with here - start hidden if that's the caller's state.
    const skeletonHelper = new SkeletonHelper(character.group);
    skeletonHelper.visible = this.showBones;
    this.scene.add(skeletonHelper);
    this.skeletonHelper = skeletonHelper;

    const hipsIndex = character.builtSkeleton.nameToIndex.get(HIPS_BONE_NAME);
    this.hipsBone = hipsIndex !== undefined ? character.builtSkeleton.bones[hipsIndex] : null;
    const headIndex = character.builtSkeleton.nameToIndex.get(HEAD_BONE_NAME);
    this.headBone = headIndex !== undefined ? character.builtSkeleton.bones[headIndex] : null;

    // Reset per-character state - the mixer/clips/skeleton above all belong
    // to the character being replaced.
    this.moveTarget = null;
    this.moveDirection = null;
    this.desiredClip = 'stand';
    this.currentClipKey = null;
    this.activeAction = null;
    this.currentWeaponToken = null;
    this.battleMode = 'peace';
    this.moveMode = 'walk';
    this.isBoosterEquipped = false;
    this.isFlying = false;
    this.debugWeaponUpgradeLevel = 0;
    this.lastQuatByBone.clear();
    this.callbacks.onClipChange?.('stand');
    this.callbacks.onFrameLabelChange?.('');

    await Promise.all(ALL_MODEL_TYPES.map((modelType) => this.equipItem(modelType, null)));

    const box = new Box3().setFromObject(character.group, true);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

    this.walkSpeed = radius * WALK_SPEED_RADIUS_PER_SEC;
    this.arriveThreshold = radius * ARRIVE_FRACTION_OF_RADIUS;

    return { box, center, radius };
  }

  /** Base movement speed - flying (see isFlying) has its own fixed speed that ignores the walk/run toggle entirely, not a multiplier layered on top of whichever one is selected; otherwise the current moveMode's speed, including the booster multiplier while running with a Booster cloak equipped (see isBoosterEquipped). Callers scale by input intensity themselves where relevant (moveDirection's analog magnitude; click-to-move is always full speed). */
  private getCurrentSpeed(): number {
    if (this.isFlying) return this.walkSpeed * FLY_SPEED_MULTIPLIER;
    if (this.moveMode !== 'run') return this.walkSpeed;
    const runSpeed = this.walkSpeed * RUN_SPEED_MULTIPLIER;
    return this.isBoosterEquipped ? runSpeed * BOOSTER_SPEED_MULTIPLIER : runSpeed;
  }

  /**
   * Which clip setDesiredClip should actually be asked to play for the
   * current moveMode while actually moving - normally moveMode itself, but
   * 'fly' (a real unarmed locomotion clip - see character.ts's CLIP_NAMES)
   * takes over whenever isFlying is on (the player-invoked Fly toggle - see
   * setFlying), or else while running with a Booster cloak equipped (same
   * condition getCurrentSpeed uses for its own multiplier - boosting only
   * applies to running, not walking, matching how the original client
   * names/uses it). Does go through resolveClipName's directional logic
   * like walk/run (fly has its own real backward/left/right clips - see
   * character.ts's directionalFlyAnimationFileNames) - just never its
   * war-mode combat lookup, since no combat variant of it exists.
   */
  private getDesiredLocomotionClip(): MoveMode | 'fly' {
    if (this.isFlying) return 'fly';
    return this.moveMode === 'run' && this.isBoosterEquipped ? 'fly' : this.moveMode;
  }

  /**
   * Advances movement, animation crossfades and the pose watchdog by one
   * frame. Returns whether the character just arrived at its move target
   * this frame, so the caller can hide the click-to-move marker.
   */
  update(delta: number): { arrived: boolean } {
    const character = this.character;
    if (!character) return { arrived: false };

    let arrived = false;
    const direction = this.moveDirection;
    if (direction) {
      const magnitude = direction.length();
      const dirNorm = direction.clone().divideScalar(magnitude);
      const intensity = Math.min(magnitude, 1);
      const speed = this.getCurrentSpeed() * intensity;
      character.group.position.addScaledVector(dirNorm, speed * delta);

      const faceSource = this.faceDirection ?? direction;
      const faceNorm = faceSource === direction ? dirNorm : faceSource.clone().normalize();
      const facePoint = character.group.position.clone().add(faceNorm);
      this.lookMatrix.lookAt(facePoint, character.group.position, character.group.up);
      this.lookTargetQuat.setFromRotationMatrix(this.lookMatrix).multiply(FACING_CORRECTION);
      character.group.quaternion.rotateTowards(this.lookTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);
      this.setDesiredClip(this.getDesiredLocomotionClip());
    } else {
      const target = this.moveTarget;
      if (target) {
        const toTarget = new Vector3(target.x - character.group.position.x, 0, target.z - character.group.position.z);
        const distance = toTarget.length();

        if (distance <= this.arriveThreshold) {
          this.moveTarget = null;
          arrived = true;
          console.log(`[anim-debug] arrived at click-to-move target, switching to "${this.getIdleClip()}"`);
          this.setDesiredClip(this.getIdleClip());
        } else {
          toTarget.normalize();
          const speed = this.getCurrentSpeed();
          const step = Math.min(distance, speed * delta);
          character.group.position.addScaledVector(toTarget, step);
          character.group.position.y = target.y;

          const facePoint = character.group.position.clone().add(toTarget);
          this.lookMatrix.lookAt(facePoint, character.group.position, character.group.up);
          this.lookTargetQuat.setFromRotationMatrix(this.lookMatrix).multiply(FACING_CORRECTION);
          character.group.quaternion.rotateTowards(this.lookTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);
          // Re-checked every frame (cheap - setDesiredClip no-ops if
          // unchanged) so toggling Booster mid-click-to-move switches to/
          // from "fly" immediately, matching the moveDirection branch above
          // instead of only picking up the change on the next moveTo().
          this.setDesiredClip(this.getDesiredLocomotionClip());
        }
      }
    }

    // Driven off desiredClip every frame, not a one-shot effect - switching
    // purely through an external effect lags the rAF loop by at least one
    // commit, which (combined with a hard stopAllAction()/play() cut) was a
    // real source of visible pops between clips. Resolved (not desired)
    // name is what's actually compared/stored, so re-equipping a different
    // weapon while already walking/running re-triggers the crossfade even
    // though desiredClip itself ("walk"/"run") hasn't changed.
    const resolvedName = this.resolveClipName(this.desiredClip);
    if (resolvedName !== this.currentClipKey) {
      const nextClip = character.clips[resolvedName];
      if (nextClip) {
        console.log(`[anim-debug] clip switched to "${resolvedName}"`);
        const prevAction = this.activeAction;
        const nextAction = character.mixer.clipAction(nextClip);

        if (prevAction && prevAction !== nextAction && !this.debugPaused) {
          prevAction.fadeOut(CROSSFADE_SECONDS);
          nextAction.reset().fadeIn(CROSSFADE_SECONDS).play();
        } else {
          character.mixer.stopAllAction();
          nextAction.reset().play();
        }
        nextAction.paused = this.debugPaused;

        this.activeAction = nextAction;
        this.callbacks.onFrameLabelChange?.(`t=${nextAction.time.toFixed(4)}s / ${nextClip.duration.toFixed(4)}s`);
      }
      this.currentClipKey = resolvedName;
    }

    character.mixer.update(delta);
    this.checkForPoseAnomalies(character);
    this.updateGlowAnimation(delta);
    this.updateGradeAnimation(delta);
    if (this.cloakAnimation) this.updateCloakSway(this.cloakAnimation, delta);
    for (const departing of this.departingCloakAnimations) this.updateCloakSway(departing, delta);

    return { arrived };
  }

  /**
   * Maps an abstract desired clip ("walk"/"run"/"fly"/"stand"/"sit") to the
   * actual clips key to play, in priority order:
   *
   * 1. War + directional (moveLocomotionDirection set, walk/run only): the
   *    combat clip for the wielded weapon token AND that exact backward/
   *    strafe direction - only ever cached for Accretia (see getWeaponClip).
   * 2. Directional, unarmed (walk/run/fly): the real backward/strafe clip
   *    every race has in Peace's ETA archive (see LocomotionDirection and,
   *    for fly specifically, directionalFlyAnimationFileNames) - tried
   *    *before* the direction-blind combat clip below, armed or not,
   *    because a real backward/strafing leg animation (just missing the
   *    weapon-drawn arm pose) reads far better than a forward-facing combat
   *    walk/run playing while the character is visibly moving backward or
   *    sideways. This is what makes backward/strafe movement look right
   *    while armed on every race but Accretia, which is the only one with
   *    step 1's clips. Fly has no combat variant at all, so it only ever
   *    reaches this step or step 4 below - never step 1 or 3.
   * 3. War, plain: the combat variant for whatever's currently wielded (or
   *    the empty-handed "NONE" token, if nothing is - War still changes how
   *    an unarmed character moves and idles) - forward-only fallback, same
   *    as before directional locomotion existed.
   * 4. Plain desiredClip itself - always present, the ultimate fallback.
   *
   * Peace mode never shows the weapon mesh or plays its combat clips (see
   * applyWeaponVisibility), so it only ever reaches steps 2/4. There's no
   * combat or directional "sit" clip in this data set, so sitting always
   * plays the plain unarmed clip regardless of mode or movement.
   */
  private resolveClipName(desiredClip: string): string {
    const isLocomotion = desiredClip === 'walk' || desiredClip === 'run';
    const direction = isLocomotion || desiredClip === 'fly' ? this.moveLocomotionDirection : null;
    const directionalUnarmedKey = direction ? `${desiredClip}:${direction}` : null;

    if (this.battleMode === 'war' && this.character && (isLocomotion || desiredClip === 'stand')) {
      const token = this.currentWeaponToken ?? UNARMED_WEAPON_TOKEN;

      if (direction) {
        const directionalArmedKey = weaponClipKey(desiredClip, token, direction);
        if (this.character.clips[directionalArmedKey]) return directionalArmedKey;
        if (directionalUnarmedKey && this.character.clips[directionalUnarmedKey]) return directionalUnarmedKey;
      }

      const armedKey = weaponClipKey(desiredClip, token);
      if (this.character.clips[armedKey]) return armedKey;
    }

    if (directionalUnarmedKey && this.character?.clips[directionalUnarmedKey]) return directionalUnarmedKey;

    return desiredClip;
  }

  // Always-on watchdog: flags a NaN or a suspiciously large single-frame
  // rotation jump the instant it happens, without needing to catch it by
  // eye or manually pause in time.
  private checkForPoseAnomalies(character: RfCharacter): void {
    const action = this.activeAction;
    const time = action ? action.time : NaN;
    character.group.traverse((obj) => {
      if (!(obj as { isBone?: boolean }).isBone) return;
      const q = obj.quaternion;
      const isNaNQuat = Number.isNaN(q.x) || Number.isNaN(q.y) || Number.isNaN(q.z) || Number.isNaN(q.w);
      if (isNaNQuat) {
        console.warn(`[anim-debug] NaN quaternion on "${obj.name}" at clip time ${time.toFixed(4)}s`);
        return;
      }
      let prev = this.lastQuatByBone.get(obj.name);
      if (prev) {
        const angle = prev.angleTo(q);
        if (angle > SUSPICIOUS_ANGLE_RAD) {
          console.warn(
            `[anim-debug] "${obj.name}" jumped ${((angle * 180) / Math.PI).toFixed(1)}deg in one frame at clip time ${time.toFixed(4)}s`,
            { prev: prev.toArray(), next: q.toArray() },
          );
        }
      } else {
        prev = new Quaternion();
        this.lastQuatByBone.set(obj.name, prev);
      }
      prev.copy(q);
    });
  }

  dispose(): void {
    // Must run before `group` is disposed below - same reasoning as mount()'s identical ordering comment.
    this.disposeSlotParticles(ModelType.Weapon);
    this.disposeSlotParticles(ModelType.Cloak);
    const group = this.character?.group;
    if (group) {
      this.scene.remove(group);
      disposeObject3D(group);
    }
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
    }
    this.character = null;
    this.skeletonHelper = null;
    this.cloakAnimation = null;
    this.departingCloakAnimations = [];
    this.equippedGlowOverlays = {};
    this.equippedGradeOverlays = {};
    this.equippedSocketGlow = null;
    this.helmetBaseObjects = [];
    this.helmetBaseVariant = null;
  }
}
