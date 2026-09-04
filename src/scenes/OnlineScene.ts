import { Vector3 } from 'three';
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { CameraController } from '../controllers/CameraController';
import { CharacterController, WALK_SPEED_RADIUS_PER_SEC } from '../controllers/CharacterController';
import { RemoteEntityController } from '../controllers/RemoteEntityController';
import { SceneController } from '../controllers/SceneController';
import type { ServerPacket } from '../net/generated/protocol';
import type { ConnectionStatus } from '../net/WorldConnection';
import { WorldConnection } from '../net/WorldConnection';
import { loadCharacter } from '../rf/character';
import type { RaceGender } from '../rf/character';
import type { AppScene } from './AppScene';

export interface OnlineSceneCallbacks {
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
  onPingChange?: (pingMs: number | null) => void;
}

// Server world-units-to-scene-units scale, derived by matching the
// backend's known movement constants (movement/system.go: WalkSpeed = 1
// world-unit/tick; config.go: WORLD_TICK_HZ default 30, so 30 world-units/
// sec) against the local character's own walk speed for the same real
// speed - see RemoteEntityController.setScale's doc comment for the full
// reasoning. Revisit both these constants if the backend's tuning changes.
const SERVER_WALK_UNITS_PER_TICK = 1;
const ASSUMED_SERVER_TICK_HZ = 30;
const SERVER_WALK_UNITS_PER_SEC = SERVER_WALK_UNITS_PER_TICK * ASSUMED_SERVER_TICK_HZ;

/** Default game server WebSocket endpoint; override with VITE_WS_URL for other environments. */
const DEFAULT_WS_URL = 'ws://localhost:8080/ws';

/** World-space (not camera-relative) movement axes - dir_x/dir_z are a fixed compass direction, matching what MovementInput means to the server. */
const MOVE_KEYS: Record<string, [dx: number, dz: number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/**
 * The real (networked) gameplay screen - kept separate from ViewerScene,
 * which is now the offline/debug scene (click-to-move, WASD, the debug
 * panel, %wpedit, GM console bots, ...) and stays that way rather than
 * growing networking on top of an already debug-tooling-heavy class.
 *
 * Mounts the selected character (same CharacterController/CameraController
 * pair ViewerScene uses, minus click-to-move/bots/debug tooling) and drives
 * it locally off WASD, while also reporting the same held direction to the
 * server as a MovementInput. This is client-side prediction, not
 * reconciliation for the local player - it'll visibly diverge from the
 * server once combat/collision is involved. Other players are rendered as
 * plain server-authoritative entities (see RemoteEntityController) with no
 * prediction at all, just smoothing between the positions the server sends.
 */
export class OnlineScene implements AppScene {
  private readonly sceneController = new SceneController();
  private readonly cameraController: CameraController;
  private readonly characterController: CharacterController;
  private readonly remoteEntityController: RemoteEntityController;
  private readonly connection = new WorldConnection();
  private readonly callbacks: OnlineSceneCallbacks;
  private readonly raceGender: RaceGender;

  private readonly heldKeys = new Set<string>();
  private readonly moveDirection = new Vector3();
  private currentDir: [number, number] = [0, 0];
  private myPlayerId: number | null = null;
  private disposed = false;

  private readonly handleKeyDown = (event: KeyboardEvent) => this.handleKeyChange(event, true);
  private readonly handleKeyUp = (event: KeyboardEvent) => this.handleKeyChange(event, false);

  constructor(renderer: WebGLRenderer, raceGender: RaceGender, callbacks: OnlineSceneCallbacks = {}) {
    this.raceGender = raceGender;
    this.callbacks = callbacks;

    this.cameraController = new CameraController(
      renderer.domElement,
      renderer.domElement.clientWidth / renderer.domElement.clientHeight,
      this.sceneController.scene,
    );
    this.characterController = new CharacterController(this.sceneController.scene);
    this.remoteEntityController = new RemoteEntityController(this.sceneController.scene);
  }

  get scene(): Scene {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.cameraController.camera;
  }

  async mount(): Promise<void> {
    this.connection.onStatusChange = (status) => this.callbacks.onConnectionStatusChange?.(status);
    this.connection.onPacket = (payload) => this.handlePacket(payload);
    this.connection.onPingChange = (pingMs) => this.callbacks.onPingChange?.(pingMs);

    const wsUrl = (import.meta.env.VITE_WS_URL as string | undefined) ?? DEFAULT_WS_URL;
    this.connection.connect(wsUrl);

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);

    this.callbacks.onStatusChange?.('loading');
    try {
      const character = await loadCharacter(this.raceGender);
      if (this.disposed) return;
      const bounds = await this.characterController.mount(character, this.raceGender);
      if (this.disposed) return;
      this.sceneController.frameGround(bounds.box, bounds.radius);
      this.cameraController.frameOnCharacter(bounds);
      const localWalkUnitsPerSec = WALK_SPEED_RADIUS_PER_SEC * bounds.radius;
      this.remoteEntityController.setScale(localWalkUnitsPerSec / SERVER_WALK_UNITS_PER_SEC);
      this.callbacks.onStatusChange?.('ready');
    } catch (err) {
      if (this.disposed) return;
      console.error('Failed to load character:', err);
      this.callbacks.onStatusChange?.('error', err instanceof Error ? err.message : String(err));
    }
  }

  update(delta: number): void {
    const [dx, dz] = this.currentDir;
    if (dx !== 0 || dz !== 0) {
      const len = Math.hypot(dx, dz);
      this.moveDirection.set(dx / len, 0, dz / len);
      this.characterController.setMoveDirection(this.moveDirection, this.moveDirection, null);
    } else {
      this.characterController.setMoveDirection(null);
    }

    this.characterController.update(delta);
    this.remoteEntityController.tick(delta);

    const character = this.characterController.getCharacter();
    this.cameraController.update(delta, {
      hipsBone: this.characterController.getHipsBone(),
      headBone: this.characterController.getHeadBone(),
      characterGroupQuaternion: character ? character.group.quaternion : null,
      characterPosition: character ? character.group.position : null,
      isMoving: this.characterController.isMoving(),
    });
  }

  resize(aspect: number): void {
    this.cameraController.setAspect(aspect);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.connection.close();
    this.cameraController.dispose();
    this.characterController.dispose();
    this.remoteEntityController.dispose();
    this.sceneController.dispose();
  }

  private handlePacket(payload: ServerPacket['payload']): void {
    if (!payload) return;
    switch (payload.$case) {
      case 'welcome':
        this.myPlayerId = payload.welcome.playerId;
        break;
      case 'worldSnapshot':
        this.remoteEntityController.applySnapshot(payload.worldSnapshot.entities, this.myPlayerId);
        break;
      case 'worldDelta': {
        const { enters, updates, exits } = payload.worldDelta;
        for (const enter of enters) this.remoteEntityController.enter(enter.entityId, enter.entity, this.myPlayerId);
        for (const update of updates) this.remoteEntityController.update(update.entityId, update, this.myPlayerId);
        for (const exit of exits) this.remoteEntityController.exit(exit.entityId, this.myPlayerId);
        break;
      }
      case 'chat':
      case 'whisper':
      case 'systemMessage':
        console.log('[OnlineScene] packet', payload);
        break;
    }
  }

  private handleKeyChange(event: KeyboardEvent, pressed: boolean): void {
    if (!(event.code in MOVE_KEYS)) return;
    if (pressed) this.heldKeys.add(event.code);
    else this.heldKeys.delete(event.code);

    let dx = 0;
    let dz = 0;
    for (const code of this.heldKeys) {
      const [kx, kz] = MOVE_KEYS[code];
      dx += kx;
      dz += kz;
    }
    dx = Math.sign(dx);
    dz = Math.sign(dz);

    if (this.currentDir[0] === dx && this.currentDir[1] === dz) return;
    this.currentDir = [dx, dz];
    this.connection.sendMovement(dx, dz, false);
  }
}
