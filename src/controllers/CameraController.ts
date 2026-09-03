import { CameraHelper, Euler, MathUtils, MOUSE, PerspectiveCamera, Vector3 } from 'three';
import type { Bone, Quaternion, Scene } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CharacterBounds } from './CharacterController';

export type CamMode = 'third' | 'first' | 'debug';

/** How quickly the orbit target catches up to the character, per second (exponential smoothing rate). */
const FOLLOW_SMOOTHING_RATE = 4;
/** How quickly the 3rd-person orbit re-aligns to directly behind the character while it moves. */
const CAMERA_BEHIND_ROTATE_RATE = 4;
const UP_AXIS = new Vector3(0, 1, 0);
const LOOK_SENSITIVITY = 0.0035;
const MAX_LOOK_PITCH = Math.PI / 2 - 0.05;
const DEBUG_CAM_DISTANCE_RADIUS_FACTOR = 2.2;
const DEBUG_CAM_HEIGHT_RADIUS_FACTOR = 1.4;
// The head bone's origin sits inside the skull, not out at the eyes - push
// the eye point forward along the view direction so it clears the face mesh.
const EYE_FORWARD_RADIUS_FACTOR = 0.18;

export interface CameraUpdateContext {
  hipsBone: Bone | null;
  headBone: Bone | null;
  characterGroupQuaternion: Quaternion | null;
  characterPosition: Vector3 | null;
  isMoving: boolean;
}

/**
 * Owns the render camera, its OrbitControls, the three view modes (3rd
 * person follow, 1st person eye cam, locked debug cam + gizmo), and the
 * pointer input specific to camera control (right-drag orbit override,
 * first-person look-around). Reads character bone/position data handed to
 * it each frame rather than holding a reference to CharacterController, so
 * the two stay decoupled.
 */
export class CameraController {
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly gizmoCam: PerspectiveCamera;
  private readonly gizmoHelper: CameraHelper;

  private mode: CamMode = 'third';
  private modeChanged = true;

  private followHeight = 0;
  private sceneCenter = new Vector3();
  private sceneRadius = 1;

  private firstPersonYaw = 0;
  private firstPersonPitch = 0;
  /** True while the right mouse button is held - manual orbiting, so the auto-behind-follow yields. */
  private rightDragging = false;
  private leftDragging = false;

  // Reusable scratch objects, kept off the per-frame allocation path.
  private readonly followPoint = new Vector3();
  private readonly prevOrbitTarget = new Vector3();
  private readonly orbitTargetDelta = new Vector3();
  private readonly lookEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly eyeForward = new Vector3();
  private readonly behindDir = new Vector3();
  private readonly orbitOffset = new Vector3();

  private readonly domElement: HTMLElement;
  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button === 2) {
      this.rightDragging = true;
      return;
    }
    if (event.button === 0) this.leftDragging = true;
  };
  // Tracked on window, not the canvas, so releasing the button after the
  // cursor has dragged off-canvas still clears the flag.
  private readonly handleWindowPointerUp = (event: PointerEvent) => {
    if (event.button === 2) this.rightDragging = false;
    if (event.button === 0) this.leftDragging = false;
  };
  private readonly handlePointerMove = (event: PointerEvent) => {
    if (this.mode !== 'first' || !this.leftDragging) return;
    this.firstPersonYaw -= event.movementX * LOOK_SENSITIVITY;
    this.firstPersonPitch = MathUtils.clamp(
      this.firstPersonPitch - event.movementY * LOOK_SENSITIVITY,
      -MAX_LOOK_PITCH,
      MAX_LOOK_PITCH,
    );
  };

  constructor(domElement: HTMLElement, aspect: number, scene: Scene) {
    this.domElement = domElement;

    this.camera = new PerspectiveCamera(50, aspect, 0.01, 1000);
    this.camera.position.set(1.4, 1.6, 2.4);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false; // panning would fight the follow-cam target updates
    // Left button is reserved for click-to-move; orbiting is right-drag only.
    // Zoom (scroll wheel) stays on - only the middle-button dolly drag is disabled.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: MOUSE.ROTATE };
    this.controls.update();

    // Debug-cam gizmo: a literal camera object placed at the character's
    // head, oriented the same way the first-person view would look. Only
    // visible in debug mode, where the real render camera is locked in
    // place so this can be inspected from an outside vantage.
    this.gizmoCam = new PerspectiveCamera(50, 1, 0.05, 2);
    this.gizmoHelper = new CameraHelper(this.gizmoCam);
    this.gizmoHelper.visible = false;
    scene.add(this.gizmoCam);
    scene.add(this.gizmoHelper);

    domElement.addEventListener('pointerdown', this.handlePointerDown);
    domElement.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handleWindowPointerUp);
  }

  setMode(mode: CamMode): void {
    this.mode = mode;
    this.modeChanged = true;
  }

  getMode(): CamMode {
    return this.mode;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Frames the camera around a freshly mounted character's bounding box -
   * its actual units/scale aren't known ahead of time, so this can't be
   * baked in. Also resizes near/far planes and the debug gizmo's.
   */
  frameOnCharacter(bounds: CharacterBounds): void {
    const { box, center, radius } = bounds;
    this.followHeight = center.y - box.min.y; // look roughly at torso height, not the feet
    this.sceneCenter.copy(center);
    this.sceneRadius = radius;

    this.controls.target.copy(center);
    this.camera.position.set(center.x + radius * 1.4, center.y + radius * 0.6, center.z + radius * 1.4);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    this.gizmoCam.near = radius / 100;
    this.gizmoCam.far = radius * 2;
    this.gizmoCam.updateProjectionMatrix();
  }

  /** Runs once whenever the mode changes, detected in update() below. */
  private applyModeChange(ctx: CameraUpdateContext): void {
    this.controls.enabled = this.mode === 'third';
    this.gizmoHelper.visible = this.mode === 'debug';

    if (this.mode === 'first' && ctx.characterGroupQuaternion) {
      this.lookEuler.setFromQuaternion(ctx.characterGroupQuaternion, 'YXZ');
      this.firstPersonYaw = this.lookEuler.y;
      this.firstPersonPitch = 0;
    }

    if (this.mode === 'debug') {
      const center = this.sceneCenter;
      const radius = this.sceneRadius;
      this.camera.position.set(
        center.x + radius * DEBUG_CAM_DISTANCE_RADIUS_FACTOR,
        center.y + radius * DEBUG_CAM_HEIGHT_RADIUS_FACTOR,
        center.z + radius * DEBUG_CAM_DISTANCE_RADIUS_FACTOR,
      );
      this.camera.lookAt(center);
    }

    if (this.mode === 'third') this.controls.update();
  }

  update(delta: number, ctx: CameraUpdateContext): void {
    if (this.modeChanged) {
      this.modeChanged = false;
      this.applyModeChange(ctx);
    }

    if (this.mode === 'third' && ctx.characterPosition) {
      const hips = ctx.hipsBone;
      if (hips) {
        hips.getWorldPosition(this.followPoint);
      } else {
        this.followPoint.set(ctx.characterPosition.x, 0, ctx.characterPosition.z);
      }
      // Walk/run animate the hips bone up and down as part of the gait -
      // real motion for the mesh, but not something the camera should
      // chase. Take X/Z from the hips (so it stays centered as the
      // character sways) but Y from the stable root + a fixed height.
      this.followPoint.y = ctx.characterPosition.y + this.followHeight;
      const t = 1 - Math.exp(-FOLLOW_SMOOTHING_RATE * delta);
      // OrbitControls.update() re-derives its orbit offset from
      // (camera.position - target) on every call, then adds that same
      // offset back onto the *new* target - so moving target alone is a
      // no-op for camera.position, it only re-aims via the final lookAt().
      // Carrying the camera by the same delta keeps the orbit offset (and
      // so the zoom distance) fixed while actually translating with the
      // character.
      this.prevOrbitTarget.copy(this.controls.target);
      this.controls.target.lerp(this.followPoint, t);
      this.orbitTargetDelta.copy(this.controls.target).sub(this.prevOrbitTarget);
      this.camera.position.add(this.orbitTargetDelta);

      // While actually walking somewhere, ease the orbit around to
      // directly behind the character's facing - unless the user is
      // right-dragging, which takes full manual control of the angle
      // until released.
      if (ctx.isMoving && !this.rightDragging && ctx.characterGroupQuaternion) {
        this.behindDir.set(0, 0, 1).applyQuaternion(ctx.characterGroupQuaternion);
        this.behindDir.y = 0;
        if (this.behindDir.lengthSq() > 1e-8) {
          const desiredTheta = Math.atan2(this.behindDir.x, this.behindDir.z);
          const currentTheta = this.controls.getAzimuthalAngle();
          let diff = desiredTheta - currentTheta;
          diff = (((diff + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
          const rotT = 1 - Math.exp(-CAMERA_BEHIND_ROTATE_RATE * delta);
          this.orbitOffset.copy(this.camera.position).sub(this.controls.target);
          this.orbitOffset.applyAxisAngle(UP_AXIS, diff * rotT);
          this.camera.position.copy(this.controls.target).add(this.orbitOffset);
        }
      }
    } else if (this.mode === 'first' && ctx.characterPosition) {
      const head = ctx.headBone;
      this.lookEuler.set(this.firstPersonPitch, this.firstPersonYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this.lookEuler);
      if (head) {
        head.getWorldPosition(this.camera.position);
        this.eyeForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.camera.position.addScaledVector(this.eyeForward, this.sceneRadius * EYE_FORWARD_RADIUS_FACTOR);
      }
    }

    if (this.mode === 'debug' && ctx.characterPosition) {
      const head = ctx.headBone;
      if (head && ctx.characterGroupQuaternion) {
        head.getWorldPosition(this.gizmoCam.position);
        this.gizmoCam.quaternion.copy(ctx.characterGroupQuaternion);
      }
      this.gizmoHelper.update();
    }

    if (this.mode === 'third') this.controls.update();
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handleWindowPointerUp);
    this.controls.dispose();
  }
}
