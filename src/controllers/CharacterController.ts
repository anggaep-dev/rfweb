import { Box3, Matrix4, Object3D, Quaternion, SkeletonHelper, Vector3 } from 'three';
import type { AnimationAction, Bone, Group, Scene } from 'three';
import { ANI_FPS } from '../rf/animation';
import {
  LOCOMOTION_DIRECTIONS,
  RaceGender,
  buildMeshPartObjects,
  getRaceArmorArchives,
  getRaceAssets,
  getWeaponClip,
  loadCloakArchives,
  loadWeaponMeshObjects,
  weaponClipKey,
} from '../rf/character';
import type { LocomotionDirection, RfCharacter } from '../rf/character';
import { ALL_MODEL_TYPES, MODEL_TYPE_TO_PART_TOKEN, ModelType } from '../rf/items';
import type { ItemDefinition } from '../rf/items';
import { resolveCloakMeshStem, resolveItemMeshStem, resolveWeaponMesh } from '../rf/resource';

const ARRIVE_FRACTION_OF_RADIUS = 0.04;
/** Exported for OnlineScene - it derives a server-units-to-scene-units scale by matching the server's own walk speed constant against this one. */
export const WALK_SPEED_RADIUS_PER_SEC = 0.9;
/** How much faster running is than walking - the actual client's ratio isn't in this data set, so this is a reasonable-looking approximation. */
const RUN_SPEED_MULTIPLIER = 1.8;
const TURN_SPEED_RAD_PER_SEC = Math.PI * 2.2;
// The model's authored "forward" faces the opposite way from three.js's
// lookAt convention (-Z), so the computed facing needs a 180 degree
// correction around the character's up axis.
const FACING_CORRECTION = new Quaternion(0, 1, 0, 0);
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

export interface CharacterControllerCallbacks {
  onClipChange?: (name: string) => void;
  onFrameLabelChange?: (label: string) => void;
}

export type EquipResult = 'equipped' | 'default' | 'unavailable' | 'no-character';

/** The original client's battle toggle: War shows the wielded weapon and switches walk/run to their combat variant; Peace hides it and stays on the unarmed clips. */
export type BattleMode = 'peace' | 'war';
/** Which locomotion clip (and speed) click-to-move uses - independent of BattleMode, which only decides *whether* the combat variant of walk/run/stand plays. */
export type MoveMode = 'walk' | 'run';
/** The animation-token equivalent of "no weapon" in the combat clip archive - "COMBAT_FWWALK_NONE_NONE_01_00" etc, the empty-handed War-mode locomotion. */
const UNARMED_WEAPON_TOKEN = 'NONE';

/** A .eff "speed" byte of this value is the source data's own baseline (see glowEffect.ts); each +1 above it roughly doubles the scroll rate, per the tutorial this was reverse-engineered from. */
const GLOW_SPEED_BASE_BYTE = 0x40;
/** UV units/second a scrolling glow texture moves at the baseline speed byte - tuned by eye, the source data has no literal units for this. */
const GLOW_SCROLL_UV_PER_SEC = 0.6;

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

  /** The currently-equipped weapon's rendered rigid part (e.g. "W00" - see buildObjectsFromParsedMesh), or null when unarmed. Every real weapon checked so far resolves to exactly one non-empty sub-object, so the first is returned; a weapon with more than one visible part would only expose the first here. Debug-only (the %wpedit gizmo attaches to this directly - its .position/.quaternion already ARE the local offset from the bone it's rigidly parented to, the same values the placement math in character.ts computes). */
  getEquippedWeaponObject(): Object3D | null {
    return this.equippedObjects[ModelType.Weapon]?.[0] ?? null;
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

  /** A wielded weapon (and its glow overlay, if it has one) is only ever visible in War mode - see setBattleMode/equipWeapon. */
  private applyWeaponVisibility(): void {
    const visible = this.battleMode === 'war';
    const weaponObjects = this.equippedObjects[ModelType.Weapon];
    if (weaponObjects) for (const obj of weaponObjects) obj.visible = visible;
    const glowOverlay = this.equippedGlowOverlays[ModelType.Weapon];
    if (glowOverlay) for (const obj of glowOverlay.objects) obj.visible = visible;
  }

  private disposeGlowOverlayFor(modelType: ModelType): void {
    const overlay = this.equippedGlowOverlays[modelType];
    if (!overlay) return;
    disposeGlowOverlay(overlay);
    delete this.equippedGlowOverlays[modelType];
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
   */
  private async applyGlowOverlay(
    modelType: ModelType,
    item: ItemDefinition | null,
    character: RfCharacter,
    sourceObjects: Object3D[],
  ): Promise<void> {
    if (!item) return; // defaults/unequips have no catalog entry to look up a glow effect for

    const overlay = await buildGlowOverlay(item.model, sourceObjects);
    if (this.character !== character || this.equippedObjects[modelType] !== sourceObjects) {
      disposeGlowOverlay(overlay); // superseded mid-await - character swapped, or this slot got equipped again
      return;
    }
    if (overlay.objects.length === 0) return;

    this.equippedGlowOverlays[modelType] = overlay;
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
  private async applySurfaceShineFor(item: ItemDefinition | null, sourceObjects: Object3D[]): Promise<void> {
    if (!item) return; // defaults/unequips have no catalog entry to look up an effect for
    await applySurfaceShine(item.model, sourceObjects);
  }

  /** Advances every currently-active scrolling glow texture (movementMode 2 - see glowEffect.ts) by one frame. */
  private updateGlowAnimation(delta: number): void {
    for (const overlay of Object.values(this.equippedGlowOverlays)) {
      for (const { material, speedByte } of overlay.scrollingMaterials) {
        const texture = material.map;
        if (!texture) continue;
        const speedFactor = 2 ** (speedByte - GLOW_SPEED_BASE_BYTE);
        texture.offset.x = (texture.offset.x + speedFactor * GLOW_SCROLL_UV_PER_SEC * delta) % 1;
      }
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

  /** Toggles walk/run for click-to-move / joystick movement. Takes effect immediately if already mid-move, not just on the next moveTo(). */
  setMoveMode(mode: MoveMode): void {
    this.moveMode = mode;
    if (this.moveTarget || this.moveDirection) this.setDesiredClip(mode);
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
    this.setDesiredClip(this.moveMode);
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
      if (!this.moveTarget) this.setDesiredClip('stand');
    }
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

    const { meshArchive, texArchive } = await getRaceAssets(raceGender);
    // A newer mount()/equipItem() may have replaced the character while the
    // above await was in flight - bail rather than mutate a stale/disposed group.
    if (this.character !== character) return 'no-character';

    let stem: string;
    let meshArchives: (typeof meshArchive | null)[];
    let texArchives: (typeof texArchive | null)[];
    if (item) {
      const resolvedStem = await resolveItemMeshStem(item.model, raceGender);
      if (this.character !== character) return 'no-character'; // superseded mid-await
      if (!resolvedStem) return 'unavailable';
      stem = resolvedStem;

      // Real armor items may live in the per-race armor-tier archives, not
      // the default body archive above - fetched (and cached) on demand
      // here rather than eagerly for every race at startup, see
      // getRaceArmorArchives. The default/base-appearance path below never
      // needs this - that stem is always in the archive already fetched.
      const armor = await getRaceArmorArchives(raceGender);
      if (this.character !== character) return 'no-character'; // superseded mid-await
      meshArchives = [meshArchive, ...armor.meshArchives];
      texArchives = [texArchive, ...armor.texArchives];
    } else {
      // See baseAppearance's doc comment - this is the character's own
      // chosen variant for this slot, not always "_000".
      const variant = this.baseAppearance[modelType] ?? 0;
      stem = `${character.group.name}_DEFAULT_${MODEL_TYPE_TO_PART_TOKEN[modelType]}_${String(variant).padStart(3, '0')}`;
      meshArchives = [meshArchive];
      texArchives = [texArchive];
    }

    const newObjects = buildMeshPartObjects(stem, meshArchives, texArchives, character.builtSkeleton);
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
    void this.applyGlowOverlay(modelType, item, character, newObjects);
    void this.applySurfaceShineFor(item, newObjects);

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
      if (previous) {
        for (const obj of previous) {
          obj.parent?.remove(obj);
          disposeObject3D(obj);
        }
        delete this.equippedObjects[ModelType.Weapon];
      }
      this.disposeGlowOverlayFor(ModelType.Weapon);
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

    if (previous) {
      for (const obj of previous) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
      }
    }
    this.disposeGlowOverlayFor(ModelType.Weapon);

    for (const obj of newObjects) {
      if (!obj.parent) character.group.add(obj);
    }
    this.equippedObjects[ModelType.Weapon] = newObjects;
    this.currentWeaponToken = weaponMesh.weaponToken;
    this.currentWeaponItem = item;
    this.currentWeaponStem = weaponMesh.stem;
    void this.applyGlowOverlay(ModelType.Weapon, item, character, newObjects);
    void this.applySurfaceShineFor(item, newObjects);

    // Only actually visible in War mode - see setBattleMode. The combat
    // clips for this weapon were already prewarmed just above, regardless
    // of the current mode, so they're ready the instant the
    // player toggles into War.
    this.applyWeaponVisibility();

    return 'equipped';
  }

  /**
   * Cloak-slot equip: like Weapon, has no default appearance (an unequipped
   * character just shows nothing there) - but unlike a weapon, a cloak is a
   * skinned mesh that drapes over the body (not a rigid single-bone attach),
   * so it goes through the same buildMeshPartObjects path as a body-part
   * item, just resolved via resolveCloakMeshStem/loadCloakArchives (the
   * race-agnostic item/Armor/ archives) instead of resolveItemMeshStem/
   * getRaceAssets (the per-race character/player/Mesh armor archives) -
   * verified cloak meshes actually live in the former, not the latter.
   */
  private async equipCloak(item: ItemDefinition | null): Promise<EquipResult> {
    const character = this.character;
    const raceGender = this.raceGender;
    if (!character || raceGender === null) return 'no-character';

    this.currentBodyItem[ModelType.Cloak] = item;
    const previous = this.equippedObjects[ModelType.Cloak];

    if (!item) {
      if (previous) {
        for (const obj of previous) {
          obj.parent?.remove(obj);
          disposeObject3D(obj);
        }
        delete this.equippedObjects[ModelType.Cloak];
      }
      this.disposeGlowOverlayFor(ModelType.Cloak);
      return 'default';
    }

    const stem = await resolveCloakMeshStem(item.model, raceGender);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    if (!stem) return 'unavailable';

    const { meshArchives, texArchives } = await loadCloakArchives();
    if (this.character !== character) return 'no-character'; // superseded mid-await

    const newObjects = buildMeshPartObjects(stem, meshArchives, texArchives, character.builtSkeleton);
    if (newObjects.length === 0) return 'unavailable';

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
    void this.applySurfaceShineFor(item, newObjects);

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
      // Base appearance is always in the default body archive - never needs
      // the (lazily-loaded) armor-tier archives, see getRaceArmorArchives.
      const { meshArchive, texArchive } = await getRaceAssets(raceGender);
      if (this.character !== character) return 'no-character'; // superseded mid-await

      this.helmetBaseObjects = buildMeshPartObjects(stem, [meshArchive], [texArchive], character.builtSkeleton);
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

    const { meshArchive, texArchive } = await getRaceAssets(raceGender);
    if (this.character !== character) return 'no-character'; // superseded mid-await
    const armor = await getRaceArmorArchives(raceGender);
    if (this.character !== character) return 'no-character'; // superseded mid-await

    const newObjects = buildMeshPartObjects(
      resolvedStem,
      [meshArchive, ...armor.meshArchives],
      [texArchive, ...armor.texArchives],
      character.builtSkeleton,
    );
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
    void this.applyGlowOverlay(ModelType.Helmet, item, character, newObjects);
    void this.applySurfaceShineFor(item, newObjects);

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
    // Not individually disposed here - every glow overlay mesh is a
    // descendant of prevGroup (parented to either the group itself or one
    // of its bones), so the disposeObject3D(prevGroup) traversal above
    // already freed them; this just drops the now-stale bookkeeping so
    // update()/applyWeaponVisibility() stop iterating dangling entries.
    this.equippedGlowOverlays = {};
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
      const speed = (this.moveMode === 'run' ? this.walkSpeed * RUN_SPEED_MULTIPLIER : this.walkSpeed) * intensity;
      character.group.position.addScaledVector(dirNorm, speed * delta);

      const faceSource = this.faceDirection ?? direction;
      const faceNorm = faceSource === direction ? dirNorm : faceSource.clone().normalize();
      const facePoint = character.group.position.clone().add(faceNorm);
      this.lookMatrix.lookAt(facePoint, character.group.position, character.group.up);
      this.lookTargetQuat.setFromRotationMatrix(this.lookMatrix).multiply(FACING_CORRECTION);
      character.group.quaternion.rotateTowards(this.lookTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);
      this.setDesiredClip(this.moveMode);
    } else {
      const target = this.moveTarget;
      if (target) {
        const toTarget = new Vector3(target.x - character.group.position.x, 0, target.z - character.group.position.z);
        const distance = toTarget.length();

        if (distance <= this.arriveThreshold) {
          this.moveTarget = null;
          arrived = true;
          console.log('[anim-debug] arrived at click-to-move target, switching to "stand"');
          this.setDesiredClip('stand');
        } else {
          toTarget.normalize();
          const speed = this.moveMode === 'run' ? this.walkSpeed * RUN_SPEED_MULTIPLIER : this.walkSpeed;
          const step = Math.min(distance, speed * delta);
          character.group.position.addScaledVector(toTarget, step);
          character.group.position.y = target.y;

          const facePoint = character.group.position.clone().add(toTarget);
          this.lookMatrix.lookAt(facePoint, character.group.position, character.group.up);
          this.lookTargetQuat.setFromRotationMatrix(this.lookMatrix).multiply(FACING_CORRECTION);
          character.group.quaternion.rotateTowards(this.lookTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);
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

    return { arrived };
  }

  /**
   * Maps an abstract desired clip ("walk"/"run"/"stand"/"sit") to the
   * actual clips key to play, in priority order:
   *
   * 1. War + directional (moveLocomotionDirection set, walk/run only): the
   *    combat clip for the wielded weapon token AND that exact backward/
   *    strafe direction - only ever cached for Accretia (see getWeaponClip).
   * 2. Directional, unarmed: the real backward/strafe clip every race has
   *    in Peace's ETA archive (see LocomotionDirection) - tried *before*
   *    the direction-blind combat clip below, armed or not, because a real
   *    backward/strafing leg animation (just missing the weapon-drawn arm
   *    pose) reads far better than a forward-facing combat walk/run playing
   *    while the character is visibly moving backward or sideways. This is
   *    what makes backward/strafe movement look right while armed on every
   *    race but Accretia, which is the only one with step 1's clips.
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
    const direction = isLocomotion ? this.moveLocomotionDirection : null;
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
    this.equippedGlowOverlays = {};
    this.helmetBaseObjects = [];
    this.helmetBaseVariant = null;
  }
}
