import { Euler, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { AssetController } from '../controllers/AssetController';
import { BotController } from '../controllers/BotController';
import { CameraController } from '../controllers/CameraController';
import { CharacterController } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
import { classifyLocomotionDirection } from '../rf/character';
import type { RaceGender } from '../rf/character';
import type { AppScene } from './AppScene';

const CLICK_DRAG_TOLERANCE_PX = 12;
const UP_AXIS = new Vector3(0, 1, 0);
/** How often the FPS/memory readout refreshes - every frame would be unreadable and wasteful to re-render for. */
const STATS_UPDATE_INTERVAL_SEC = 0.5;
const BYTES_PER_MB = 1024 * 1024;

/** Chrome-only, non-standard - not in the DOM lib types. Absent on other engines. */
interface PerformanceMemoryInfo {
  usedJSHeapSize: number;
}

export interface ViewerDebugStats {
  fps: number;
  heapMB: number | null;
  geometries: number;
  textures: number;
  /** The resolved animation clip key actually playing (e.g. "walk:TCROSSBOW:rt"), or null before the first frame resolves one. */
  clipKey: string | null;
  /** The currently-equipped weapon, or null when unarmed - id/name for identifying the item, token/stem for correlating an animation or placement bug back to specific source data. */
  weapon: { id: string; name: string; token: string | null; stem: string | null } | null;
}

/** A weapon-part transform, both position and rotation, in the same local space CharacterController's placement math operates in (i.e. relative to the bone it's rigidly attached to) - see WeaponEditState. */
export interface WeaponEditTransform {
  position: [number, number, number];
  /** Euler angles in degrees, XYZ order - easier to read/compare by eye than a raw quaternion. */
  eulerDeg: [number, number, number];
}

/** Live state for the %wpedit gizmo - see ViewerScene.setWeaponEditEnabled/setWeaponEditMode. */
export interface WeaponEditState {
  weaponLabel: string;
  mode: 'translate' | 'rotate';
  /** The transform CharacterController originally computed (captured once, when the gizmo attaches) - the "before" side of a comparison. */
  original: WeaponEditTransform;
  /** The live transform as the gizmo is dragged - the "after" side. */
  current: WeaponEditTransform;
}

export interface ViewerSceneCallbacks {
  onClipChange?: (name: string) => void;
  onFrameLabelChange?: (label: string) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
  onStatsUpdate?: (stats: ViewerDebugStats) => void;
  /** Fires whenever the %wpedit gizmo's target/transform changes - null while disabled or unarmed. */
  onWeaponEditChange?: (state: WeaponEditState | null) => void;
}

/**
 * The in-game character viewer/editor screen: mounts a race's character,
 * lets it be equipped/animated/moved around, and spawns wandering
 * GM-command bots alongside it. One AppScene among several the SceneManager
 * can switch to - character/camera/bot orchestration that used to be
 * RfViewer's own mount effect, now reusable regardless of which screen led
 * here.
 */
export class ViewerScene implements AppScene {
  readonly sceneController = new SceneController();
  readonly cameraController: CameraController;
  readonly characterController: CharacterController;
  readonly botController: BotController;
  readonly assetController = new AssetController();

  private readonly renderer: WebGLRenderer;
  private readonly callbacks: ViewerSceneCallbacks;
  private disposed = false;

  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private pointerDownPos: { x: number; y: number } | null = null;

  /** Raw directional input (x = right, y = forward) from whichever source last drove it - the mobile joystick or WASD/arrow keys - or null while neither is active. Converted to a camera-relative world direction each frame in update(). */
  private moveInput: { x: number; y: number } | null = null;
  private readonly moveForward = new Vector3();
  private readonly moveRight = new Vector3();
  private readonly moveDirection = new Vector3();

  private statsFrameCount = 0;
  private statsElapsed = 0;

  // %wpedit - see setWeaponEditEnabled/setWeaponEditMode. transformControls
  // (three's own move/rotate gizmo, the same interaction model Blender's
  // G/R handles use) is created once and reused across attach/detach - only
  // its .enabled/visibility and attached object change, not the instance.
  private readonly transformControls: TransformControls;
  private weaponEditEnabled = false;
  private weaponEditMode: 'translate' | 'rotate' = 'translate';
  private weaponEditTarget: Object3D | null = null;
  private weaponEditOriginal: { position: Vector3; quaternion: Quaternion } | null = null;

  constructor(renderer: WebGLRenderer, private initialRaceGender: RaceGender, callbacks: ViewerSceneCallbacks = {}) {
    this.renderer = renderer;
    this.callbacks = callbacks;

    this.cameraController = new CameraController(
      renderer.domElement,
      renderer.domElement.clientWidth / renderer.domElement.clientHeight,
      this.sceneController.scene,
    );
    this.characterController = new CharacterController(this.sceneController.scene, {
      onClipChange: (name) => {
        if (!this.disposed) this.callbacks.onClipChange?.(name);
      },
      onFrameLabelChange: (label) => {
        if (!this.disposed) this.callbacks.onFrameLabelChange?.(label);
      },
    });
    this.botController = new BotController(this.sceneController.scene);

    this.transformControls = new TransformControls(this.cameraController.camera, renderer.domElement);
    this.transformControls.enabled = false;
    this.transformControls.getHelper().visible = false;
    this.sceneController.scene.add(this.transformControls.getHelper());
    // TransformControls' own pointer handlers never call stopPropagation, so
    // a gizmo drag would otherwise also fire this scene's click-to-move (see
    // onPointerUp's weaponEditEnabled guard) - and separately, dragging the
    // gizmo shouldn't also orbit the camera, hence disabling OrbitControls
    // for the duration (the standard pattern for combining the two).
    this.transformControls.addEventListener('dragging-changed', (event) => {
      this.cameraController.controls.enabled = !(event as unknown as { value: boolean }).value;
    });
    this.transformControls.addEventListener('objectChange', () => this.emitWeaponEditState());
  }

  get scene() {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.cameraController.camera;
  }

  mount(): void {
    // Resolves immediately - the character itself loads in the background
    // (status reported via onStatusChange) so switching into this scene
    // doesn't block on the network.
    this.loadRace(this.initialRaceGender);
  }

  /** Loads (or switches to) a race's character. Assets are expected to already be cached (see AssetController.preload(), run once at app startup) so this is normally near-instant. */
  loadRace(race: RaceGender): void {
    this.callbacks.onStatusChange?.('loading');
    this.assetController
      .loadRace(race)
      .then(async (character) => {
        if (this.disposed || !character) return; // null means a newer loadRace() superseded this one

        const bounds = await this.characterController.mount(character, race);
        if (this.disposed) return;
        this.sceneController.frameGround(bounds.box, bounds.radius);
        this.cameraController.frameOnCharacter(bounds);
        this.callbacks.onStatusChange?.('ready');
      })
      .catch((err: unknown) => {
        if (this.disposed) return;
        console.error('Failed to load character:', err);
        this.callbacks.onStatusChange?.('error', err instanceof Error ? err.message : String(err));
      });
  }

  async runCommand(raw: string): Promise<string> {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('%')) return `Commands start with "%" - got "${trimmed}".`;
    const [name, ...args] = trimmed.slice(1).split(/\s+/);

    switch (name.toLowerCase()) {
      case 'addbot': {
        const requested = Number.parseInt(args[0] ?? '1', 10);
        const added = await this.botController.spawnBots(requested);
        return `Spawned ${added} bot${added === 1 ? '' : 's'} (${this.botController.count} total).`;
      }
      case 'clearbots': {
        const removed = this.botController.clearBots();
        return `Removed ${removed} bot${removed === 1 ? '' : 's'}.`;
      }
      default:
        return `Unknown command "%${name}". Try %addbot <count> or %clearbots.`;
    }
  }

  /** Continuous directional input from the mobile joystick or WASD/arrow keys: x = right, y = forward, both roughly [-1, 1] (magnitude scales speed). Pass null on release. Resolved to a camera-relative world direction fresh every frame in update(), so it stays correct as the camera orbits. */
  setMoveInput(input: { x: number; y: number } | null): void {
    this.moveInput = input;
    if (input) this.sceneController.hideTargetMarker(); // engaging supersedes any pending click-to-move
  }

  /**
   * %wpedit 1/0 - attaches (or detaches) a Blender-style move/rotate gizmo
   * onto the currently-equipped weapon mesh, so its position/rotation can be
   * dragged by hand to find the visually-correct placement, then compared
   * against what CharacterController actually computed (see
   * getCorrectedRigidBindInverse in character.ts) - the gap between the two
   * is exactly the data a placement-math fix needs. The weapon object's own
   * .position/.quaternion ARE its local transform relative to the bone it's
   * rigidly parented to (see buildObjectsFromParsedMesh), so no extra
   * space-conversion is needed here - dragging the gizmo edits precisely the
   * same values that math produces.
   */
  setWeaponEditEnabled(enabled: boolean): void {
    this.weaponEditEnabled = enabled;
    this.transformControls.enabled = enabled;
    this.transformControls.getHelper().visible = enabled;

    if (!enabled) {
      this.transformControls.detach();
      this.weaponEditTarget = null;
      this.weaponEditOriginal = null;
      this.callbacks.onWeaponEditChange?.(null);
      return;
    }

    this.syncWeaponEditTarget();
  }

  /**
   * Re-attaches the gizmo to whatever CharacterController.
   * getEquippedWeaponObject() currently returns, if it's changed since the
   * last attach - called once from setWeaponEditEnabled(true) and every
   * frame from update() while editing is on. Needed because equipping a
   * *different* weapon while the gizmo is already attached disposes the
   * old mesh object out from under it (see equipWeapon's dispose call) -
   * without this, the gizmo/readout would keep pointing at a disposed
   * object showing the previous weapon's stale transform, silently
   * unrelated to whatever's actually equipped and visible now.
   */
  private syncWeaponEditTarget(): void {
    const weaponObject = this.characterController.getEquippedWeaponObject();
    if (weaponObject === this.weaponEditTarget) return;

    if (!weaponObject) {
      this.transformControls.detach();
      this.weaponEditTarget = null;
      this.weaponEditOriginal = null;
      this.callbacks.onWeaponEditChange?.(null);
      return;
    }
    this.weaponEditTarget = weaponObject;
    this.weaponEditOriginal = { position: weaponObject.position.clone(), quaternion: weaponObject.quaternion.clone() };
    this.transformControls.attach(weaponObject);
    this.emitWeaponEditState();
  }

  setWeaponEditMode(mode: 'translate' | 'rotate'): void {
    this.weaponEditMode = mode;
    this.transformControls.setMode(mode);
    this.emitWeaponEditState();
  }

  /** Snaps the gizmo's target back to the transform CharacterController originally computed (captured when the gizmo attached), so a bad drag doesn't have to be undone by eye. */
  resetWeaponEditTransform(): void {
    if (!this.weaponEditTarget || !this.weaponEditOriginal) return;
    this.weaponEditTarget.position.copy(this.weaponEditOriginal.position);
    this.weaponEditTarget.quaternion.copy(this.weaponEditOriginal.quaternion);
    this.emitWeaponEditState();
  }

  private emitWeaponEditState(): void {
    if (!this.weaponEditEnabled || !this.weaponEditTarget || !this.weaponEditOriginal) {
      this.callbacks.onWeaponEditChange?.(null);
      return;
    }
    const weapon = this.characterController.getCurrentWeapon();
    const toTransform = (position: Vector3, quaternion: Quaternion): WeaponEditTransform => {
      const euler = new Euler().setFromQuaternion(quaternion, 'XYZ');
      return {
        position: [position.x, position.y, position.z],
        eulerDeg: [(euler.x * 180) / Math.PI, (euler.y * 180) / Math.PI, (euler.z * 180) / Math.PI],
      };
    };
    this.callbacks.onWeaponEditChange?.({
      weaponLabel: weapon
        ? `${weapon.item.name} (${weapon.item.id}) token=${weapon.token ?? 'none'} stem=${weapon.stem ?? 'unknown'}`
        : 'Unarmed',
      mode: this.weaponEditMode,
      original: toTransform(this.weaponEditOriginal.position, this.weaponEditOriginal.quaternion),
      current: toTransform(this.weaponEditTarget.position, this.weaponEditTarget.quaternion),
    });
  }

  update(delta: number): void {
    if (this.weaponEditEnabled) this.syncWeaponEditTarget();

    if (this.moveInput) {
      const { x, y } = this.moveInput;
      const camera = this.cameraController.camera;
      camera.getWorldDirection(this.moveForward);
      this.moveForward.y = 0;
      if (this.moveForward.lengthSq() > 1e-8) this.moveForward.normalize();
      this.moveRight.crossVectors(this.moveForward, UP_AXIS).normalize();
      this.moveDirection.set(0, 0, 0).addScaledVector(this.moveForward, y).addScaledVector(this.moveRight, x);
      // Backward/strafe-dominant input plays a real backward/strafe clip
      // and keeps facing forward instead of turning to face travel
      // direction - see classifyLocomotionDirection. Forward-dominant input
      // (null here) keeps the original behavior: plain walk/run, facing the
      // resultant (possibly diagonal) direction, which was already smooth.
      const locomotionDirection = classifyLocomotionDirection(x, y);
      const faceDirection = locomotionDirection ? this.moveForward : this.moveDirection;
      this.characterController.setMoveDirection(this.moveDirection, faceDirection, locomotionDirection);
    } else {
      this.characterController.setMoveDirection(null);
    }

    const { arrived } = this.characterController.update(delta);
    if (arrived) this.sceneController.hideTargetMarker();
    this.botController.update(delta);

    const character = this.characterController.getCharacter();
    this.cameraController.update(delta, {
      hipsBone: this.characterController.getHipsBone(),
      headBone: this.characterController.getHeadBone(),
      characterGroupQuaternion: character ? character.group.quaternion : null,
      characterPosition: character ? character.group.position : null,
      isMoving: this.characterController.isMoving(),
    });

    this.statsFrameCount += 1;
    this.statsElapsed += delta;
    if (this.statsElapsed >= STATS_UPDATE_INTERVAL_SEC) {
      const perfMemory = (performance as Performance & { memory?: PerformanceMemoryInfo }).memory;
      const weapon = this.characterController.getCurrentWeapon();
      this.callbacks.onStatsUpdate?.({
        fps: Math.round(this.statsFrameCount / this.statsElapsed),
        heapMB: perfMemory ? Math.round(perfMemory.usedJSHeapSize / BYTES_PER_MB) : null,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        clipKey: this.characterController.getCurrentClipKey(),
        weapon: weapon ? { id: weapon.item.id, name: weapon.item.name, token: weapon.token, stem: weapon.stem } : null,
      });
      this.statsFrameCount = 0;
      this.statsElapsed = 0;
    }
  }

  resize(aspect: number): void {
    this.cameraController.setAspect(aspect);
  }

  // Click-to-move: left-button only (right button is camera orbit, owned by
  // CameraController). Kept here rather than in either controller since it
  // inherently needs camera (for the raycast) + scene (the ground plane +
  // marker) + character (the move command) together.
  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.weaponEditEnabled) return;
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  }

  onPointerUp(event: PointerEvent): void {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    // TransformControls' pointer handlers never call stopPropagation, so a
    // gizmo drag/click would otherwise also land here as a click-to-move.
    if (this.weaponEditEnabled) return;
    if (!down) return;
    const movedPx = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (movedPx > CLICK_DRAG_TOLERANCE_PX) return; // was a camera drag, not a click
    if (this.cameraController.getMode() !== 'third') return; // click-to-move only makes sense in 3rd person
    if (!this.characterController.getCharacter()) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.cameraController.camera);
    const hit = new Vector3();
    if (this.raycaster.ray.intersectPlane(this.sceneController.groundPlane, hit)) {
      this.characterController.moveTo(hit);
      this.sceneController.showTargetMarker(hit);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.assetController.cancelPending();
    this.sceneController.scene.remove(this.transformControls.getHelper());
    this.transformControls.dispose();
    this.cameraController.dispose();
    this.characterController.dispose();
    this.botController.dispose();
    this.sceneController.dispose();
  }
}
