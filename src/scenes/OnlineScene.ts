import { Frustum, Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { CameraController } from '../controllers/CameraController';
import { CharacterController, WALK_SPEED_RADIUS_PER_SEC } from '../controllers/CharacterController';
import type { ParticleCullingContext } from '../controllers/CharacterController';
import { applyCharacterAppearance, applyEquipmentDiff, visibleEquipmentToEquipped } from '../controllers/characterAppearance';
import { LocomotionDebugGizmo } from '../controllers/LocomotionDebugGizmo';
import { NameTag } from '../controllers/NameTag';
import { RemoteEntityController } from '../controllers/RemoteEntityController';
import { SceneController } from '../controllers/SceneController';
import { getCharacterProfile } from '../net/CharacterClient';
import { facingToRotation, quantizeDirectionVector, quantizeToCompass } from '../net/compassRotation';
import type {
  EntitySnapshot,
  EntityUpdate,
  EquipmentSlots,
  InventoryResponse,
  InventorySlot,
  ServerPacket,
  VisibleEquipment,
} from '../net/generated/protocol';
import { SERVER_PORT, isSecurePage, pageHostname } from '../net/serverHost';
import type { ConnectionStatus } from '../net/WorldConnection';
import { WorldConnection } from '../net/WorldConnection';
import { classifyLocomotionDirectionStable, classifyMovementAgainstFacing, loadCharacter } from '../rf/character';
import type { LocomotionDirection, RaceGender } from '../rf/character';
import type { EquippedItems } from '../rf/characterProfile';
import { initSocketGlowBatching } from '../rf/glowEffect';
import { preloadItemIconSheets } from '../rf/itemIcon';
import { advanceParticleBatchClocks, initParticleBatching, setParticleEffectCountForBudget } from '../rf/particleSystem';
import type { AppScene } from './AppScene';

const UP_AXIS = new Vector3(0, 1, 0);

export interface OnlineSceneCallbacks {
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
  onPingChange?: (pingMs: number | null) => void;
  onRadarFrame?: (frame: RadarFrame) => void;
  onChatMessage?: (entry: ChatLogEntry) => void;
  onInventoryChange?: (state: InventoryState) => void;
  onEquipmentChange?: (equipment: EquipmentDisplay) => void;
}

export interface InventoryState {
  /** Always exactly 100 entries, indexed by slot_index - see normalizeInventorySlots. Empty until the server's post-login InventorySnapshot (request_id 0) arrives. */
  slots: InventorySlot[];
  gold: number;
  cp: number;
}

/** EquipmentSlots' own 14 fixed slots (docs/inventory-action.md) - upper/lower/gauntlet/shoe/helmet/weapon/shield/cloak/ring1/ring2/amulet1/amulet2/bullet1/bullet2. */
export type EquipmentSlotKey = keyof EquipmentSlots;

/**
 * What InventoryWindow actually needs per equipped slot - item_code (for
 * name lookup/display) and upgrade, everything else InventorySlot/
 * EquipmentVisual carry is irrelevant here. A slot with no entry means
 * "nothing equipped there, or (for the 6 accessory slots) simply not known
 * yet" - see mergeVisibleEquipment/mergeEquipmentSlots' own doc comments for
 * why those two cases can't be told apart for ring/amulet/bullet slots.
 */
export type EquipmentDisplay = Partial<Record<EquipmentSlotKey, { itemCode: string; upgrade: string }>>;

/** Every EquipmentSlotKey VisibleEquipment (EntitySnapshot/EntityAppearanceUpdate) actually carries - the 6 accessory slots (rings/amulets/bullets) aren't part of that message at all, see EquipmentDisplay's own doc comment. */
const VISIBLE_EQUIPMENT_KEYS: (keyof VisibleEquipment & EquipmentSlotKey)[] = [
  'upper',
  'lower',
  'gauntlet',
  'shoe',
  'helmet',
  'weapon',
  'shield',
  'cloak',
];

/** Merges a VisibleEquipment (always available - EntitySnapshot on connect, EntityAppearanceUpdate on every later gear change) into an EquipmentDisplay, touching only the 8 slots it actually carries so accessory-slot state from a previous mergeEquipmentSlots call survives. */
function mergeVisibleEquipment(equipment: EquipmentDisplay, visibleEquipment: VisibleEquipment | undefined): EquipmentDisplay {
  const next = { ...equipment };
  for (const key of VISIBLE_EQUIPMENT_KEYS) {
    const visual = visibleEquipment?.[key];
    if (visual?.itemCode) next[key] = { itemCode: visual.itemCode, upgrade: visual.upgrade };
    else delete next[key];
  }
  return next;
}

/**
 * Merges an EquipmentSlots (only ever arrives on a use_item InventoryActionResult
 * that equipped something - see docs/inventory-action.md) into an
 * EquipmentDisplay - unlike mergeVisibleEquipment this is the ONLY source
 * this client ever has for the 6 accessory slots (ring1/ring2/amulet1/
 * amulet2/bullet1/bullet2), so those stay unknown (simply absent, rendered
 * as empty) until the player equips one themselves at least once this
 * session.
 */
function mergeEquipmentSlots(equipment: EquipmentDisplay, equipmentSlots: EquipmentSlots): EquipmentDisplay {
  const next = { ...equipment };
  for (const key of Object.keys(equipmentSlots) as EquipmentSlotKey[]) {
    const slot = equipmentSlots[key];
    if (slot?.itemCode) next[key] = { itemCode: slot.itemCode, upgrade: slot.upgrade };
    else delete next[key];
  }
  return next;
}

/** Normalizes an InventorySnapshot/InventoryActionResult's `slots` (which the server documents as "the full normalized 100-slot inventory", but doesn't guarantee array order/completeness) into a fixed 100-length array indexed by slot_index, so InventoryWindow can index it directly instead of re-searching on every render. */
function normalizeInventorySlots(slots: InventorySlot[]): InventorySlot[] {
  const normalized: InventorySlot[] = Array.from({ length: 100 }, (_, slotIndex) => ({
    slotIndex,
    itemId: 0,
    quantity: 0,
    upgrade: '',
    isRental: false,
    rentalExpiredDate: 0,
    isLocked: false,
    itemCode: '',
  }));
  for (const slot of slots) {
    if (slot.slotIndex >= 0 && slot.slotIndex < 100) normalized[slot.slotIndex] = slot;
  }
  return normalized;
}

export interface ChatLogEntry {
  /** Assigned locally (see nextChatEntryId) purely as a React key - the wire protocol carries no message id. */
  id: number;
  kind: 'chat' | 'whisper' | 'system';
  /** Present for 'chat'/'whisper' (ChatEvent/WhisperEvent both carry player_name), absent for 'system' (SystemMessage has no sender). */
  playerName?: string;
  message: string;
}

export interface RadarFrame {
  /** Local player's facing as a radians angle: 0 = world -Z ("north", up on the minimap), increasing clockwise toward +X ("east", right) - same convention as compassRotation.ts's own North=-Z. See MiniMap's own doc comment for how this drives the player marker's rotation. */
  facingRad: number;
  /**
   * Every other tracked entity's position relative to the local player, in
   * raw server world-units (see RemoteEntityController.setScale's own doc
   * comment on what those are) - deliberately NOT converted to scene units,
   * since the radar has its own fixed world-unit range independent of the
   * 3D scene's render scale. Empty until the first WorldSnapshot/EntityEnter
   * that actually includes the local player's own entity has arrived (see
   * hasServerSelfPosition) - there's nothing to be relative TO before then.
   */
  blips: { dx: number; dz: number }[];
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
  /**
   * The server's own authoritative position for the local player, raw server
   * world-units - tracked purely for the radar's relative-position math (see
   * RadarFrame/onRadarFrame below), from the exact same worldSnapshot/enter/
   * update messages RemoteEntityController consumes for every OTHER entity
   * (just not skipped for entityId===myPlayerId here). Never used to move or
   * reconcile the local character's own RENDERED position - that stays pure
   * client-side prediction, per this class's own doc comment; this is a
   * separate, parallel bookkeeping purely so "how far away is that other
   * player" has a meaningful answer.
   */
  private readonly serverSelfPosition = new Vector3();
  private hasServerSelfPosition = false;
  /** Assigns each incoming ChatLogEntry a locally-unique id - see its own doc comment. */
  private nextChatEntryId = 1;
  /**
   * The local player's own equipped items, as last actually applied to
   * characterController - diffed against on every new VisibleEquipment (see
   * applyLocalVisibleEquipment) the same way RemoteEntityController diffs a
   * remote entity's own equipped map. Kept in sync with equipmentDisplay's
   * own 8 VisibleEquipment-backed slots - this one only exists because
   * applyEquipmentDiff/CharacterController work in ModelType terms, not
   * EquipmentSlotKey.
   */
  private localEquipped: EquippedItems = {};
  /** InventoryWindow's own equip-paperdoll state for the local player - see EquipmentDisplay's own doc comment for what each slot means and where it comes from. */
  private equipmentDisplay: EquipmentDisplay = {};
  /**
   * True once characterController.mount() + the initial REST-based
   * applyCharacterAppearance have resolved (see mount()) - guards
   * applyLocalVisibleEquipment against diffing/equipping onto a controller
   * that doesn't have a character mounted yet. The first WorldSnapshot can
   * (and typically does) arrive before that finishes, since it's sent right
   * after WelcomeEvent while the character's own mesh assets are often still
   * loading over the network - see pendingSelfVisibleEquipment.
   */
  private localAppearanceReady = false;
  /** The latest self VisibleEquipment seen before localAppearanceReady (see applyLocalVisibleEquipment) - applied once mount() finishes. Always set together with hasPendingSelfVisibleEquipment, which alone distinguishes "none received yet" from "received, and the player genuinely has nothing equipped". */
  private pendingSelfVisibleEquipment: VisibleEquipment | undefined;
  private hasPendingSelfVisibleEquipment = false;
  /** The 100-slot bag, gold, and CP InventoryWindow renders - see InventoryState's own doc comment. gold/cp seed from the REST CharacterProfile fetch in mount() (there's no protobuf way to ask for current currency on its own) and are then only ever adjusted by a later InventoryActionResult.currencyDelta (sell_item is the only action that produces one right now). */
  private inventoryState: InventoryState = { slots: normalizeInventorySlots([]), gold: 0, cp: 0 };
  private nameTag: NameTag | null = null;
  /** TEMP debug gizmo (facing/moveDirection arrows + locomotion/clip label) - see LocomotionDebugGizmo's own doc comment. */
  private debugGizmo: LocomotionDebugGizmo | null = null;
  private readonly debugOrigin = new Vector3();
  private disposed = false;

  /** Recomputed from the camera every frame - see update(). Same shape ViewerScene feeds its own particle-effect/socket-glow culling. */
  private readonly particleViewProjection = new Matrix4();
  private readonly particleCulling: ParticleCullingContext = { frustum: new Frustum(), cameraPosition: new Vector3() };

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
    renderer: WebGPURenderer,
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

    // Without these, every batch's InstancedMesh is created and kept
    // updated but never actually added to any scene (see
    // initParticleBatching/initSocketGlowBatching's own doc comments) -
    // both only ever got wired up from ViewerScene's constructor, which is
    // the "/debug" offline scene, not this one (the actual default/online
    // route - see SceneApp.tsx's own routing comment), so every equipped
    // weapon/cloak particle effect and socket-glow billboard was silently
    // invisible for real networked play.
    initParticleBatching(this.sceneController.scene);
    initSocketGlowBatching(this.sceneController.scene);
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

  /** Sends a chat-all message - see ChatBox. Empty/whitespace-only is silently dropped rather than sending a blank line to every other client. */
  sendChatMessage(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;
    this.connection.sendChatAll(trimmed);
  }

  /** See InventoryWindow's own Sell button - `quantity = 0` (the default) sells the slot's full stack, per docs/inventory-action.md. */
  sellInventoryItem(slotIndex: number, quantity = 0): void {
    this.connection.sellSlotItem(slotIndex, quantity);
  }

  /** See InventoryWindow's own Drop button - `quantity = 0` (the default) drops the slot's full stack. */
  dropInventoryItem(slotIndex: number, quantity = 0): void {
    this.connection.dropSlotItem(slotIndex, quantity);
  }

  /** See InventoryWindow's own Use/Equip button - `quantity = 0` (the default) uses/equips 1; for an equipment item_code the server equips it instead of consuming it. */
  useInventoryItem(slotIndex: number, quantity = 0): void {
    this.connection.useSlotItem(slotIndex, quantity);
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

    // Fire-and-forget, not on the critical path to 'ready' below - a head
    // start on decoding InventoryWindow's icon sheets so its first real open
    // doesn't stall on that, not a dependency of entering the world.
    preloadItemIconSheets();

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
      this.localEquipped = profile?.equipped ?? {};
      // From here on, the WorldSnapshot/EntityAppearanceUpdate-driven
      // VisibleEquipment path is authoritative for the local player's own
      // rendered gear (see pendingSelfVisibleEquipment/
      // applyLocalVisibleEquipment's own doc comments) - the REST profile's
      // `equipped` above was only ever a best-effort placeholder shown
      // before the first real WorldSnapshot arrives. If one already arrived
      // while this awaited, apply it now as the correction.
      this.localAppearanceReady = true;
      if (this.hasPendingSelfVisibleEquipment) {
        this.hasPendingSelfVisibleEquipment = false;
        this.applyLocalVisibleEquipment(this.pendingSelfVisibleEquipment);
      }
      // gold/cp have no dedicated protobuf "get currency" request (see
      // inventoryState's own doc comment) - seeded from the same REST
      // profile fetch as equipped/name, so also cosmetic-only-degraded (both
      // just read 0) if that fetch failed above.
      this.inventoryState = { ...this.inventoryState, gold: profile?.gold ?? 0, cp: profile?.cp ?? 0 };
      this.callbacks.onInventoryChange?.(this.inventoryState);
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

    // Must run after cameraController.update() above (needs this frame's
    // camera transform, not last frame's) and before anything below that
    // reads it - same ordering ViewerScene's own update() uses.
    const camera = this.cameraController.camera;
    camera.updateMatrixWorld();
    this.particleViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.particleCulling.frustum.setFromProjectionMatrix(this.particleViewProjection);
    camera.getWorldPosition(this.particleCulling.cameraPosition);
    advanceParticleBatchClocks(delta);
    setParticleEffectCountForBudget(this.characterController.getParticleEffectCount() + this.remoteEntityController.getParticleEffectCount());
    this.characterController.updateSocketGlowBillboards(camera, delta);
    this.characterController.updateDebugSocketParticle(camera, delta, this.particleCulling);

    this.remoteEntityController.tick(delta, camera, this.particleCulling);
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

    if (this.callbacks.onRadarFrame) {
      const blips = this.hasServerSelfPosition
        ? this.remoteEntityController.getEntityPositions().map((position) => ({
            dx: position.x - this.serverSelfPosition.x,
            dz: position.z - this.serverSelfPosition.z,
          }))
        : [];
      this.callbacks.onRadarFrame({ facingRad: Math.atan2(this.facing.x, -this.facing.z), blips });
    }
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
      case 'worldSnapshot': {
        const selfSnapshot = payload.worldSnapshot.entities.find((entity) => entity.entityId === this.myPlayerId);
        if (selfSnapshot) {
          this.snapServerSelfPosition(selfSnapshot);
          // The first (and, on every later resync, freshest) place the local
          // player's own VisibleEquipment is available - see
          // applyLocalVisibleEquipment's own doc comment for why this is now
          // authoritative over the REST profile fetch mount() seeds
          // localEquipped/equipmentDisplay from.
          this.applyLocalVisibleEquipment(selfSnapshot.visibleEquipment);
        }
        this.remoteEntityController.applySnapshot(payload.worldSnapshot.entities, this.myPlayerId);
        break;
      }
      case 'worldDelta': {
        const { enters, updates, exits, appearanceUpdates } = payload.worldDelta;
        for (const enter of enters) {
          if (enter.entityId === this.myPlayerId && enter.entity) {
            this.snapServerSelfPosition(enter.entity);
            this.applyLocalVisibleEquipment(enter.entity.visibleEquipment);
          }
          this.remoteEntityController.enter(enter.entityId, enter.entity, this.myPlayerId);
        }
        for (const update of updates) {
          if (update.entityId === this.myPlayerId) this.applyServerSelfDelta(update);
          this.remoteEntityController.update(update.entityId, update, this.myPlayerId);
        }
        for (const exit of exits) this.remoteEntityController.exit(exit.entityId, this.myPlayerId);
        for (const appearanceUpdate of appearanceUpdates) {
          if (appearanceUpdate.entityId === this.myPlayerId) this.applyLocalVisibleEquipment(appearanceUpdate.visibleEquipment);
          else this.remoteEntityController.applyAppearanceUpdate(appearanceUpdate.entityId, appearanceUpdate.visibleEquipment, this.myPlayerId);
        }
        break;
      }
      case 'chat':
        this.callbacks.onChatMessage?.({
          id: this.nextChatEntryId++,
          kind: 'chat',
          playerName: payload.chat.playerName,
          message: payload.chat.message,
        });
        break;
      case 'whisper':
        this.callbacks.onChatMessage?.({
          id: this.nextChatEntryId++,
          kind: 'whisper',
          playerName: payload.whisper.playerName,
          message: payload.whisper.message,
        });
        break;
      case 'systemMessage':
        this.callbacks.onChatMessage?.({ id: this.nextChatEntryId++, kind: 'system', message: payload.systemMessage.message });
        break;
      case 'inventory':
        this.handleInventoryResponse(payload.inventory);
        break;
    }
  }

  private handleInventoryResponse(response: InventoryResponse): void {
    switch (response.result?.$case) {
      case 'snapshot':
        this.inventoryState = { ...this.inventoryState, slots: normalizeInventorySlots(response.result.snapshot.slots) };
        this.callbacks.onInventoryChange?.(this.inventoryState);
        break;
      case 'actionResult': {
        const { slots, currencyDelta, equipment } = response.result.actionResult;
        this.inventoryState = {
          slots: normalizeInventorySlots(slots),
          gold: this.inventoryState.gold + currencyDelta,
          cp: this.inventoryState.cp,
        };
        this.callbacks.onInventoryChange?.(this.inventoryState);
        if (equipment) {
          this.equipmentDisplay = mergeEquipmentSlots(this.equipmentDisplay, equipment);
          this.callbacks.onEquipmentChange?.(this.equipmentDisplay);
        }
        break;
      }
      case 'error':
        // Reuses the chat log's existing 'system' kind - see ChatBox -
        // rather than a dedicated toast component, same as every other
        // server-side rejection this scene surfaces today.
        this.callbacks.onChatMessage?.({
          id: this.nextChatEntryId++,
          kind: 'system',
          message: `Inventory: ${response.result.error.message}`,
        });
        break;
    }
  }

  private snapServerSelfPosition(entity: EntitySnapshot): void {
    this.serverSelfPosition.set(entity.x, entity.y, entity.z);
    this.hasServerSelfPosition = true;
  }

  private applyServerSelfDelta(update: EntityUpdate): void {
    this.serverSelfPosition.x += update.dx;
    this.serverSelfPosition.y += update.dy;
    this.serverSelfPosition.z += update.dz;
  }

  /**
   * Applies the local player's own latest server-reported VisibleEquipment -
   * from the self entity in a WorldSnapshot/EntityEnter (initial/resync) or
   * an EntityAppearanceUpdate targeting myPlayerId (a live gear change) -
   * onto both equipmentDisplay (InventoryWindow's paperdoll, updated
   * unconditionally: it doesn't need a mounted 3D character) and the actual
   * 3D character (via applyEquipmentDiff, deferred - see
   * pendingSelfVisibleEquipment - until localAppearanceReady, since a
   * WorldSnapshot can arrive before characterController.mount() has
   * actually finished loading the character's meshes).
   *
   * This is the real fix for "a character's equipped armor doesn't render
   * on first login": mount()'s own REST CharacterProfile.equipped fetch
   * only reflects that character's saved-appearance document, which isn't
   * the same store real equip actions (use_item) write to any more (see
   * docs/inventory-action.md) - VisibleEquipment is the only channel that's
   * actually current. Before this, VisibleEquipment was only ever consumed
   * here for live updates, never for the local player's own initial
   * appearance, so a character that had equipped something in an earlier
   * session (or via `%**`/a use_item this session while temporarily
   * disconnected) rendered bare/default until the next live gear change
   * happened to correct it.
   */
  private applyLocalVisibleEquipment(visibleEquipment: EntitySnapshot['visibleEquipment']): void {
    this.equipmentDisplay = mergeVisibleEquipment(this.equipmentDisplay, visibleEquipment);
    this.callbacks.onEquipmentChange?.(this.equipmentDisplay);

    if (!this.localAppearanceReady) {
      this.pendingSelfVisibleEquipment = visibleEquipment;
      this.hasPendingSelfVisibleEquipment = true;
      return;
    }
    const next = visibleEquipmentToEquipped(visibleEquipment);
    const previous = this.localEquipped;
    this.localEquipped = next;
    void applyEquipmentDiff(this.characterController, previous, next, () => this.disposed);
  }

  private handleRunKeyChange(event: KeyboardEvent, pressed: boolean): void {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') return;
    this.isRunning = pressed;
  }
}
