import { Box3, LoopRepeat, Quaternion, Vector3 } from 'three';
import type { Scene } from 'three';
import type { MonsterAsset } from '../rf/monster';
import { instantiateMonster } from '../rf/monster';

export type MonsterMode = 'peace' | 'war';

/** Same formula/reasoning as CharacterController's own walk speed - see docs/rf-format-notes.md's "Character movement": speed and arrival tolerance both scale off a bounding-sphere radius computed once at mount, so a huge monster doesn't visibly crawl and a tiny one doesn't overshoot its target every step. */
const WALK_SPEED_RADIUS_PER_SEC = 0.9;
const ARRIVE_FRACTION_OF_RADIUS = 0.04;
/** Same constant CharacterController turns at (π × 2.2 rad/s) - no reason a monster should turn noticeably slower/faster than the player by default. */
const TURN_SPEED_RAD_PER_SEC = Math.PI * 2.2;

const UP_AXIS = new Vector3(0, 1, 0);
const scratchDirection = new Vector3();
const scratchTargetQuat = new Quaternion();
const scratchBox = new Box3();
const scratchSize = new Vector3();

/**
 * Owns one spawned monster instance: its cloned scene graph, its own
 * independent AnimationMixer, manual/automatic clip playback, and now (see
 * moveTo/update) the same kind of walk-there-then-idle steering
 * BotController's CharacterController-backed bots use, driven externally by
 * MonsterBotController's own wander orchestration - this class only knows
 * how to move toward a point and which clip that implies, not when to pick
 * a new one. Clip choice is mode-aware (see MonsterMode): `mode` selects
 * the PEACE/WAR* clip family a monster's own MonsterCharacter.json state
 * split implies, same PEACE/WAR distinction the player's own battle-mode
 * toggle uses.
 */
export class MonsterController {
  private scene: Scene;
  private instance: ReturnType<typeof instantiateMonster> | null = null;
  private currentClipName: string | null = null;
  private mode: MonsterMode = 'peace';

  private moveTarget: Vector3 | null = null;
  private radius = 1;
  private walkSpeed = WALK_SPEED_RADIUS_PER_SEC;
  private arriveThreshold = ARRIVE_FRACTION_OF_RADIUS;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get group() {
    return this.instance?.root ?? null;
  }

  get currentClip(): string | null {
    return this.currentClipName;
  }

  /** Available embedded clip names for this instance, in file order - see MonsterAsset.clips. */
  getClipNames(): string[] {
    return this.instance?.clips.map((c) => c.name) ?? [];
  }

  hasClip(name: string): boolean {
    return this.instance?.clips.some((c) => c.name === name) ?? false;
  }

  mount(asset: MonsterAsset, mode: MonsterMode = 'peace'): void {
    this.instance = instantiateMonster(asset);
    this.mode = mode;
    this.scene.add(this.instance.root);

    // Bounding-sphere radius from the actual mesh, not a fixed guess - real
    // monster sizes here range from a ~1-unit pig to a multi-bone boss, and
    // a single fixed walk speed/arrival tolerance would make the small ones
    // crawl and the huge ones jitter past their own target every step (see
    // CharacterController's identical reasoning for the player).
    scratchBox.setFromObject(this.instance.root);
    scratchBox.getSize(scratchSize);
    this.radius = Math.max(scratchSize.x, scratchSize.y, scratchSize.z) * 0.5 || 1;
    this.walkSpeed = this.radius * WALK_SPEED_RADIUS_PER_SEC;
    this.arriveThreshold = this.radius * ARRIVE_FRACTION_OF_RADIUS;

    this.playIdleRandom();
  }

  setMode(mode: MonsterMode): void {
    this.mode = mode;
  }

  /** Force-plays one of this instance's embedded clips directly, looping so it stays visible for inspection. Returns false (no-op) if this instance doesn't have a clip with that exact name - see monster_to_gltf.py's DEFAULT_STATES for the real vocabulary. */
  playClip(name: string): boolean {
    if (!this.instance) return false;
    const clip = this.instance.clips.find((c) => c.name === name);
    if (!clip) return false;
    if (this.currentClipName === name) return true; // already playing - avoid restarting it from frame 0 every call
    this.instance.mixer.stopAllAction();
    this.instance.mixer.clipAction(clip).reset().setLoop(LoopRepeat, Infinity).play();
    this.currentClipName = name;
    return true;
  }

  /**
   * Picks randomly between this mode's STAND and IDLE clips (whichever of
   * the two this monster actually has - not every monster has both, see
   * monster_to_gltf.py's own per-monster state coverage), falling back to
   * the other mode's pair if this mode has neither (e.g. spawned in War but
   * this particular monster never got a WARSTAND/WARIDLE clip), and finally
   * leaving whatever's currently playing untouched if nothing at all
   * matches. Called on mount and every time a wander hop arrives (see
   * MonsterBotController's own update loop).
   */
  playIdleRandom(): void {
    const tryModePair = (mode: MonsterMode): boolean => {
      const prefix = mode === 'war' ? 'WAR' : 'PEACE';
      const candidates = [`${prefix}STAND`, `${prefix}IDLE`].filter((name) => this.hasClip(name));
      if (candidates.length === 0) return false;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      this.playClip(pick);
      return true;
    };
    if (tryModePair(this.mode)) return;
    tryModePair(this.mode === 'war' ? 'peace' : 'war');
  }

  /** This mode's walk clip ("PEACEWALK"/"WARWALK"), or null if this monster doesn't have one - moveTo checks this before committing to a target (see its own doc comment on why). */
  private walkClipName(): string | null {
    const name = `${this.mode === 'war' ? 'WAR' : 'PEACE'}WALK`;
    return this.hasClip(name) ? name : null;
  }

  /**
   * Starts steering toward `target` (XZ plane only - no vertical movement),
   * playing this mode's walk clip. A monster with no walk clip at all for
   * either mode can't visibly walk without looking like it's skating on a
   * frozen pose, so this is a no-op for it - MonsterBotController's wander
   * loop just leaves such an instance idling in place forever instead.
   */
  moveTo(target: Vector3): void {
    if (!this.instance || !this.group) return;
    const walkClip = this.walkClipName();
    if (!walkClip) return;
    this.moveTarget = target.clone();
    this.playClip(walkClip);
  }

  isMoving(): boolean {
    return this.moveTarget !== null;
  }

  update(delta: number): void {
    if (this.instance) this.instance.mixer.update(delta);
    if (!this.moveTarget || !this.group) return;

    scratchDirection.subVectors(this.moveTarget, this.group.position);
    scratchDirection.y = 0;
    const distance = scratchDirection.length();
    if (distance <= this.arriveThreshold) {
      this.moveTarget = null;
      this.playIdleRandom();
      return;
    }

    scratchDirection.normalize();
    // A character's local forward (once its group's own quaternion is
    // identity/yaw=0) is world (0,0,-1), not +Z - see compassRotation.ts's
    // rotationToYaw/continuousRotationFromVector for the proven derivation
    // this mirrors ("facing = (-sin(yaw), -cos(yaw))"): solving that for a
    // target (dx, dz) gives yaw = atan2(-dx, -dz), not atan2(dx, dz) (which
    // is what this line originally had, and which pointed every wandering
    // monster exactly backwards from its actual travel direction).
    scratchTargetQuat.setFromAxisAngle(UP_AXIS, Math.atan2(-scratchDirection.x, -scratchDirection.z));
    this.group.quaternion.rotateTowards(scratchTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);

    const step = Math.min(this.walkSpeed * delta, distance);
    this.group.position.addScaledVector(scratchDirection, step);
  }

  /**
   * Removes this instance from the scene. Deliberately does NOT dispose any
   * geometry/material/texture - SkeletonUtils.clone() (see
   * instantiateMonster) only clones the lightweight bone hierarchy and mesh
   * wrappers, not the underlying geometry/material/texture, which stay
   * shared with MonsterAsset.template and every other spawned instance of
   * the same monster. Disposing them here would corrupt every sibling
   * instance (and the cached asset itself, breaking any future spawn of
   * this monster too) - there is currently no "unload this monster asset
   * entirely" path, same as this project's other pooled-resource caches
   * (see character.ts's userData.pooled weapon textures for the same
   * reasoning applied to a single shared resource instead of a whole clone).
   */
  dispose(): void {
    if (!this.instance) return;
    this.scene.remove(this.instance.root);
    this.instance.mixer.stopAllAction();
    this.instance = null;
    this.moveTarget = null;
  }
}
