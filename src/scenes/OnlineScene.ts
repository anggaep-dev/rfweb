import { Frustum, Matrix4, Sphere, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { CameraController } from '../controllers/CameraController';
import { CharacterController } from '../controllers/CharacterController';
import type { ParticleCullingContext } from '../controllers/CharacterController';
import { applyCharacterAppearance, applyEquipmentDiff, visibleEquipmentToEquipped } from '../controllers/characterAppearance';
import { LocomotionDebugGizmo } from '../controllers/LocomotionDebugGizmo';
import { NameTag, nameTagYOffsetFromBounds } from '../controllers/NameTag';
import { RemoteEntityController } from '../controllers/RemoteEntityController';
import { SceneController } from '../controllers/SceneController';
import { getCharacterProfile } from '../net/CharacterClient';
import { facingToRotation, quantizeDirectionVector, quantizeToCompass, rotationToYaw } from '../net/compassRotation';
import { getMapDetails } from '../net/MapClient';
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
import { classifyLocomotionDirection, loadCharacter } from '../rf/character';
import type { RaceGender } from '../rf/character';
import type { EquippedItems } from '../rf/characterProfile';
import { initSocketGlowBatching } from '../rf/glowEffect';
import { preloadItemIconSheets } from '../rf/itemIcon';
import { GroundHeightProvider } from '../rf/groundHeight';
import { loadMap, nativeToScene } from '../rf/map';
import type { LoadedMap } from '../rf/map';
import { advanceParticleBatchClocks, initParticleBatching, setParticleEffectCountForBudget } from '../rf/particleSystem';
import type { AppScene } from './AppScene';

const UP_AXIS = new Vector3(0, 1, 0);

/** How often the FPS readout refreshes - see update()'s fpsFrameCount/fpsElapsed. Every frame would be an unreadably jittery number and a wasteful callback/re-render rate for a purely cosmetic HUD readout - same interval ViewerScene's own (much larger) stats panel already uses. */
const FPS_UPDATE_INTERVAL_SEC = 0.5;

/**
 * How far (scene units, horizontal only - see reconcileWithServer) the
 * locally-predicted position may drift from the server's own authoritative
 * one before correction kicks in. Local movement never checks collision
 * against the map at all (pure prediction - see this class's own doc
 * comment), while the server DOES reject movement through a real wall (see
 * rfworld's world.go: snapMovedPlayerToTerrainLocked/BlocksMovement) - so
 * walking into a wall is exactly the scenario that grows this drift past the
 * threshold, while ordinary latency-induced prediction noise during
 * unobstructed walking should normally stay under it. Tuned by eye (roughly
 * half a real map sword's own measured length, docs/rf-format-notes.md), not
 * derived from a measured round-trip-time budget.
 */
const POSITION_RECONCILE_THRESHOLD = 40;
/** Exponential smoothing rate (per second) correction pulls the rendered position back at once past the threshold above - same style as RemoteEntityController's own POSITION_SMOOTHING_RATE, chosen high enough that fighting a wall reads as a firm push-back rather than a slow drift. */
const POSITION_RECONCILE_RATE = 10;
/** Local ground height is sampled sparsely instead of raycast every frame; this keeps running smooth without the old CPU spike. */
const LOCAL_GROUND_SAMPLE_INTERVAL = 0.08;
const LOCAL_GROUND_SAMPLE_DISTANCE = 12;
const LOCAL_GROUND_DESCEND_RATE = 24;
const LOCAL_GROUND_UNDER_EPSILON = 2;

export interface OnlineSceneCallbacks {
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
  onPingChange?: (pingMs: number | null) => void;
  /** Fired roughly every FPS_UPDATE_INTERVAL_SEC (not every frame - see update()) with the frame rate averaged over that window. */
  onFpsChange?: (fps: number) => void;
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

const EQUIPMENT_USE_SLOT_INDEX_BY_KEY: Record<EquipmentSlotKey, number> = {
  upper: 100,
  lower: 101,
  gauntlet: 102,
  shoe: 103,
  helmet: 104,
  weapon: 105,
  shield: 106,
  cloak: 107,
  ring1: 108,
  ring2: 109,
  amulet1: 110,
  amulet2: 111,
  bullet1: 112,
  bullet2: 113,
};

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
   * raw server world-unit magnitudes (the radar has its own fixed world-unit
   * range independent of the 3D scene) but with dz negated the same way
   * nativeToScene (rf/map.ts) converts a position for the 3D scene - so a
   * blip's direction agrees with `facingRad` above, which already uses that
   * same render-space "North = -Z" convention (compassRotation.ts). Empty
   * until the first WorldSnapshot/EntityEnter that actually includes the
   * local player's own entity has arrived (see hasServerSelfPosition) -
   * there's nothing to be relative TO before then.
   */
  blips: { dx: number; dz: number }[];
}

// Real server walk/run speeds in raw world-units/sec (movement/system.go:
// WalkSpeed=1, RunSpeed=3 world-units/tick; config.go: WORLD_TICK_HZ default
// 30) - used to give the local player's own CharacterController a walkSpeed
// (setWalkSpeed) and run/walk ratio (setRunSpeedMultiplier) that advance
// character.group.position at the server's own real rate, not
// CharacterController's plain mesh-scale-derived pace (WALK_SPEED_RADIUS_PER_
// SEC/RUN_SPEED_MULTIPLIER, both documented approximations - fine for every
// other CharacterController, which has no server position to stay in sync
// with, but not for this one: undershooting the server's real speed here
// means reconciliation constantly has to yank the character forward to catch
// up, which is exactly what running looked like before setRunSpeedMultiplier
// existed). The scene no longer applies any other scale to server positions
// (see nativeToScene's own doc comment): map geometry, .ebp collision walls,
// and portal/monsterSpawn/soundEntity debug markers (see rf/map.ts) are all
// placed in raw native RF units (just Z-flipped for the scene, same as
// nativeToScene), so self and remote entity positions have to match that
// magnitude too, or they render off from where the map/collision actually
// are. Revisit all of this if the backend's tuning changes.
const SERVER_WALK_UNITS_PER_TICK = 1;
const SERVER_RUN_UNITS_PER_TICK = 3;
const ASSUMED_SERVER_TICK_HZ = 30;
const SERVER_WALK_UNITS_PER_SEC = SERVER_WALK_UNITS_PER_TICK * ASSUMED_SERVER_TICK_HZ;
const SERVER_RUN_TO_WALK_RATIO = SERVER_RUN_UNITS_PER_TICK / SERVER_WALK_UNITS_PER_TICK;

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
 * runs. The server's own MovementInput is 8-way for player input, so the
 * continuous camera-relative direction gets snapped to the nearest compass
 * axis (see compassRotation.ts's quantizeToCompass) before being
 * sent and before local prediction advances the character.
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
  private readonly predictedMoveDirection = new Vector3();
  private readonly predictedFaceDirection = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraRight = new Vector3();
  // Which way the character is actually oriented, world-space. Mirrors
  // ViewerScene's local rule: forward-dominant input faces movement, while
  // strafe/backward keeps facing the camera's horizontal forward vector.
  // Starts facing world -Z so an idle character has a sane default.
  private readonly facing = new Vector3(0, 0, -1);
  /** The last (dx, dz, running) actually sent to the server - compared against every frame in update() so a MovementInput only goes out when something reportable actually changed (a key press/release, a running toggle, or the camera rotating enough to cross into a different compass direction), not on every single frame. */
  private sentDir: [number, number] = [0, 0];
  private sentRunning = false;
  private isRunning = false;
  private myPlayerId: number | null = null;
  /**
   * The server's own authoritative position for the local player, raw server
   * world-units - tracked purely for the radar's relative-position math (see
   * RadarFrame/onRadarFrame below), from the exact same worldSnapshot/enter/
   * update messages RemoteEntityController consumes for every OTHER entity
   * (just not skipped for entityId===myPlayerId here). Ordinary movement
   * never uses this to move or reconcile the local character's own RENDERED
   * position - that stays pure client-side prediction, per this class's own
   * doc comment - except a hard server teleport (see applyServerTeleport),
   * which has no continuous motion to predict in the first place.
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
  /** The currently-loaded world geometry (see rf/map.ts) - null until mount()'s load resolves, or permanently if it failed (see mount()'s own comment on why a map load failure doesn't block entering the world). */
  private loadedMap: LoadedMap | null = null;
  private groundProvider: GroundHeightProvider | null = null;
  /** TEMP debug gizmo (facing/moveDirection arrows + locomotion/clip label) - see LocomotionDebugGizmo's own doc comment. */
  private debugGizmo: LocomotionDebugGizmo | null = null;
  private readonly debugOrigin = new Vector3();
  private disposed = false;
  /** Accumulated since the last onFpsChange callback - see update()'s own FPS_UPDATE_INTERVAL_SEC tick, same windowed-average approach as ViewerScene's stats panel. */
  private fpsFrameCount = 0;
  private fpsElapsed = 0;

  /** Recomputed from the camera every frame - see update(). Same shape ViewerScene feeds its own particle-effect/socket-glow culling. */
  private readonly particleViewProjection = new Matrix4();
  private readonly particleCulling: ParticleCullingContext = { frustum: new Frustum(), cameraPosition: new Vector3() };
  /** Scratch for reconcileWithServer's own scene-space copy of serverSelfPosition - reused every frame rather than allocated. */
  private readonly reconcileTarget = new Vector3();
  private readonly groundProbePosition = new Vector3();
  private readonly lastLocalGroundSamplePosition = new Vector3(Number.NaN, Number.NaN, Number.NaN);
  private localGroundTargetY: number | null = null;
  private localGroundSampleTimer = Number.POSITIVE_INFINITY;

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
    if (this.handleLocalChatCommand(trimmed)) return;
    this.connection.sendChatAll(trimmed);
  }

  private handleLocalChatCommand(message: string): boolean {
    const args = message.split(/\s+/);
    if (args[0]?.toLowerCase() !== '%col') return false;
    if (args.length !== 2 || (args[1] !== '0' && args[1] !== '1')) {
      this.addLocalSystemMessage('Usage: %col 1 to show map debug overlays, %col 0 to hide map debug overlays');
      return true;
    }
    const visible = args[1] === '1';
    this.setMapDebugOverlaysVisible(visible);
    this.addLocalSystemMessage(`Map debug overlays ${visible ? 'shown' : 'hidden'}`);
    return true;
  }

  private addLocalSystemMessage(message: string): void {
    this.callbacks.onChatMessage?.({
      id: this.nextChatEntryId++,
      kind: 'system',
      message,
    });
  }

  private setMapDebugOverlaysVisible(visible: boolean): void {
    if (!this.loadedMap) return;
    this.loadedMap.debugOverlay.visible = visible;
    this.loadedMap.collisionOverlay.visible = visible;
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

  /** See InventoryWindow's paperdoll tooltip Unuse button - 100-113 are fixed equipment slots understood by the backend UseFromSlot path. */
  unuseEquipmentItem(slotKey: EquipmentSlotKey): void {
    this.connection.useSlotItem(EQUIPMENT_USE_SLOT_INDEX_BY_KEY[slotKey]);
  }

  async mount(): Promise<void> {
    this.connection.onStatusChange = (status) => this.callbacks.onConnectionStatusChange?.(status);
    this.connection.onPacket = (payload) => this.handlePacket(payload);
    this.connection.onPingChange = (pingMs) => this.callbacks.onPingChange?.(pingMs);

    this.callbacks.onStatusChange?.('loading');

    // Per docs/map.md's documented "current supported flow" (step 5, before
    // step 6's "open the WebSocket") - only the lightweight JSON metadata is
    // awaited here, not the full map geometry (loadMap(), further down,
    // which runs concurrently with character loading instead - nothing about
    // actually entering the world depends on the map's geometry being ready
    // yet). In the common case this resolves near-instantly:
    // CharacterSelectScreen already kicked off this same (now-cached, see
    // MapClient.ts's own getMapDetails cache) request while the player was
    // still browsing characters, so this just joins that in-flight/settled
    // promise rather than firing a new one. A failed fetch here is logged
    // and otherwise ignored - see getMapDetails' own doc comment on why it's
    // non-fatal.
    await getMapDetails().catch((err: unknown) => {
      console.warn('GET /map failed before connecting to the WebSocket - proceeding anyway:', err);
    });
    if (this.disposed) return;

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

    try {
      const [character, profile, loadedMap] = await Promise.all([
        loadCharacter(this.raceGender),
        // Appearance/equipment is cosmetic - a failed fetch here shouldn't
        // block actually entering the world, just fall back to the
        // race's plain default look (same as a freshly-created character).
        getCharacterProfile(this.sessionToken, this.characterId).catch((err: unknown) => {
          console.error('Failed to load character profile (appearance/equipment will use defaults):', err);
          return null;
        }),
        // Same degrade-gracefully treatment as the profile fetch above - the
        // world's own geometry is nice-to-have for this first pass (nothing
        // else here depends on it: the local player still spawns at the
        // scene origin regardless, per docs/map.md's "frontend should not
        // own deciding spawn coordinates" - aligning the two is future work
        // once the real /characters/{id}/enter flow ships), not a
        // requirement for actually entering/playing the world. Reuses the
        // same cached result CharacterSelectScreen's own prefetch (and the
        // getMapDetails() call just above) already started - see loadMap's
        // own doc comment.
        loadMap().catch((err: unknown) => {
          console.error('Failed to load map geometry (playing without visible world geometry):', err);
          return null;
        }),
      ]);
      if (this.disposed) return;
      // Computed here (map-load time) but only actually applied to the
      // camera AFTER frameOnCharacter() below - frameOnCharacter
      // unconditionally overwrites camera.far to a value derived from the
      // character's own bounding radius, which would otherwise silently
      // clobber this back down to something far too small to see the map
      // at all (confirmed real, not hypothetical: a small character radius
      // makes `radius * 100` land well under the distance a real map needs).
      let mapFarPlaneDistance: number | null = null;
      this.groundProvider = loadedMap?.groundObject3D ? new GroundHeightProvider(loadedMap.groundObject3D, loadedMap.bounds) : null;
      this.remoteEntityController.setMapGeometry(loadedMap?.groundObject3D ?? null, loadedMap?.bounds ?? null);
      if (loadedMap) {
        this.loadedMap = loadedMap;
        this.sceneController.scene.add(loadedMap.object3D);
        loadedMap.debugOverlay.visible = false;
        this.sceneController.scene.add(loadedMap.debugOverlay);
        loadedMap.collisionOverlay.visible = false;
        this.sceneController.scene.add(loadedMap.collisionOverlay);
        if (loadedMap.bounds) {
          // The camera stays near the local player, currently always spawned
          // at the scene origin regardless of where the map's bounds
          // actually sit (see the comment above this Promise.all) - so the
          // worst-case distance the far plane needs to cover is from the
          // origin to the far side of the map's bounding sphere, not just
          // the bounds' own diagonal.
          const sphere = loadedMap.bounds.getBoundingSphere(new Sphere());
          mapFarPlaneDistance = (sphere.center.length() + sphere.radius) * 1.1;
        }
        if (loadedMap.warnings.length > 0) console.warn(`Map "${loadedMap.name}" warnings:`, loadedMap.warnings);
      }
      const bounds = await this.characterController.mount(character, this.raceGender);
      if (this.disposed) return;
      // Overrides mount()'s own mesh-scale-derived walkSpeed/run ratio so
      // local prediction advances character.group.position at the real
      // server rate - see SERVER_WALK_UNITS_PER_SEC's own doc comment and
      // setWalkSpeed/setRunSpeedMultiplier's.
      this.characterController.setWalkSpeed(SERVER_WALK_UNITS_PER_SEC);
      this.characterController.setRunSpeedMultiplier(SERVER_RUN_TO_WALK_RATIO);
      // Lets local prediction stop at a wall immediately instead of only
      // after the server's own (much slower, threshold-gated) correction
      // catches up - see CharacterController.setCollisionWalls's own doc
      // comment. `[]` (not skipping this call) when the map/collision failed
      // to load is deliberate - see that method's own doc comment.
      this.characterController.setCollisionWalls(loadedMap?.collisionWalls ?? []);
      // Places the local player at their persisted last-in-world position
      // (CharacterProfile.lastLocation, raw server world-units - same
      // representation/scale WorldSnapshot's own entity positions use, see
      // RemoteEntityController's own doc comment on `scale`) instead of
      // always the scene origin. Still just an initial placeholder, same as
      // every other entity's spawn position - it's superseded the moment a
      // real WorldSnapshot/EntityEnter for this player arrives (see
      // snapServerSelfPosition), same "spawn somewhere reasonable, don't
      // reconcile afterward" treatment this class's own doc comment already
      // describes for the local player. Skipped (character stays at the
      // origin) if the profile fetch failed above - lastLocation isn't
      // available to place it correctly, and defaulting to (0,0,0) is a
      // safer failure than guessing.
      if (profile) {
        const spawnOffset = nativeToScene(profile.lastLocation);
        character.group.position.add(spawnOffset);
        // The server's own Y has no guarantee of sitting on this map's real
        // surface (see GroundHeightProvider's own doc comment) - re-derive it
        // from the map geometry that's already loaded, folding the
        // correction into spawnOffset itself so the bounds.translate below
        // stays consistent with where the character actually ends up.
        const beforeGroundY = character.group.position.y;
        if (this.snapAbsolutePositionToGround(character.group.position, 'spawn')) {
          this.setLocalGroundTarget(character.group.position);
        }
        spawnOffset.y += character.group.position.y - beforeGroundY;
        // bounds (computed by mount() while the group was still at the
        // origin) must move with it, or frameGround/frameOnCharacter below
        // would frame a point in empty space instead of the character's
        // actual new position - translating keeps radius correct (a
        // translation doesn't change a Box3's size).
        bounds.box.translate(spawnOffset);
        bounds.center.add(spawnOffset);
      }
      if (profile) await applyCharacterAppearance(this.characterController, profile, () => this.disposed);
      if (this.disposed) return;
      this.localEquipped = profile?.equipped ?? {};
      // Seeds the local player's own movement speed from whatever equipped
      // items already contributed to it as of the REST profile fetch (see
      // CharacterController.setServerMoveSpeedMultiplier's own doc comment) -
      // kept current afterward by every live use_item equip/unequip via
      // handleInventoryResponse's own identical call.
      this.characterController.setServerMoveSpeedMultiplier(profile?.status?.moveSpeed ?? 1);
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
      if (profile?.name) {
        this.nameTag = new NameTag(this.sceneController.scene, profile.name, bounds.radius, nameTagYOffsetFromBounds(bounds, character.group.position.y), {
          race: profile.race,
          rank: profile.rank,
          specialRank: profile.specialRank,
        });
      }
      this.debugGizmo = new LocomotionDebugGizmo(this.sceneController.scene, bounds.radius);
      this.sceneController.frameGround(bounds.box, bounds.radius);
      this.cameraController.frameOnCharacter(bounds);
      // Must run after frameOnCharacter (see mapFarPlaneDistance's own
      // comment above) - setFarPlane only ever grows the far plane, so this
      // is a no-op if frameOnCharacter's own radius-derived far already
      // covers the map, and the actual fix when it doesn't.
      if (mapFarPlaneDistance !== null) this.cameraController.setFarPlane(mapFarPlaneDistance);
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
      const input = this.moveInput;
      this.updateMoveDirectionFromCamera();
      // Same local rule as ViewerScene: resolve facing/animation from the
      // current camera angle and raw local input, but move along the exact
      // snapped 8-way compass vector the server will simulate. If local
      // prediction uses the continuous camera-relative vector while the
      // server only sees snapped movement, their positions slowly diverge
      // and reconciliation has to keep tugging the player back.
      const locomotionDirection = classifyLocomotionDirection(input.x, input.y);
      const faceDirection = locomotionDirection ? this.cameraForward : this.moveDirection;
      const hasMoveDirection = quantizeDirectionVector(this.moveDirection, this.predictedMoveDirection);
      const hasFaceDirection = quantizeDirectionVector(faceDirection, this.predictedFaceDirection);
      if (hasMoveDirection && hasFaceDirection) {
        this.facing.copy(this.predictedFaceDirection);
        this.characterController.setWorldYaw(rotationToYaw(facingToRotation(this.predictedFaceDirection)));
        this.characterController.setMoveDirection(this.predictedMoveDirection, this.predictedFaceDirection, locomotionDirection);
        // moveDirection is render-space (camera-relative); the server's
        // dir_z increments a native Z (see rfworld's movement/system.go) - see
        // nativeToScene's own doc comment on why that's the negation of this
        // scene's Z, the same as every other native<->scene conversion here.
        this.reportMovementIfChanged(...quantizeToCompass(this.moveDirection.x, -this.moveDirection.z));
      } else {
        this.characterController.setMoveDirection(null);
        this.reportMovementIfChanged(0, 0);
      }
    } else {
      this.characterController.setMoveDirection(null);
      this.reportMovementIfChanged(0, 0);
    }

    this.characterController.update(delta);
    this.reconcileWithServer(delta);
    this.updateLocalGroundHeight(delta);

    const character = this.characterController.getCharacter();
    this.cameraController.update(delta, {
      hipsBone: this.characterController.getHipsBone(),
      headBone: this.characterController.getHeadBone(),
      characterGroupQuaternion: character ? character.group.quaternion : null,
      characterPosition: character ? character.group.position : null,
      isMoving: this.characterController.isMoving(),
      // Keep camera auto-panning off for straight forward/back movement.
      // Horizontal input is the only time the follow camera is allowed to
      // re-center while moving.
      suppressBehindFollow: Math.abs(this.moveInput?.x ?? 0) <= Math.abs(this.moveInput?.y ?? 0),
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
    this.nameTag?.update(this.characterController.group);

    const hips = this.characterController.getHipsBone();
    if (hips) {
      hips.updateWorldMatrix(true, false);
      hips.getWorldPosition(this.debugOrigin);
    }
    this.debugGizmo?.update(
      this.debugOrigin,
      this.facing,
      this.moveInput ? this.moveDirection : null,
      this.moveInput ? classifyLocomotionDirection(this.moveInput.x, this.moveInput.y) : null,
      this.characterController.getCurrentClipKey(),
    );

    if (this.callbacks.onRadarFrame) {
      const blips = this.hasServerSelfPosition
        ? this.remoteEntityController.getEntityPositions().map((position) => ({
            dx: position.x - this.serverSelfPosition.x,
            dz: -(position.z - this.serverSelfPosition.z),
          }))
        : [];
      this.callbacks.onRadarFrame({ facingRad: Math.atan2(this.facing.x, -this.facing.z), blips });
    }

    this.fpsFrameCount += 1;
    this.fpsElapsed += delta;
    if (this.fpsElapsed >= FPS_UPDATE_INTERVAL_SEC) {
      this.callbacks.onFpsChange?.(Math.round(this.fpsFrameCount / this.fpsElapsed));
      this.fpsFrameCount = 0;
      this.fpsElapsed = 0;
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
    if (this.loadedMap) {
      // Detach only - never dispose. loadMap()'s result is a shared,
      // module-level-cached resource now (see its own doc comment on why:
      // CharacterSelectScreen's predownload and every later OnlineScene
      // mount reuse the exact same Group/geometries/textures rather than
      // re-fetching/re-parsing the ~70MB Elan asset trio each time), so
      // disposing its GPU resources here would break every other current or
      // future consumer of that same cache entry, not just this scene's own
      // copy.
      this.sceneController.scene.remove(this.loadedMap.object3D);
      this.sceneController.scene.remove(this.loadedMap.debugOverlay);
      this.sceneController.scene.remove(this.loadedMap.collisionOverlay);
      this.loadedMap = null;
      this.groundProvider = null;
    }
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
          // Do not reposition the mounted local character from ordinary
          // snapshots: `%botadd` sends a fresh WorldSnapshot for visibility,
          // and treating that as a teleport can pull the renderer back to
          // the backend's non-native terrain Y. Real teleports are handled
          // by the self exit+enter WorldDelta branch below.
        }
        this.remoteEntityController.applySnapshot(payload.worldSnapshot.entities, this.myPlayerId);
        break;
      }
      case 'worldDelta': {
        const { enters, updates, exits, appearanceUpdates } = payload.worldDelta;
        for (const enter of enters) {
          if (enter.entityId === this.myPlayerId) {
            if (!enter.entity) {
              console.debug('[teleport] self EntityEnter arrived with no entity payload - cannot snap position', enter);
            } else {
              this.snapServerSelfPosition(enter.entity);
              this.applyLocalVisibleEquipment(enter.entity.visibleEquipment);
              // A self enter only ever shows up in a WorldDelta (as opposed
              // to the initial WorldSnapshot at connect time) via a hard
              // teleport - a GM's `%goto` sends exactly this "self exit+enter
              // delta with the new absolute snapshot" (see gm_commands.go).
              // Unlike ordinary movement (deliberately pure client-side
              // prediction - see this class's own doc comment), a teleport
              // has no continuous motion to predict, so the rendered
              // position must actually snap to the server's own new
              // coordinates here.
              this.applyServerTeleport(enter.entity);
            }
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
        const { slots, currencyDelta, equipment, status } = response.result.actionResult;
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
        // Only populated for a use_item that actually (un)equipped a
        // fixed-slot item (see protocol.ts's own doc comment on
        // InventoryActionResult) - keeps movement speed current the moment
        // gear changes mid-session, same value mount()'s own REST profile
        // fetch seeds it from initially (see
        // CharacterController.setServerMoveSpeedMultiplier's doc comment).
        if (status) this.characterController.setServerMoveSpeedMultiplier(status.moveSpeed);
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
   * Pulls the locally-predicted position back toward the server's own
   * authoritative one once they've drifted past POSITION_RECONCILE_THRESHOLD
   * - see that constant's own doc comment for why this exists. Local
   * movement now checks the same collision walls the server does (see
   * CharacterController.setCollisionWalls), so this should rarely have
   * disagrees (packet loss, a dropped input, the map/collision failing to
   * load client-side while the server's own copy is fine). Vertical render
   * placement deliberately stays client-side until the backend has native
   * map height, because the current server Y can be below the visible
   * terrain.
   *
   * Runs every frame regardless of whether the player is currently
   * providing move input - a correction started while holding a key into a
   * wall needs to keep resolving after they let go too, or the character
   * would sit wherever prediction left it (potentially still inside the
   * wall) until the next movement key press nudges it again.
   */
  private reconcileWithServer(delta: number): void {
    if (!this.hasServerSelfPosition) return;
    const character = this.characterController.getCharacter();
    if (!character) return;

    this.reconcileTarget.copy(nativeToScene(this.serverSelfPosition));

    const dx = character.group.position.x - this.reconcileTarget.x;
    const dz = character.group.position.z - this.reconcileTarget.z;
    if (Math.hypot(dx, dz) <= POSITION_RECONCILE_THRESHOLD) return;

    const t = 1 - Math.exp(-POSITION_RECONCILE_RATE * delta);
    character.group.position.x -= dx * t;
    character.group.position.z -= dz * t;
  }

  private updateLocalGroundHeight(delta: number): void {
    const character = this.characterController.getCharacter();
    if (!character || !this.groundProvider) return;

    const position = character.group.position;
    this.localGroundSampleTimer += delta;
    const sampledBefore = Number.isFinite(this.lastLocalGroundSamplePosition.x);
    const movedSinceSample = sampledBefore
      ? Math.hypot(position.x - this.lastLocalGroundSamplePosition.x, position.z - this.lastLocalGroundSamplePosition.z)
      : Number.POSITIVE_INFINITY;
    if (
      this.localGroundTargetY === null ||
      this.localGroundSampleTimer >= LOCAL_GROUND_SAMPLE_INTERVAL ||
      movedSinceSample >= LOCAL_GROUND_SAMPLE_DISTANCE
    ) {
      this.groundProbePosition.copy(position);
      if (this.snapAbsolutePositionToGround(this.groundProbePosition, 'movement')) {
        this.localGroundTargetY = this.groundProbePosition.y;
        this.lastLocalGroundSamplePosition.copy(position);
        this.localGroundSampleTimer = 0;
      }
    }

    if (this.localGroundTargetY === null) return;
    if (position.y < this.localGroundTargetY - LOCAL_GROUND_UNDER_EPSILON) {
      position.y = this.localGroundTargetY;
      return;
    }
    position.y += (this.localGroundTargetY - position.y) * (1 - Math.exp(-LOCAL_GROUND_DESCEND_RATE * delta));
  }

  private setLocalGroundTarget(position: Vector3): void {
    this.localGroundTargetY = position.y;
    this.lastLocalGroundSamplePosition.copy(position);
    this.localGroundSampleTimer = 0;
  }

  /**
   * One-shot absolute placement correction for spawn/teleport. It first
   * tries the near-foot snap used for multi-floor safety, then falls back to
   * a high downward ray when the provided server/GM Y starts below the
   * visible surface, as with `%goto -5234 440 -3603`.
   */
  private snapAbsolutePositionToGround(position: Vector3, mode: 'movement' | 'spawn' | 'teleport'): boolean {
    return this.groundProvider?.applyToPosition(position, { mode, referenceY: position.y }) ?? false;
  }


  /**
   * Snaps the local player's own rendered position (and the camera rig
   * riding along with it) to a server-authoritative absolute position - see
   * handlePacket's own comments on the two places this gets called from (a
   * self enter in a WorldDelta, or a later/resync WorldSnapshot - both cases
   * a hard teleport, e.g. a GM's `%goto`, can produce). Never called for
   * ordinary movement (per-tick EntityUpdate for the self entity only ever
   * touches serverSelfPosition bookkeeping - see applyServerSelfDelta).
   * `entity.x/y/z` are a raw native RF world position, same representation
   * every other entity position uses - converted to scene space via
   * nativeToScene (rf/map.ts), the same conversion RemoteEntityController
   * uses for everyone else.
   */
  private applyServerTeleport(entity: EntitySnapshot): void {
    const character = this.characterController.getCharacter();
    if (!character) {
      console.debug('[teleport] ignored - character not mounted yet', entity);
      return; // teleport packet arrived before mount() finished - nothing to move yet
    }
    const newPosition = nativeToScene(entity);
    // See GroundHeightProvider's own doc comment - the server's Y for a
    // `%goto` target has no guarantee of sitting on this map's actual
    // surface.
    if (this.snapAbsolutePositionToGround(newPosition, 'teleport')) {
      this.setLocalGroundTarget(newPosition);
    }
    const cameraOffset = newPosition.clone().sub(character.group.position);
    console.debug('[teleport] applying', {
      raw: { x: entity.x, y: entity.y, z: entity.z },
      from: character.group.position.toArray(),
      to: newPosition.toArray(),
    });
    character.group.position.copy(newPosition);
    this.cameraController.teleport(cameraOffset);
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
