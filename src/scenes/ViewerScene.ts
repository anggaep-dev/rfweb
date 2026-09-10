import { AxesHelper, Euler, Frustum, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { AssetController } from '../controllers/AssetController';
import { BotController } from '../controllers/BotController';
import { CameraController } from '../controllers/CameraController';
import { CharacterController } from '../controllers/CharacterController';
import type { EffectSocketInspection, ParticleCullingContext, WeaponDebugInfo } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
import { advanceParticleBatchClocks, getParticleBatchCount, initParticleBatching, setParticleEffectCountForBudget, setParticleRandomnessEnabled } from '../rf/particleSystem';
import { initSocketGlowBatching } from '../rf/glowEffect';
import { classifyLocomotionDirection } from '../rf/character';
import type { RaceGender } from '../rf/character';
import type { AppScene } from './AppScene';

const CLICK_DRAG_TOLERANCE_PX = 12;
const UP_AXIS = new Vector3(0, 1, 0);
/** How often the FPS/memory readout refreshes - every frame would be unreadable and wasteful to re-render for. */
const STATS_UPDATE_INTERVAL_SEC = 0.5;
const BYTES_PER_MB = 1024 * 1024;
/** AxesHelper size (three.js units) for each %efedit socket marker - big enough to actually spot against a weapon mesh at normal camera distance (0.08, then 0.3, both turned out too small to see/click in practice). */
const EFFECT_EDIT_MARKER_SIZE = 0.6;
/** Radius of the visible+clickable sphere at each %efedit socket marker's own origin - an AxesHelper alone is just 3 thin lines, too easy to miss with the mouse; this is both a bigger visual anchor and the actual raycast target onPointerUp checks against (see syncEffectEditMarkers/onPointerUp). */
const EFFECT_EDIT_HIT_SPHERE_RADIUS = 0.12;
/** Shared across every %efedit marker's own hit sphere - a small constant resource, never disposed (same "cheap, permanent, reused" reasoning as this file's other shared three.js constants), not per-marker/per-sync-call state. */
const EFFECT_EDIT_HIT_GEOMETRY = new SphereGeometry(EFFECT_EDIT_HIT_SPHERE_RADIUS, 8, 6);
const EFFECT_EDIT_HIT_MATERIAL = new MeshBasicMaterial({ color: 0xffee00, transparent: true, opacity: 0.6, depthTest: false });

/** Chrome-only, non-standard - not in the DOM lib types. Absent on other engines. */
interface PerformanceMemoryInfo {
  usedJSHeapSize: number;
}

export interface ViewerDebugStats {
  fps: number;
  heapMB: number | null;
  geometries: number;
  textures: number;
  calls: number;
  triangles: number;
  particleEffects: number;
  /** How many distinct ParticleTemplateBatch draw calls those effects actually collapsed into (see particleSystem.ts's getParticleBatchCount) - the direct signal for whether template batching is actually merging same-weapon effects across bots, since total render calls alone are dominated by character meshes and don't isolate this. */
  particleBatches: number;
  particleInstances: number;
  simulatedParticles: number;
  culledParticleEffects: number;
  particleUpdateMs: number;
  /** Average per-frame time (ms, performance.now()-measured) spent in this scene's own update() - JS-side work: bot/character controller updates, animation mixers, culling, etc. - over the last stats window. See AppScene.reportFrameTiming. */
  updateMs: number;
  /** Average per-frame time (ms) spent inside the single renderer.render() call over the last stats window - the CPU cost of issuing this frame's draw calls, the metric relevant to whether a lower-overhead backend (e.g. WebGPU) would actually help. See AppScene.reportFrameTiming. */
  renderMs: number;
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
  /** Every other debug-relevant weapon variable (item fields, glow/grade overlay parameters) - see CharacterController.getWeaponDebugInfo. Snapshotted alongside the transform, not re-read every frame - none of it changes without a re-equip, which already re-triggers syncWeaponEditTarget/emitWeaponEditState. */
  debug: WeaponDebugInfo | null;
}

export interface ViewerSceneCallbacks {
  onClipChange?: (name: string) => void;
  onFrameLabelChange?: (label: string) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
  onStatsUpdate?: (stats: ViewerDebugStats) => void;
  /** Fires whenever the %wpedit gizmo's target/transform changes - null while disabled or unarmed. */
  onWeaponEditChange?: (state: WeaponEditState | null) => void;
  /** Fires whenever %efedit's found sockets change (an equip, or toggling on/off) - the found "effectN" socket names, an empty array if the current weapon has none, or null while disabled. */
  onEffectEditChange?: (socketNames: string[] | null) => void;
  /** Fires when a %efedit socket marker is clicked - the gathered .eff/.spt/.mst/.dds info for that socket plus whatever real particle effect(s) are currently running there (see CharacterController.EffectSocketInspection), or null if gathering it failed outright (unarmed by the time it resolved, etc). Not fired for a plain click-to-move click - see onPointerUp. */
  onEffectSocketInfo?: (inspection: EffectSocketInspection | null) => void;
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
  /** Summed across every frame in the current stats window, then averaged at the tick below - see reportFrameTiming. */
  private statsUpdateMsSum = 0;
  private statsRenderMsSum = 0;
  private readonly particleViewProjection = new Matrix4();
  private readonly particleCulling: ParticleCullingContext = { frustum: new Frustum(), cameraPosition: new Vector3() };

  // %wpedit - see setWeaponEditEnabled/setWeaponEditMode. transformControls
  // (three's own move/rotate gizmo, the same interaction model Blender's
  // G/R handles use) is created once and reused across attach/detach - only
  // its .enabled/visibility and attached object change, not the instance.
  private readonly transformControls: TransformControls;
  private weaponEditEnabled = false;
  private weaponEditMode: 'translate' | 'rotate' = 'translate';
  private weaponEditTarget: Object3D | null = null;
  private weaponEditOriginal: { position: Vector3; quaternion: Quaternion } | null = null;

  // %efedit - see setEffectEditEnabled. Plain AxesHelper + a small visible
  // sphere per marker (no TransformControls - there can be several
  // sockets at once, unlike the one weapon transform %wpedit edits),
  // parented directly to each socket so they inherit its transform for
  // free. The sphere is both a bigger visual anchor (AxesHelper alone is
  // 3 thin lines, easy to miss) and the actual raycast target
  // onPointerUp checks against - clicking one reports that socket's real
  // .eff/.spt/.mst/.dds data (see getSocketDebugInfo).
  private effectEditEnabled = false;
  private effectEditMarkers: { helper: AxesHelper; hitSphere: Mesh; socket: Object3D }[] = [];
  private effectEditSockets: Object3D[] = [];

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

    // Every ParticleEffect (player + every bot) renders through a shared
    // per-template batch keyed off this scene's own root - see
    // particleSystem.ts's ParticleTemplateBatch for why that cuts draw
    // calls at high bot counts. Must be wired before any character equips
    // a weapon/cloak and starts loading particles.
    initParticleBatching(this.sceneController.scene);
    // Same reasoning as initParticleBatching above, for socket-glow
    // billboards - see glowEffect.ts's SocketGlowBatch.
    initSocketGlowBatching(this.sceneController.scene);
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
        // Optional: "%addbot <count> <weaponNameFilter> <upgradeLevel>" -
        // e.g. "%addbot 3 crimson 7" forces each bot's weapon slot to a
        // random race-eligible item whose name contains "crimson"
        // (case-insensitive substring, not required to be a full/exact
        // name - see BotController.spawnBots), simulated at +7 upgrade
        // (see CharacterController.setDebugWeaponUpgradeLevel) - built for
        // stress-testing real weapons with heavy multi-section .eff
        // particle data (a high upgrade level's own PatternList.txt column
        // often resolves a `.eff` with several more particle-bearing
        // sections than +0 does - see docs/rf-format-notes.md) without
        // hand-equipping one weapon at a time via the Equip panel.
        const weaponNameFilter = args[1];
        const weaponUpgradeLevel = args[2] !== undefined ? Number.parseInt(args[2], 10) : undefined;
        const added = await this.botController.spawnBots(requested, {
          weaponNameFilter,
          weaponUpgradeLevel: Number.isFinite(weaponUpgradeLevel) ? weaponUpgradeLevel : undefined,
        });
        return `Spawned ${added} bot${added === 1 ? '' : 's'} (${this.botController.count} total)${weaponNameFilter ? ` - weapon filter "${weaponNameFilter}"${weaponUpgradeLevel !== undefined ? ` at +${weaponUpgradeLevel}` : ''}` : ''}.`;
      }
      case 'clearbots': {
        const removed = this.botController.clearBots();
        return `Removed ${removed} bot${removed === 1 ? '' : 's'}.`;
      }
      default:
        return `Unknown command "%${name}". Try %addbot <count> [weaponNameFilter] [upgradeLevel] or %clearbots.`;
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
      debug: this.characterController.getWeaponDebugInfo(),
    });
  }

  /**
   * %efedit 1/0 - a first step toward a real .eff placement editor: makes
   * the currently-equipped weapon's own "effectN" dummy sockets (see
   * CharacterController.getEquippedWeaponEffectSockets) visible via a small
   * AxesHelper on each one, since a bare Object3D pivot otherwise renders
   * nothing at all. These are already correctly positioned/parented by
   * buildObjectsFromParsedMesh (same rigid-attach math as the weapon mesh
   * itself) - nothing to compute here, purely visualization for now.
   */
  setEffectEditEnabled(enabled: boolean): void {
    this.effectEditEnabled = enabled;
    if (!enabled) {
      this.clearEffectEditMarkers();
      this.callbacks.onEffectEditChange?.(null);
      return;
    }
    this.syncEffectEditMarkers();
  }

  private clearEffectEditMarkers(): void {
    for (const { helper, hitSphere } of this.effectEditMarkers) {
      helper.parent?.remove(helper);
      helper.dispose();
      // hitSphere shares EFFECT_EDIT_HIT_GEOMETRY/_MATERIAL with every
      // other marker - only remove it from the scene graph, never dispose
      // those (see their own doc comment).
      hitSphere.parent?.remove(hitSphere);
    }
    this.effectEditMarkers = [];
    this.effectEditSockets = [];
  }

  /**
   * Re-attaches markers to whatever CharacterController.
   * getEquippedWeaponEffectSockets()/getEquippedWeaponParticleSockets()
   * currently return combined (both are real, coexisting attachment
   * conventions - see the latter's own doc comment), if that set has
   * changed since the last sync - called once from
   * setEffectEditEnabled(true) and every frame from update() while
   * editing is on, same reasoning as syncWeaponEditTarget (re-equipping a
   * *different* weapon disposes the old socket objects out from under any
   * markers still parented to them).
   */
  private syncEffectEditMarkers(): void {
    const sockets = [
      ...this.characterController.getEquippedWeaponEffectSockets(),
      ...this.characterController.getEquippedWeaponParticleSockets(),
    ];
    const unchanged =
      sockets.length === this.effectEditSockets.length && sockets.every((socket, i) => socket === this.effectEditSockets[i]);
    if (unchanged) return;

    this.clearEffectEditMarkers();
    this.effectEditSockets = sockets;
    for (const socket of sockets) {
      const helper = new AxesHelper(EFFECT_EDIT_MARKER_SIZE);
      socket.add(helper);
      const hitSphere = new Mesh(EFFECT_EDIT_HIT_GEOMETRY, EFFECT_EDIT_HIT_MATERIAL);
      socket.add(hitSphere);
      this.effectEditMarkers.push({ helper, hitSphere, socket });
    }
    this.callbacks.onEffectEditChange?.(sockets.map((socket) => socket.name));
  }

  update(delta: number): void {
    if (this.weaponEditEnabled) this.syncWeaponEditTarget();
    if (this.effectEditEnabled) this.syncEffectEditMarkers();

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
    const character = this.characterController.getCharacter();
    this.cameraController.update(delta, {
      hipsBone: this.characterController.getHipsBone(),
      headBone: this.characterController.getHeadBone(),
      characterGroupQuaternion: character ? character.group.quaternion : null,
      characterPosition: character ? character.group.position : null,
      isMoving: this.characterController.isMoving(),
    });
    this.cameraController.camera.updateMatrixWorld();
    this.particleViewProjection.multiplyMatrices(this.cameraController.camera.projectionMatrix, this.cameraController.camera.matrixWorldInverse);
    this.particleCulling.frustum.setFromProjectionMatrix(this.particleViewProjection);
    this.cameraController.camera.getWorldPosition(this.particleCulling.cameraPosition);
    // Once per frame, not once per effect - see advanceParticleBatchClocks's
    // own doc comment on why a per-effect call here would over-advance a
    // batch shared by many sockets.
    advanceParticleBatchClocks(delta);
    setParticleEffectCountForBudget(
      this.characterController.getParticleEffectCount() + this.botController.getParticleEffectCount(),
    );
    this.characterController.updateSocketGlowBillboards(this.cameraController.camera, delta);
    this.characterController.updateDebugSocketParticle(this.cameraController.camera, delta, this.particleCulling);
    this.botController.update(delta, this.cameraController.camera, this.particleCulling);

    this.statsFrameCount += 1;
    this.statsElapsed += delta;
    if (this.statsElapsed >= STATS_UPDATE_INTERVAL_SEC) {
      const perfMemory = (performance as Performance & { memory?: PerformanceMemoryInfo }).memory;
      const weapon = this.characterController.getCurrentWeapon();
      const particleStats = this.characterController.getParticlePerformanceStats();
      const botParticleStats = this.botController.getParticlePerformanceStats();
      this.callbacks.onStatsUpdate?.({
        fps: Math.round(this.statsFrameCount / this.statsElapsed),
        heapMB: perfMemory ? Math.round(perfMemory.usedJSHeapSize / BYTES_PER_MB) : null,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        particleEffects: particleStats.effects + botParticleStats.effects,
        particleBatches: getParticleBatchCount(),
        particleInstances: particleStats.totalInstances + botParticleStats.totalInstances,
        simulatedParticles: particleStats.simulatedInstances + botParticleStats.simulatedInstances,
        culledParticleEffects: particleStats.culledEffects + botParticleStats.culledEffects,
        particleUpdateMs: particleStats.updateMs + botParticleStats.updateMs,
        updateMs: this.statsUpdateMsSum / this.statsFrameCount,
        renderMs: this.statsRenderMsSum / this.statsFrameCount,
        clipKey: this.characterController.getCurrentClipKey(),
        weapon: weapon ? { id: weapon.item.id, name: weapon.item.name, token: weapon.token, stem: weapon.stem } : null,
      });
      this.statsFrameCount = 0;
      this.statsElapsed = 0;
      this.statsUpdateMsSum = 0;
      this.statsRenderMsSum = 0;
    }
  }

  /** See AppScene.reportFrameTiming - fed into the next stats tick's updateMs/renderMs averages above. */
  reportFrameTiming(updateMs: number, renderMs: number): void {
    this.statsUpdateMsSum += updateMs;
    this.statsRenderMsSum += renderMs;
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

  /**
   * %efedit's own click handler: raycasts against every current socket
   * marker's hit sphere (see EFFECT_EDIT_HIT_GEOMETRY's own doc comment)
   * and, on a hit, fires off getSocketDebugInfo for it - fire-and-forget,
   * same reasoning as every other async-then-callback pattern in this
   * file (weaponEditTarget etc), since the click itself is synchronous
   * but resolving real .eff/.spt/.mst/.dds data isn't. `raycaster` must
   * already be set up (setFromCamera) by the caller. Returns whether a
   * marker was actually hit, so onPointerUp can skip its own
   * click-to-move handling for the same click.
   */
  private handleEffectEditClick(): boolean {
    const hit = this.raycaster.intersectObjects(
      this.effectEditMarkers.map((marker) => marker.hitSphere),
      false,
    )[0];
    if (!hit) return false;

    const marker = this.effectEditMarkers.find((m) => m.hitSphere === hit.object);
    if (!marker) return false;

    const socket = marker.socket;
    this.characterController.getSocketDebugInfo(socket).then(
      (info) => {
        if (this.disposed) return;
        this.callbacks.onEffectSocketInfo?.(
          info ? { info, liveEffects: this.characterController.getSocketParticleEffects(socket) } : null,
        );
      },
      () => {
        if (!this.disposed) this.callbacks.onEffectSocketInfo?.(null);
      },
    );
    return true;
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

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.cameraController.camera);

    if (this.effectEditEnabled && this.handleEffectEditClick()) return;

    if (this.cameraController.getMode() !== 'third') return; // click-to-move only makes sense in 3rd person
    if (!this.characterController.getCharacter()) return;

    const hit = new Vector3();
    if (this.raycaster.ray.intersectPlane(this.sceneController.groundPlane, hit)) {
      this.characterController.moveTo(hit);
      this.sceneController.showTargetMarker(hit);
    }
  }

  setParticleRandomnessEnabled(enabled: boolean): void {
    setParticleRandomnessEnabled(enabled);
    this.characterController.rebuildParticlesForRandomnessChange();
    this.botController.rebuildParticlesForRandomnessChange();
  }

  dispose(): void {
    this.disposed = true;
    this.assetController.cancelPending();
    this.clearEffectEditMarkers();
    this.sceneController.scene.remove(this.transformControls.getHelper());
    this.transformControls.dispose();
    this.cameraController.dispose();
    this.characterController.dispose();
    this.botController.dispose();
    this.sceneController.dispose();
  }
}
