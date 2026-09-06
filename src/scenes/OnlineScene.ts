import { Vector3 } from 'three';
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { CameraController } from '../controllers/CameraController';
import { CharacterController, WALK_SPEED_RADIUS_PER_SEC } from '../controllers/CharacterController';
import { applyCharacterAppearance } from '../controllers/characterAppearance';
import { NameTag } from '../controllers/NameTag';
import { RemoteEntityController } from '../controllers/RemoteEntityController';
import { SceneController } from '../controllers/SceneController';
import { getCharacterProfile } from '../net/CharacterClient';
import type { ServerPacket } from '../net/generated/protocol';
import { SERVER_PORT, isSecurePage, pageHostname } from '../net/serverHost';
import type { ConnectionStatus } from '../net/WorldConnection';
import { WorldConnection } from '../net/WorldConnection';
import { facingToRotation } from '../net/compassRotation';
import { classifyLocomotionDirection, loadCharacter } from '../rf/character';
import type { LocomotionDirection, RaceGender } from '../rf/character';
import type { AppScene } from './AppScene';

const UP_AXIS = new Vector3(0, 1, 0);

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

/**
 * Default game server WebSocket endpoint - derived from whatever
 * host/scheme the page itself was loaded from (see serverHost.ts for why
 * "localhost" can't be hardcoded here). Override with VITE_WS_URL when the
 * backend lives on a different host/port than the page (e.g. a real
 * deployment).
 */
function defaultWsUrl(): string {
  return `${isSecurePage() ? 'wss:' : 'ws:'}//${pageHostname()}:${SERVER_PORT}/ws`;
}

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
 *
 * `sessionToken` (from LoginScreen's real login() call - see
 * net/AuthClient.ts) and `characterId` (which of the account's characters,
 * from CharacterSelectScreen - see net/CharacterClient.ts) are both appended
 * to the WS connect URL as `?token=...&character=...`, so the server can
 * authenticate the connection and know which character to load without a
 * separate WS/proto handshake for either. Note the browser's WebSocket API
 * never exposes *why* a connection failed (e.g. an invalid/expired token vs.
 * the server being unreachable both just look like "it closed") - see
 * ConnectionStatus.
 */
export class OnlineScene implements AppScene {
  private readonly sceneController = new SceneController();
  private readonly cameraController: CameraController;
  private readonly characterController: CharacterController;
  private readonly remoteEntityController: RemoteEntityController;
  private readonly connection = new WorldConnection();
  private readonly callbacks: OnlineSceneCallbacks;
  private readonly raceGender: RaceGender;
  private readonly sessionToken: string;
  private readonly characterId: string;

  private readonly heldKeys = new Set<string>();
  private readonly moveDirection = new Vector3();
  private readonly moveRight = new Vector3();
  // Which way the character is actually oriented, world-space - independent
  // of the fixed-compass moveDirection so backward/strafe input (see
  // update()) doesn't spin the character to face it, only genuinely
  // "forward" input does. Starts facing MOVE_KEYS' own "north" (KeyW's
  // [0,-1]) so a character that hasn't moved yet still has a sane default.
  private readonly facing = new Vector3(0, 0, -1);
  private currentDir: [number, number] = [0, 0];
  private isRunning = false;
  private myPlayerId: number | null = null;
  private nameTag: NameTag | null = null;
  private disposed = false;

  private readonly handleKeyDown = (event: KeyboardEvent) => this.handleKeyChange(event, true);
  private readonly handleKeyUp = (event: KeyboardEvent) => this.handleKeyChange(event, false);

  constructor(
    renderer: WebGLRenderer,
    raceGender: RaceGender,
    sessionToken: string,
    characterId: string,
    callbacks: OnlineSceneCallbacks = {},
  ) {
    this.raceGender = raceGender;
    this.sessionToken = sessionToken;
    this.characterId = characterId;
    this.callbacks = callbacks;

    this.cameraController = new CameraController(
      renderer.domElement,
      renderer.domElement.clientWidth / renderer.domElement.clientHeight,
      this.sceneController.scene,
    );
    this.characterController = new CharacterController(this.sceneController.scene);
    this.remoteEntityController = new RemoteEntityController(this.sceneController.scene, sessionToken);
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

    const wsUrl = (import.meta.env.VITE_WS_URL as string | undefined) ?? defaultWsUrl();
    const separator = wsUrl.includes('?') ? '&' : '?';
    this.connection.connect(
      `${wsUrl}${separator}token=${encodeURIComponent(this.sessionToken)}&character=${encodeURIComponent(this.characterId)}`,
    );

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);

    this.callbacks.onStatusChange?.('loading');
    try {
      const [character, profile] = await Promise.all([
        loadCharacter(this.raceGender),
        // Appearance/equipment is cosmetic - a failed fetch here shouldn't
        // block actually entering the world, just fall back to the
        // race's plain default look (same as a freshly-created character).
        getCharacterProfile(this.sessionToken, this.characterId).catch((err: unknown) => {
          console.error('Failed to load character profile (appearance/equipment will use defaults):', err);
          return null;
        }),
      ]);
      if (this.disposed) return;
      const bounds = await this.characterController.mount(character, this.raceGender);
      if (this.disposed) return;
      if (profile) await applyCharacterAppearance(this.characterController, profile, () => this.disposed);
      if (this.disposed) return;
      // Skipped (not faked with a placeholder) if the profile fetch failed above - same cosmetic-only degradation as the appearance/equipment it came bundled with.
      if (profile?.name) this.nameTag = new NameTag(this.sceneController.scene, profile.name, bounds.radius);
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

  /**
   * Recomputes moveDirection from currentDir (the raw fixed-compass WASD
   * input - see MOVE_KEYS) and classifies it against the character's own
   * current facing (not the camera's - MovementInput's dir_x/dir_z are a
   * world compass, not camera-relative) so holding S (or strafing with
   * A/D) plays a real backward/strafe clip instead of spinning the
   * character around to face wherever it's moving, same as ViewerScene's
   * camera-relative equivalent. Updates `facing` in place when the input is
   * genuinely "forward" (locomotionDirection null) and returns the
   * classification either way. Idempotent - safe to call every frame (from
   * update(), to drive the animation) and again right before sending a
   * MovementInput (from handleKeyChange(), so the compass value sent for
   * `facing` reflects this exact direction change immediately rather than
   * whatever the last render frame happened to compute).
   */
  private updateFacing(): LocomotionDirection | null {
    const [dx, dz] = this.currentDir;
    const len = Math.hypot(dx, dz);
    this.moveDirection.set(dx / len, 0, dz / len);

    this.moveRight.crossVectors(this.facing, UP_AXIS).normalize();
    const localX = this.moveDirection.dot(this.moveRight);
    const localY = this.moveDirection.dot(this.facing);
    const locomotionDirection = classifyLocomotionDirection(localX, localY);

    if (!locomotionDirection) this.facing.copy(this.moveDirection);
    return locomotionDirection;
  }

  update(delta: number): void {
    this.characterController.setMoveMode(this.isRunning ? 'run' : 'walk');

    const [dx, dz] = this.currentDir;
    if (dx !== 0 || dz !== 0) {
      const locomotionDirection = this.updateFacing();
      const faceDirection = locomotionDirection ? this.facing : this.moveDirection;
      this.characterController.setMoveDirection(this.moveDirection, faceDirection, locomotionDirection);
    } else {
      this.characterController.setMoveDirection(null);
    }

    this.characterController.update(delta);
    this.remoteEntityController.tick(delta);
    this.nameTag?.update(this.characterController.getHeadBone());

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
    this.nameTag?.dispose(this.sceneController.scene);
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
    const isRunKey = event.code === 'ShiftLeft' || event.code === 'ShiftRight';
    if (!isRunKey && !(event.code in MOVE_KEYS)) return;

    const wasRunning = this.isRunning;
    if (isRunKey) this.isRunning = pressed;
    else if (pressed) this.heldKeys.add(event.code);
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

    // Resend on a running-state flip even with the same direction (or no
    // direction at all) held - the server needs to know regardless of
    // whether dx/dz also changed this same event.
    if (this.currentDir[0] === dx && this.currentDir[1] === dz && this.isRunning === wasRunning) return;
    this.currentDir = [dx, dz];
    // Only recompute facing while actually moving - updateFacing() divides
    // by the (zero) input length otherwise, and an idle character should
    // just keep reporting whichever way it was already facing.
    if (dx !== 0 || dz !== 0) this.updateFacing();
    this.connection.sendMovement(dx, dz, this.isRunning, facingToRotation(this.facing));
  }
}
