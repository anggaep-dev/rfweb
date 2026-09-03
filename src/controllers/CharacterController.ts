import { Box3, Group, Matrix4, Quaternion, SkeletonHelper, Vector3 } from 'three';
import type { AnimationAction, Bone, Scene } from 'three';
import { ANI_FPS } from '../rf/animation';
import type { RfCharacter } from '../rf/character';

const ARRIVE_FRACTION_OF_RADIUS = 0.04;
const WALK_SPEED_RADIUS_PER_SEC = 0.9;
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

function disposeGroup(group: Group): void {
  group.traverse((obj) => {
    const renderable = obj as { geometry?: { dispose(): void }; material?: unknown };
    renderable.geometry?.dispose();
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    for (const material of materials as { map?: { dispose(): void }; dispose(): void }[]) {
      material.map?.dispose();
      material.dispose();
    }
  });
}

/**
 * Owns the currently-mounted RfCharacter: adding/disposing its group and
 * skeleton helper, click-to-move movement + facing, animation clip
 * crossfades, the frame-stepping debug tools, and the pose-anomaly
 * watchdog. Scene-aware only enough to add/remove its own objects - camera
 * framing and the click-to-move target marker are the caller's job (they're
 * cross-cutting scene concerns, not character state).
 */
export class CharacterController {
  private character: RfCharacter | null = null;
  private skeletonHelper: SkeletonHelper | null = null;
  private hipsBone: Bone | null = null;
  private headBone: Bone | null = null;

  private moveTarget: Vector3 | null = null;
  private walkSpeed = 1;
  private arriveThreshold = 0.05;

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
    return this.moveTarget !== null;
  }

  setShowBones(show: boolean): void {
    this.showBones = show;
    if (this.skeletonHelper) this.skeletonHelper.visible = show;
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
    this.desiredClip = name;
    this.callbacks.onClipChange?.(name);
  }

  moveTo(point: Vector3): void {
    console.log('[anim-debug] click-to-move triggered', {
      from: this.character?.group.position.toArray().map((n) => +n.toFixed(3)),
      to: point.toArray().map((n) => +n.toFixed(3)),
      previousClip: this.desiredClip,
    });
    this.moveTarget = point.clone();
    this.desiredClip = 'walk';
    this.callbacks.onClipChange?.('walk');
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
   * Swaps in a freshly loaded character: disposes the previous one (group +
   * skeleton helper), resets all movement/animation state, and returns its
   * bounding box for the caller to frame the camera/ground with (units/scale
   * differ per race, so that can't be baked in ahead of time).
   */
  mount(character: RfCharacter): CharacterBounds {
    const prevGroup = this.character?.group;
    if (prevGroup) {
      this.scene.remove(prevGroup);
      disposeGroup(prevGroup);
    }
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
    }

    this.character = character;
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
    this.desiredClip = 'stand';
    this.currentClipKey = null;
    this.activeAction = null;
    this.lastQuatByBone.clear();
    this.callbacks.onClipChange?.('stand');
    this.callbacks.onFrameLabelChange?.('');

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
    const target = this.moveTarget;
    if (target) {
      const toTarget = new Vector3(target.x - character.group.position.x, 0, target.z - character.group.position.z);
      const distance = toTarget.length();

      if (distance <= this.arriveThreshold) {
        this.moveTarget = null;
        arrived = true;
        console.log('[anim-debug] arrived at click-to-move target, switching to "stand"');
        this.desiredClip = 'stand';
        this.callbacks.onClipChange?.('stand');
      } else {
        toTarget.normalize();
        const step = Math.min(distance, this.walkSpeed * delta);
        character.group.position.addScaledVector(toTarget, step);
        character.group.position.y = target.y;

        const facePoint = character.group.position.clone().add(toTarget);
        this.lookMatrix.lookAt(facePoint, character.group.position, character.group.up);
        this.lookTargetQuat.setFromRotationMatrix(this.lookMatrix).multiply(FACING_CORRECTION);
        character.group.quaternion.rotateTowards(this.lookTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);
      }
    }

    // Driven off desiredClip every frame, not a one-shot effect - switching
    // purely through an external effect lags the rAF loop by at least one
    // commit, which (combined with a hard stopAllAction()/play() cut) was a
    // real source of visible pops between clips.
    if (this.desiredClip !== this.currentClipKey) {
      const nextName = this.desiredClip;
      const nextClip = character.clips[nextName];
      if (nextClip) {
        console.log(`[anim-debug] clip switched to "${nextName}"`);
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
      this.currentClipKey = nextName;
    }

    character.mixer.update(delta);
    this.checkForPoseAnomalies(character);

    return { arrived };
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
      disposeGroup(group);
    }
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
    }
    this.character = null;
    this.skeletonHelper = null;
  }
}
