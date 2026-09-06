import { Vector3 } from 'three';
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { CameraController } from '../controllers/CameraController';
import { CharacterController, WALK_SPEED_RADIUS_PER_SEC } from '../controllers/CharacterController';
import { applyCharacterAppearance } from '../controllers/characterAppearance';
import { LocomotionDebugGizmo } from '../controllers/LocomotionDebugGizmo';
import { NameTag } from '../controllers/NameTag';
import { RemoteEntityController } from '../controllers/RemoteEntityController';
import { SceneController } from '../controllers/SceneController';
import { getCharacterProfile } from '../net/CharacterClient';
import { facingToRotation, quantizeDirectionVector, quantizeToCompass } from '../net/compassRotation';
import type { ServerPacket } from '../net/generated/protocol';
import { SERVER_PORT, isSecurePage, pageHostname } from '../net/serverHost';
import type { ConnectionStatus } from '../net/WorldConnection';
import { WorldConnection } from '../net/WorldConnection';
import { classifyLocomotionDirectionStable, classifyMovementAgainstFacing, loadCharacter } from '../rf/character';
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

/**
 * The real (networked) gameplay screen - kept separate from ViewerScene,
 * which is now the offline/debug scene (click-to-move, WASD, the debug
 * panel, %wpedit, GM console bots, ...) and stays that way rather than
 * growing networking on top of an already debug-tooling-heavy class.
 *
 * Mounts the selected character (same CharacterController/CameraController
 * pair ViewerScene uses, minus click-to-move/bots/debug tooling) and drives
 * it locally off WASD (fed in via setMoveInput() - see OnlineScreen's
 * useKeyboardMove), while also reporting movement to the server. This is
 * client-side prediction, not reconciliation for the local player - it'll
 * visibly diverge from the server once combat/collision is involved. Other
 * players are rendered as plain server-authoritative entities (see
 * RemoteEntityController) with no prediction at all, just smoothing between
 * the positions the server sends.
 *
 * Movement is camera-relative (setMoveInput's x=right/y=forward is relative
 * to wherever the camera is currently looking, recomputed every frame - see
 * update()), same as ViewerScene's debug controls and every other
 * third-person control scheme: right-click-dragging the camera changes
 * which way "forward" points, matching the direction the character actually
 * runs. The server's own MovementInput only understands a fixed 8-way
 * compass though (movement/system.go's directionToRotation), so the
 * continuous camera-relative direction gets quantized (see
 * compassRotation.ts's quantizeToCompass) before being sent - purely for
 * the network report; the character's own local rendering still moves
 * smoothly along the exact continuous direction.
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

  /** Raw (x=right, y=forward) intent, camera-relative - see setMoveInput(). Set from outside (OnlineScreen's useKeyboardMove), null while no movement key is held. */
  private moveInput: { x: number; y: number } | null = null;
  private readonly moveDirection = new Vector3();
  private readonly moveRight = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraRight = new Vector3();
  // Which way the character is actually oriented, world-space - independent
  // of moveDirection so backward/strafe input (see update()) doesn't spin
  // the character to face it, only genuinely "forward" input does. Starts
  // facing world -Z so a character that hasn't moved yet still has a sane
  // default.
  private readonly facing = new Vector3(0, 0, -1);
  /** Threaded into classifyLocomotionDirectionStable so it can resist boundary flicker - see that function's own doc comment. */
  private lastLocomotionDirection: LocomotionDirection | null = null;
  /** Separate hysteresis state for classifying the raw LOCAL input (moveInput.x/y) instead of the world-space moveDirection-vs-facing relationship - see classifyAgainstFacing's doc comment on why facing must only ever reorient off of this, not the world-space classification. */
  private lastInputLocomotionDirection: LocomotionDirection | null = null;
  /** Scratch compass-snapped copies of facing/moveDirection, reused every classifyAgainstFacing() call - see its own doc comment for why classification runs on these instead of the raw continuous vectors. */
  private readonly quantizedFacing = new Vector3();
  private readonly quantizedMoveDirection = new Vector3();
  /** The last (dx, dz, running) actually sent to the server - compared against every frame in update() so a MovementInput only goes out when something reportable actually changed (a key press/release, a running toggle, or the camera rotating enough to cross into a different compass octant), not on every single frame. */
  private sentDir: [number, number] = [0, 0];
  private sentRunning = false;
  private isRunning = false;
  private myPlayerId: number | null = null;
  private nameTag: NameTag | null = null;
  /** TEMP debug gizmo (facing/moveDirection arrows + locomotion/clip label) - see LocomotionDebugGizmo's own doc comment. */
  private debugGizmo: LocomotionDebugGizmo | null = null;
  private readonly debugOrigin = new Vector3();
  private disposed = false;

  private readonly handleRunKeyDown = (event: KeyboardEvent) => this.handleRunKeyChange(event, true);
  private readonly handleRunKeyUp = (event: KeyboardEvent) => this.handleRunKeyChange(event, false);
  // A held Shift never seeing its keyup if focus/visibility is lost mid-press
  // (alt-tab, a browser dialog, DevTools stealing focus, ...) would otherwise
  // leave the character stuck "running" forever - same edge case
  // useKeyboardMove already guards movement itself against.
  private readonly handleBlur = () => {
    this.isRunning = false;
  };

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
    // OrbitControls' damping gives the camera momentum/inertia that coasts
    // for a bit after a fast right-drag release - harmless in ViewerScene
    // (facing there is driven by the click-to-move target, not the camera),
    // but here `facing` has zero damping of its own and instantly tracks
    // wherever the camera currently points while moving forward (see
    // updateFacing()), so that coast-down was directly visible as the
    // character's reported facing drifting for a moment after releasing a
    // drag - confirmed via direct testing (right-drag then hold W: facing
    // kept changing for many frames after the drag ended, eventually
    // crossing a locomotion-classification boundary and producing a
    // visible wrong-direction flicker on remote observers).
    this.cameraController.controls.enableDamping = false;
    this.characterController = new CharacterController(this.sceneController.scene);
    this.remoteEntityController = new RemoteEntityController(this.sceneController.scene, sessionToken);
  }

  get scene(): Scene {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.cameraController.camera;
  }

  /** Camera-relative move intent (x=right, y=forward), or null when idle - see OnlineScreen's useKeyboardMove, the same channel ViewerScene's WASD/mobile-joystick input uses. */
  setMoveInput(input: { x: number; y: number } | null): void {
    this.moveInput = input;
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

    window.addEventListener('keydown', this.handleRunKeyDown);
    window.addEventListener('keyup', this.handleRunKeyUp);
    window.addEventListener('blur', this.handleBlur);

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
      this.debugGizmo = new LocomotionDebugGizmo(this.sceneController.scene, bounds.radius);
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

  /** Recomputes moveDirection (continuous, world-space) from moveInput and the camera's current orientation - called every frame while moveInput is active, so right-click-orbiting the camera changes which way "forward" actually points, same as ViewerScene's camera-relative equivalent. */
  private updateMoveDirectionFromCamera(): void {
    const camera = this.cameraController.camera;
    camera.getWorldDirection(this.cameraForward);
    this.cameraForward.y = 0;
    if (this.cameraForward.lengthSq() > 1e-8) this.cameraForward.normalize();
    this.cameraRight.crossVectors(this.cameraForward, UP_AXIS).normalize();

    const input = this.moveInput!;
    this.moveDirection.set(0, 0, 0).addScaledVector(this.cameraForward, input.y).addScaledVector(this.cameraRight, input.x);
    if (this.moveDirection.lengthSq() > 1e-8) this.moveDirection.normalize();
  }

  /**
   * Snaps the current continuous moveDirection into `quantizedMoveDirection`
   * - shared by updateFacing() and classifyAgainstFacing(), which MUST both
   * read the exact same quantized value computed in the same frame (see
   * update()'s call order and updateFacing's own doc comment for why).
   */
  private quantizeMoveDirection(): void {
    if (!quantizeDirectionVector(this.moveDirection, this.quantizedMoveDirection)) {
      this.quantizedMoveDirection.copy(this.moveDirection);
    }
  }

  /**
   * Reorients `facing` to this frame's quantized moveDirection - but only
   * when the RAW LOCAL input itself (this.moveInput, camera-independent:
   * x=right/y=forward relative to wherever the camera happens to be
   * pointing) is genuinely "forward," via its own separately-tracked
   * classification. This must NOT be driven by classifyAgainstFacing's
   * world-space result - that one reflects moveDirection's relationship to
   * the *old* facing, which the camera can rotate independently of at any
   * moment (right-drag orbiting doesn't touch facing at all - see
   * CameraController's rightDragging), so it can read "forward" (null) at
   * an arbitrary point mid-strafe/backward purely from camera motion, with
   * no W ever pressed. Facing should only ever turn to face the way you're
   * walking when you're actually holding the forward key/joystick tilt -
   * exactly what this local-input classification (independent of camera
   * orientation entirely) captures.
   *
   * Called BEFORE classifyAgainstFacing() every frame (see update()) -
   * confirmed by direct testing that the reverse order has a real bug: a
   * continuous input that's genuinely forward but near a 22.5° compass-
   * quantization boundary (e.g. joystick tilted mostly-forward-slightly-
   * left, not far enough to be a diagonal) can cross into a new octant on
   * any given frame. If facing only got snapped to the new octant *after*
   * classifyAgainstFacing() already ran against the *old* one, that one
   * frame would compare a stale (pre-snap) facing against the already-
   * moved moveDirection, misclassifying a perfectly steady forward tilt as
   * a momentary 'lf'/'rt' strafe - and thanks to CharacterController's
   * 0.25s crossfade, a single wrong frame like that starts a real blend
   * toward the wrong clip that then immediately reverses, showing up as a
   * visible stutter/pop, not just one dropped frame. Updating facing first
   * means classifyAgainstFacing() always compares against the *current*
   * frame's facing, so a genuinely-forward input can never misclassify
   * here regardless of how many quantization boundaries it crosses.
   */
  private updateFacing(): LocomotionDirection | null {
    const input = this.moveInput!;
    const inputLocomotionDirection = classifyLocomotionDirectionStable(input.x, input.y, this.lastInputLocomotionDirection);
    this.lastInputLocomotionDirection = inputLocomotionDirection;
    if (!inputLocomotionDirection) this.facing.copy(this.quantizedMoveDirection);
    return inputLocomotionDirection;
  }

  /**
   * Classifies the current (already-quantized) moveDirection against the
   * character's own current facing (not the camera's) so holding
   * "backward" (or strafing) plays a real backward/strafe clip instead of
   * spinning the character around to face wherever it's moving, and
   * returns that classification for the caller to pick a clip with.
   *
   * Classifies against the compass-quantized (see quantizeDirectionVector)
   * copy of facing, not its raw continuous value - a remote observer only
   * ever learns this player's facing/movement as one of 8 compass
   * directions (facingToRotation/quantizeToCompass, both used when actually
   * reporting below), so classifying locally against full precision let
   * `facing` silently drift off that grid over time until it no longer
   * lined up with what any observer could ever reconstruct - correct here,
   * but strafes misclassified as forward/backward walk on every other
   * client. Keeping both sides of this comparison on the same 8-direction
   * grid the wire actually carries guarantees the two classifications
   * agree.
   *
   * Does NOT decide whether `facing` itself updates - see updateFacing(),
   * which must run first every frame (see its own doc comment and
   * update()'s call order).
   */
  private classifyAgainstFacing(): LocomotionDirection | null {
    quantizeDirectionVector(this.facing, this.quantizedFacing); // facing is always already grid-aligned - see updateFacing()
    this.lastLocomotionDirection = classifyMovementAgainstFacing(
      this.quantizedMoveDirection,
      this.quantizedFacing,
      this.lastLocomotionDirection,
      this.moveRight,
      UP_AXIS,
    );
    return this.lastLocomotionDirection;
  }

  /** Sends a MovementInput only when something reportable actually changed since the last one - see sentDir/sentRunning's doc comment. */
  private reportMovementIfChanged(dx: number, dz: number): void {
    if (this.sentDir[0] === dx && this.sentDir[1] === dz && this.sentRunning === this.isRunning) return;
    this.sentDir = [dx, dz];
    this.sentRunning = this.isRunning;
    this.connection.sendMovement(dx, dz, this.isRunning, facingToRotation(this.facing));
  }

  update(delta: number): void {
    this.characterController.setMoveMode(this.isRunning ? 'run' : 'walk');

    if (this.moveInput) {
      this.updateMoveDirectionFromCamera();
      this.quantizeMoveDirection();
      // updateFacing() MUST run before classifyAgainstFacing() - see updateFacing's own doc comment.
      const inputLocomotionDirection = this.updateFacing(); // raw local input - the only thing allowed to reorient facing/pick faceDirection, see its own doc comment
      const locomotionDirection = this.classifyAgainstFacing(); // world-space vs facing - drives clip choice only, see its own doc comment
      const faceDirection = inputLocomotionDirection ? this.facing : this.moveDirection;
      this.characterController.setMoveDirection(this.moveDirection, faceDirection, locomotionDirection);
      this.reportMovementIfChanged(...quantizeToCompass(this.moveDirection.x, this.moveDirection.z));
    } else {
      this.characterController.setMoveDirection(null);
      this.reportMovementIfChanged(0, 0);
    }

    this.characterController.update(delta);
    this.remoteEntityController.tick(delta);
    this.nameTag?.update(this.characterController.getHeadBone());

    const hips = this.characterController.getHipsBone();
    if (hips) {
      hips.updateWorldMatrix(true, false);
      hips.getWorldPosition(this.debugOrigin);
    }
    this.debugGizmo?.update(
      this.debugOrigin,
      this.facing,
      this.moveInput ? this.moveDirection : null,
      this.lastLocomotionDirection,
      this.characterController.getCurrentClipKey(),
    );

    const character = this.characterController.getCharacter();
    this.cameraController.update(delta, {
      hipsBone: this.characterController.getHipsBone(),
      headBone: this.characterController.getHeadBone(),
      characterGroupQuaternion: character ? character.group.quaternion : null,
      characterPosition: character ? character.group.position : null,
      isMoving: this.characterController.isMoving(),
      // updateFacing() above already turns the character to track the
      // camera every frame while moving forward - see CameraUpdateContext's
      // own doc comment for why letting the camera ALSO auto-follow the
      // character here creates an unstable feedback loop specific to this
      // camera-relative (no click-to-move) control scheme.
      suppressBehindFollow: true,
    });
  }

  resize(aspect: number): void {
    this.cameraController.setAspect(aspect);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.handleRunKeyDown);
    window.removeEventListener('keyup', this.handleRunKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    // Detach callbacks before closing - the underlying WebSocket's own
    // 'close' event fires asynchronously (after close() returns), so
    // without this a disposed scene's connection could still call back into
    // React state later. That race is real: React StrictMode's dev-mode
    // double-mount creates a throwaway OnlineScene first, and its delayed
    // close event was overwriting the REAL instance's correct 'open' status
    // back to 'closed' (both share the same setConnectionStatus - it's the
    // same component's state) - the "Disconnected from server" overlay was
    // showing even while gameplay data kept flowing perfectly fine.
    this.connection.onStatusChange = null;
    this.connection.onPacket = null;
    this.connection.onPingChange = null;
    this.connection.close();
    this.cameraController.dispose();
    this.characterController.dispose();
    this.remoteEntityController.dispose();
    this.nameTag?.dispose(this.sceneController.scene);
    this.debugGizmo?.dispose();
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

  private handleRunKeyChange(event: KeyboardEvent, pressed: boolean): void {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') return;
    this.isRunning = pressed;
  }
}
