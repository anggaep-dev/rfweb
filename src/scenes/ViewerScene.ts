import { Raycaster, Vector2, Vector3 } from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { AssetController } from '../controllers/AssetController';
import { BotController } from '../controllers/BotController';
import { CameraController } from '../controllers/CameraController';
import { CharacterController } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
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
}

export interface ViewerSceneCallbacks {
  onClipChange?: (name: string) => void;
  onFrameLabelChange?: (label: string) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
  onStatsUpdate?: (stats: ViewerDebugStats) => void;
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

  /** Raw stick vector from the mobile joystick (x = right, y = forward), or null while untouched. Converted to a camera-relative world direction each frame in update(). */
  private joystickInput: { x: number; y: number } | null = null;
  private readonly joystickForward = new Vector3();
  private readonly joystickRight = new Vector3();
  private readonly joystickDirection = new Vector3();

  private statsFrameCount = 0;
  private statsElapsed = 0;

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

  /** Mobile joystick input: x = right, y = forward, both roughly [-1, 1] (magnitude scales speed). Pass null on release. Resolved to a camera-relative world direction fresh every frame in update(), so it stays correct as the camera orbits. */
  setJoystickInput(input: { x: number; y: number } | null): void {
    this.joystickInput = input;
    if (input) this.sceneController.hideTargetMarker(); // joystick engaging supersedes any pending click-to-move
  }

  update(delta: number): void {
    if (this.joystickInput) {
      const { x, y } = this.joystickInput;
      const camera = this.cameraController.camera;
      camera.getWorldDirection(this.joystickForward);
      this.joystickForward.y = 0;
      if (this.joystickForward.lengthSq() > 1e-8) this.joystickForward.normalize();
      this.joystickRight.crossVectors(this.joystickForward, UP_AXIS).normalize();
      this.joystickDirection.set(0, 0, 0).addScaledVector(this.joystickForward, y).addScaledVector(this.joystickRight, x);
      this.characterController.setMoveDirection(this.joystickDirection);
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
      this.callbacks.onStatsUpdate?.({
        fps: Math.round(this.statsFrameCount / this.statsElapsed),
        heapMB: perfMemory ? Math.round(perfMemory.usedJSHeapSize / BYTES_PER_MB) : null,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
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
    if (event.button !== 0) return;
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  }

  onPointerUp(event: PointerEvent): void {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
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
    this.cameraController.dispose();
    this.characterController.dispose();
    this.botController.dispose();
    this.sceneController.dispose();
  }
}
