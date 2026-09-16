import { Vector3 } from 'three';
import type { Box3, Camera, Object3D, Scene } from 'three';
import { getCharacterAppearance } from '../net/CharacterClient';
import { rotationToYaw } from '../net/compassRotation';
import type { EntitySnapshot, EntityUpdate, VisibleEquipment } from '../net/generated/protocol';
import { RaceGender, classifyMovementAgainstFacing, loadCharacter } from '../rf/character';
import type { LocomotionDirection } from '../rf/character';
import type { CharacterAppearance, EquippedItems } from '../rf/characterProfile';
import { GroundHeightProvider } from '../rf/groundHeight';
import { nativeToScene } from '../rf/map';
import { CharacterController } from './CharacterController';
import type { ParticleCullingContext } from './CharacterController';
import { applyCharacterAppearance, applyEquipmentDiff, visibleEquipmentToEquipped } from './characterAppearance';
import { LocomotionDebugGizmo } from './LocomotionDebugGizmo';
import { NameTag, nameTagYOffsetFromBounds } from './NameTag';

const UP_AXIS = new Vector3(0, 1, 0);
const LOCAL_FORWARD = new Vector3(0, 0, -1);
/**
 * Exponential smoothing rates (per second) the rendered position/yaw chase
 * their latest server-reported target at - server updates arrive at
 * 20-30Hz, render runs at 60/120Hz, so this is what keeps movement from
 * visibly stepping. Rotation is deliberately >= position's rate (never
 * slower) - during a real turn (walking forward, then turning to walk
 * forward in a new direction), a slower rotation catch-up would leave the
 * body visibly facing the old direction while position has already slid
 * toward the new one, i.e. moonwalking, until rotation caught up a few
 * hundred ms later. Backward/strafe movement never hits this at all
 * (facing doesn't change), so this only ever mattered for actual turns.
 */
const POSITION_SMOOTHING_RATE = 12;
const ROTATION_SMOOTHING_RATE = 14;
const REMOTE_GROUND_SAMPLE_INTERVAL = 0.2;
const REMOTE_GROUND_SAMPLE_DISTANCE = 40;
const REMOTE_GROUND_QUERY_BUDGET_PER_FRAME = 32;
const REMOTE_GROUND_DESCEND_RATE = 18;
const REMOTE_GROUND_UNDER_EPSILON = 2;
/** entity.PlayerState on the backend (internal/entity/player.go), broadcast verbatim as EntitySnapshot/EntityUpdate's `state` field - see isMoving/isRunning below. */
const ENTITY_STATE_IDLE = 0;
const ENTITY_STATE_RUNNING = 2;
interface RemoteEntity {
  controller: CharacterController;
  position: Vector3;
  targetPosition: Vector3;
  yaw: number;
  targetYaw: number;
  /** From the latest EntitySnapshot/EntityUpdate's `state` field - drives which animation clip plays (see tick()). Not itself smoothed; only the position/yaw it's derived alongside are. */
  isMoving: boolean;
  /** Same source, distinguishing Running from plain Moving - see MoveMode. */
  isRunning: boolean;
  /**
   * The entity's actual world-space travel direction, world units - derived
   * from the latest EntityUpdate's dx/dz (a snapshot/enter carries no delta
   * to derive this from, so it just keeps whatever it last was, or the
   * facing-matching default set at spawn, until a real update arrives).
   * This is NOT necessarily the same direction as `facing` - a player
   * stepping backward or strafing (relative to which way they're facing)
   * has a facing/travel mismatch, which is exactly what needs to be
   * classified (see tick()) so the correct backward/strafe clip plays
   * instead of always the plain forward walk/run - without this, every
   * remote entity looked like it was always moving straight forward
   * (or moonwalking, when it very much wasn't).
   */
  moveDirection: Vector3;
  /** Threaded into classifyLocomotionDirectionStable so it can resist boundary flicker - see that function's own doc comment. */
  locomotionDirection: LocomotionDirection | null;
  /** Set once the appearance fetch resolves with a name (see spawn()) - null until then, so a not-yet-loaded entity simply has no tag yet rather than a placeholder one. */
  nameTag: NameTag | null;
  /**
   * The equipped items last actually applied to `controller`, diffed against
   * on every EntityAppearanceUpdate (see applyAppearanceUpdate) so a live
   * gear change only touches the slots that actually changed instead of
   * rebuilding every mesh on each update. Empty until spawn()'s initial
   * appearance fetch resolves - an appearance update arriving before then is
   * simply dropped (see applyAppearanceUpdate), the same "not ready yet"
   * treatment mount/appearance races elsewhere in this class already get.
   */
  equipped: EquippedItems;
  /** True once spawn()'s initial mount+appearance fetch has resolved - see applyAppearanceUpdate's own doc comment for why an update arriving before then is dropped rather than diffed against the still-empty `equipped`. */
  appearanceReady: boolean;
  /**
   * This entity's latest EntitySnapshot.visible_equipment, straight off the
   * wire (WorldSnapshot/EntityEnter) - kept current by snap() regardless of
   * appearanceReady, so spawn() can apply it as soon as it's ready even
   * though snap() typically runs (synchronously, before spawn's first
   * `await` even suspends - see getOrCreate/enter's call order) well before
   * that. This is what actually fixes a freshly-spawned entity's gear: the
   * REST getCharacterAppearance fetch spawn() also uses only reflects
   * whatever the character's saved-appearance document says, which is NOT
   * the same store real equip actions (use_item) write to any more (see
   * docs/inventory-action.md) - a character that equipped something this
   * session, then went out of AOI and came back (or was already online when
   * someone else connected), would render bare-handed forever without this,
   * since VisibleEquipment was previously only ever consumed for LIVE
   * updates (applyAppearanceUpdate), never for the entity's own initial
   * appearance.
   */
  latestVisibleEquipment: VisibleEquipment | undefined;
  /** TEMP debug gizmo (facing/moveDirection arrows + locomotion/clip label) - see LocomotionDebugGizmo's own doc comment. Set once mount() resolves (needs CharacterBounds.radius), same lifecycle as nameTag. */
  debugGizmo: LocomotionDebugGizmo | null;
  groundTargetY: number | null;
  groundSampleTimer: number;
  lastGroundSamplePosition: Vector3;
  /** Set once this entity is removed - guards the async character-load/appearance-apply chain (see spawn()) against resurrecting a character (or a nametag) for an entity that's already gone by the time either finishes. */
  removed: boolean;
}

/** Shortest signed angular distance from `from` to `to`, so yaw interpolation doesn't spin the long way around at the 0/2π wrap. */
function shortestAngleDelta(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/**
 * Real mounted characters for every other connected player - race and
 * characterId now ride along on EntitySnapshot (see protocol.proto)
 * specifically so this can fetch each one's saved appearance (see
 * net/CharacterClient.ts's getCharacterAppearance, a public/ownership-
 * unrestricted lookup unlike the private CharacterProfile the local player
 * uses) instead of rendering a generic placeholder. Position/rotation stay
 * purely server-authoritative with no prediction, same as before - only the
 * "what does this player look like" side of things changed.
 *
 * CharacterController is built around a *locally* driven character (its own
 * update() integrates position from a moveDirection) - a remote entity's
 * position is authoritative from the server instead, so tick() lets
 * update() run (purely to advance the animation mixer/clip resolution) and
 * then overwrites whatever position/rotation it computed with this
 * controller's own smoothed server-derived values.
 */
export class RemoteEntityController {
  private readonly scene: Scene;
  private readonly sessionToken: string;
  private readonly entities = new Map<number, RemoteEntity>();
  /** Keyed by characterId, not entityId - a player who leaves and re-enters view (or a fresh entity_id reused by the server) shouldn't re-fetch a character whose appearance is already known. Never evicted for the lifetime of this controller (one WS session); appearance essentially never changes mid-session anyway. */
  private readonly appearanceCache = new Map<string, Promise<CharacterAppearance | null>>();
  /** Scratch vectors reused across every entity in a single tick() pass - fully consumed synchronously within one iteration, never held across frames. */
  private readonly scratchRight = new Vector3();
  private readonly renderedFacingScratch = new Vector3();
  private readonly groundProbePosition = new Vector3();
  private groundProvider: GroundHeightProvider | null = null;

  constructor(scene: Scene, sessionToken: string) {
    this.scene = scene;
    this.sessionToken = sessionToken;
  }

  setMapGeometry(object3D: Object3D | null, bounds: Box3 | null = null): void {
    this.groundProvider = object3D ? new GroundHeightProvider(object3D, bounds) : null;
  }

  /** Full authoritative roster (WorldSnapshot) - entities not present here are removed, new ones created, all positions/rotations snapped instantly (not interpolated) since this represents a hard resync rather than a routine tick update. */
  applySnapshot(entitySnapshots: EntitySnapshot[], selfId: number | null): void {
    const seen = new Set<number>();
    for (const entitySnapshot of entitySnapshots) {
      if (entitySnapshot.entityId === selfId) continue;
      seen.add(entitySnapshot.entityId);
      this.snap(this.getOrCreate(entitySnapshot), entitySnapshot);
    }
    for (const id of this.entities.keys()) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  enter(entityId: number, entitySnapshot: EntitySnapshot | undefined, selfId: number | null): void {
    if (entityId === selfId || !entitySnapshot) return;
    this.snap(this.getOrCreate(entitySnapshot), entitySnapshot);
  }

  update(entityId: number, entityUpdate: EntityUpdate, selfId: number | null): void {
    if (entityId === selfId) return;
    const remote = this.entities.get(entityId);
    if (!remote) return; // update for an entity we never got an enter/snapshot for - ignore rather than guess an absolute position from a delta alone
    remote.targetPosition.x += entityUpdate.dx;
    remote.targetPosition.y += entityUpdate.dy;
    remote.targetPosition.z += entityUpdate.dz;
    remote.targetYaw = rotationToYaw(entityUpdate.rotation);
    remote.isMoving = entityUpdate.state !== ENTITY_STATE_IDLE;
    remote.isRunning = entityUpdate.state === ENTITY_STATE_RUNNING;
    if (entityUpdate.dx !== 0 || entityUpdate.dz !== 0) {
      const len = Math.hypot(entityUpdate.dx, entityUpdate.dz);
      // moveDirection is a render-space facing hint (see its own doc
      // comment) built from a native dx/dz delta - see nativeToScene's own
      // doc comment on why Z flips going from one space to the other.
      remote.moveDirection.set(entityUpdate.dx / len, 0, -entityUpdate.dz / len);
    }
  }

  exit(entityId: number, selfId: number | null): void {
    if (entityId === selfId) return;
    this.remove(entityId);
  }

  /**
   * A live gear change on an already-tracked entity (WorldDelta.
   * appearance_updates - see protocol.proto's EntityAppearanceUpdate) -
   * previously there was no delivery for this at all, so another player's
   * mid-session equip/unequip stayed invisible to already-connected nearby
   * clients until that entity left and re-entered AOI. Dropped if the
   * entity's initial spawn()/appearance fetch hasn't resolved yet (nothing
   * meaningful to diff against, and spawn() will apply the real appearance
   * once it does resolve anyway).
   */
  applyAppearanceUpdate(entityId: number, visibleEquipment: VisibleEquipment | undefined, selfId: number | null): void {
    if (entityId === selfId) return;
    const remote = this.entities.get(entityId);
    if (!remote || !remote.appearanceReady) return;
    this.applyVisibleEquipment(remote, visibleEquipment);
  }

  /** Diffs+applies a VisibleEquipment onto one entity's controller, updating `equipped` to match - shared by applyAppearanceUpdate (a live gear change) and spawn/snap (the entity's own current/initial equipment, once appearanceReady - see latestVisibleEquipment's own doc comment). */
  private applyVisibleEquipment(remote: RemoteEntity, visibleEquipment: VisibleEquipment | undefined): void {
    const next = visibleEquipmentToEquipped(visibleEquipment);
    const previous = remote.equipped;
    remote.equipped = next;
    void applyEquipmentDiff(remote.controller, previous, next, () => remote.removed);
  }

  /** Current tracked positions (raw native RF world-units, not converted via nativeToScene - see that function's own doc comment) of every entity here, for OnlineScene's radar relative-position math (see RadarFrame) - the radar computes its own relative offsets from these before converting, see its own call site. Order is not meaningful or stable. */
  getEntityPositions(): { x: number; z: number }[] {
    const positions: { x: number; z: number }[] = [];
    for (const remote of this.entities.values()) positions.push({ x: remote.position.x, z: remote.position.z });
    return positions;
  }

  /** Summed across every tracked entity - feeds setParticleEffectCountForBudget alongside the local player's own count, same as ViewerScene/BotController. */
  getParticleEffectCount(): number {
    let count = 0;
    for (const remote of this.entities.values()) count += remote.controller.getParticleEffectCount();
    return count;
  }

  /**
   * Smooths every tracked entity's rendered position/yaw toward its latest
   * server-reported target, and drives its walk/idle animation - call once
   * per render frame. `camera`/`particleCulling` are only needed for each
   * entity's own socket-glow billboards and weapon/cloak particles (both
   * need to face the camera - see CharacterController.
   * updateSocketGlowBillboards/updateDebugSocketParticle's own doc
   * comments) - without calling these here too, a remote player's equipped
   * particle/glow renders once (in practice: never, since OnlineScene never
   * even calls initParticleBatching/initSocketGlowBatching either - see
   * OnlineScene's own constructor) and then visibly freezes forever, same
   * bug BotController.update's identical doc comment describes for bots.
   */
  tick(delta: number, camera: Camera, particleCulling: ParticleCullingContext): void {
    const posT = 1 - Math.exp(-POSITION_SMOOTHING_RATE * delta);
    const rotT = 1 - Math.exp(-ROTATION_SMOOTHING_RATE * delta);
    let groundQueriesRemaining = REMOTE_GROUND_QUERY_BUDGET_PER_FRAME;
    for (const remote of this.entities.values()) {
      remote.position.lerp(remote.targetPosition, posT);
      remote.yaw += shortestAngleDelta(remote.yaw, remote.targetYaw) * rotT;

      // Computed unconditionally (not just while moving) since the debug
      // gizmo below wants a facing arrow even for an idle entity.
      const facing = LOCAL_FORWARD.clone().applyAxisAngle(UP_AXIS, remote.targetYaw);

      if (remote.isMoving) {
        // Classified against targetYaw (the server's latest authoritative
        // facing, applied instantly), NOT the smoothed `yaw` used for the
        // actual on-screen rotation below - moveDirection itself jumps to
        // its new value instantly the moment an EntityUpdate arrives, so
        // comparing it against a facing that's still gradually rotating to
        // catch up sweeps the classification through every relative angle
        // in between (confirmed empirically: every single "start walking"
        // transiently logged bw -> lf/rt -> null before settling, even for
        // plain forward movement) - looking like a rapid clip flicker. The
        // clip may now select an instant before the visible turn finishes
        // catching up, which is far less noticeable than sweeping through
        // wrong clips.
        remote.locomotionDirection = classifyMovementAgainstFacing(
          remote.moveDirection,
          facing,
          remote.locomotionDirection,
          this.scratchRight,
          UP_AXIS,
        );
        remote.controller.setMoveDirection(facing, facing, remote.locomotionDirection);
      } else {
        remote.controller.setMoveDirection(null);
      }
      remote.controller.setMoveMode(remote.isRunning ? 'run' : 'walk');
      // Only for animation - CharacterController.update() also integrates
      // its own local moveDirection-driven position, which we don't want
      // here (see class doc comment); overwrite it with our own
      // server-smoothed values right after.
      remote.controller.update(delta);
      remote.controller.updateSocketGlowBillboards(camera, delta);
      remote.controller.updateDebugSocketParticle(camera, delta, particleCulling);

      remote.controller.setWorldYaw(remote.yaw);
      const character = remote.controller.getCharacter();
      if (character) {
        const previousRenderY = Number.isFinite(character.group.position.y) ? character.group.position.y : nativeToScene(remote.position).y;
        character.group.position.copy(nativeToScene(remote.position));
        character.group.position.y = previousRenderY;
        groundQueriesRemaining = this.applyRemoteGroundHeight(remote, character.group.position, previousRenderY, delta, groundQueriesRemaining);
      }
      remote.nameTag?.update(remote.controller.group);
      // The gizmo draws what the mesh ACTUALLY shows, not the classification
      // target above - derived from the same smoothed `yaw` setWorldYaw just
      // applied, not targetYaw, so the arrow never visibly disagrees with the
      // body it's drawn on (which is exactly what targetYaw would do for a
      // few hundred ms after any turn, while `yaw` is still smoothing toward
      // it - a real, confirmed-visible mismatch, not just a classification
      // one - see classifyMovementAgainstFacing's call above for why
      // classification itself still deliberately uses targetYaw instead).
      this.renderedFacingScratch.copy(LOCAL_FORWARD).applyAxisAngle(UP_AXIS, remote.yaw);
      remote.debugGizmo?.update(
        character ? character.group.position : remote.position,
        this.renderedFacingScratch,
        remote.isMoving ? remote.moveDirection : null,
        remote.locomotionDirection,
        remote.controller.getCurrentClipKey(),
      );
    }
  }

  dispose(): void {
    for (const id of [...this.entities.keys()]) this.remove(id);
  }

  private snap(remote: RemoteEntity, entitySnapshot: EntitySnapshot): void {
    remote.position.set(entitySnapshot.x, entitySnapshot.y, entitySnapshot.z);
    remote.targetPosition.copy(remote.position);
    remote.yaw = rotationToYaw(entitySnapshot.rotation);
    remote.targetYaw = remote.yaw;
    remote.isMoving = entitySnapshot.state !== ENTITY_STATE_IDLE;
    remote.isRunning = entitySnapshot.state === ENTITY_STATE_RUNNING;
    // moveDirection is deliberately NOT touched here - see its own doc
    // comment. A snapshot/enter carries no delta to derive a real travel
    // direction from, but this can also fire as a resync for an entity
    // already being tracked (WorldSnapshot on (re)connect), and stomping an
    // already-known-correct moveDirection back to a naive "assume forward"
    // guess would misclassify it until the next real EntityUpdate arrives.
    // getOrCreate() seeds a reasonable initial guess for a genuinely new
    // entity; this only ever refines position/rotation/state.
    remote.controller.setWorldYaw(remote.yaw);
    const character = remote.controller.getCharacter();
    if (character) {
      const previousRenderY = Number.isFinite(character.group.position.y) ? character.group.position.y : entitySnapshot.y;
      const hadGround = remote.groundTargetY !== null;
      character.group.position.copy(nativeToScene(remote.position));
      if (hadGround) character.group.position.y = previousRenderY;
      this.snapRemoteToGround(remote, character.group.position, hadGround ? previousRenderY : character.group.position.y, hadGround ? 'movement' : 'spawn');
    }

    // Always recorded (see latestVisibleEquipment's own doc comment) so
    // spawn() has the freshest known value once it's ready to use it; only
    // actually applied to the controller here if it already is ready - a
    // resync (WorldSnapshot for an already-tracked entity) is the only way
    // this client ever learns about gear a briefly-out-of-AOI entity changed
    // while unobserved, since appearance_updates never reached us for it.
    remote.latestVisibleEquipment = entitySnapshot.visibleEquipment;
    if (remote.appearanceReady) this.applyVisibleEquipment(remote, entitySnapshot.visibleEquipment);
  }

  private applyRemoteGroundHeight(remote: RemoteEntity, position: Vector3, referenceY: number, delta: number, groundQueriesRemaining: number): number {
    remote.groundSampleTimer += delta;
    const sampledBefore = Number.isFinite(remote.lastGroundSamplePosition.x);
    const movedSinceSample = sampledBefore
      ? Math.hypot(position.x - remote.lastGroundSamplePosition.x, position.z - remote.lastGroundSamplePosition.z)
      : Number.POSITIVE_INFINITY;
    const needsSample =
      remote.groundTargetY === null ||
      (remote.isMoving && (remote.groundSampleTimer >= REMOTE_GROUND_SAMPLE_INTERVAL || movedSinceSample >= REMOTE_GROUND_SAMPLE_DISTANCE));
    if (needsSample && groundQueriesRemaining > 0) {
      this.groundProbePosition.copy(position);
      groundQueriesRemaining--;
      this.snapRemoteToGround(remote, this.groundProbePosition, referenceY, remote.groundTargetY === null ? 'spawn' : 'movement');
    }

    if (remote.groundTargetY === null) return groundQueriesRemaining;
    if (position.y < remote.groundTargetY - REMOTE_GROUND_UNDER_EPSILON) {
      position.y = remote.groundTargetY;
      return groundQueriesRemaining;
    }
    position.y += (remote.groundTargetY - position.y) * (1 - Math.exp(-REMOTE_GROUND_DESCEND_RATE * delta));
    return groundQueriesRemaining;
  }

  private snapRemoteToGround(remote: RemoteEntity, position: Vector3, referenceY: number, mode: 'movement' | 'spawn' | 'teleport'): boolean {
    const hit = this.groundProvider?.getGroundAt(position.x, position.z, { mode, referenceY });
    if (!hit) return false;
    position.y = hit.y;
    remote.groundTargetY = position.y;
    remote.lastGroundSamplePosition.copy(position);
    remote.groundSampleTimer = 0;
    return true;
  }

  private getOrCreate(entitySnapshot: EntitySnapshot): RemoteEntity {
    let remote = this.entities.get(entitySnapshot.entityId);
    if (!remote) {
      // A brand-new entity has no delta yet to derive a real travel
      // direction from (see moveDirection's own doc comment) - assume
      // forward, matching its ACTUAL starting facing (not a hardcoded world
      // direction), so one that spawns already facing some direction other
      // than compass-zero isn't momentarily misclassified before its first
      // real EntityUpdate arrives.
      const initialYaw = rotationToYaw(entitySnapshot.rotation);
      remote = {
        controller: new CharacterController(this.scene),
        position: new Vector3(),
        targetPosition: new Vector3(),
        yaw: initialYaw,
        targetYaw: initialYaw,
        isMoving: false,
        isRunning: false,
        moveDirection: LOCAL_FORWARD.clone().applyAxisAngle(UP_AXIS, initialYaw),
        locomotionDirection: null,
        nameTag: null,
        equipped: {},
        appearanceReady: false,
        latestVisibleEquipment: entitySnapshot.visibleEquipment,
        debugGizmo: null,
        groundTargetY: null,
        groundSampleTimer: Number.POSITIVE_INFINITY,
        lastGroundSamplePosition: new Vector3(Number.NaN, Number.NaN, Number.NaN),
        removed: false,
      };
      this.entities.set(entitySnapshot.entityId, remote);
      void this.spawn(remote, entitySnapshot.race as RaceGender, entitySnapshot.characterId);
    }
    return remote;
  }

  /** Loads the race's default character, mounts it, then applies the character's real saved appearance on top - all async and after this entity is already tracked (getOrCreate returns immediately), so position/rotation updates arriving mid-load aren't lost, just applied once the model exists. Bails out at every await if `remote.removed` - the entity may have already left view by the time any of this resolves. */
  private async spawn(remote: RemoteEntity, race: RaceGender, characterId: string): Promise<void> {
    if (!(race in RaceGender)) {
      console.error(`Remote entity for character ${characterId} has an invalid race (${race}) - not spawning`);
      return;
    }
    try {
      const character = await loadCharacter(race);
      if (remote.removed) return;
      const bounds = await remote.controller.mount(character, race);
      const nameTagYOffset = nameTagYOffsetFromBounds(bounds);
      if (remote.removed) return;
      const mountedCharacter = remote.controller.getCharacter();
      if (mountedCharacter) {
        mountedCharacter.group.position.copy(nativeToScene(remote.position));
        this.snapRemoteToGround(remote, mountedCharacter.group.position, mountedCharacter.group.position.y, 'spawn');
      }
      remote.debugGizmo = new LocomotionDebugGizmo(this.scene, bounds.radius);

      const appearance = await this.loadAppearance(characterId);
      if (remote.removed || !appearance) return;
      if (appearance.name) {
        remote.nameTag = new NameTag(this.scene, appearance.name, bounds.radius, nameTagYOffset, {
          race: appearance.race,
          rank: appearance.rank,
          specialRank: appearance.specialRank,
        });
      }
      await applyCharacterAppearance(remote.controller, appearance, () => remote.removed);
      if (remote.removed) return;
      remote.equipped = appearance.equipped ?? {};
      remote.appearanceReady = true;
      // Overrides the REST appearance's own `equipped` above with whatever
      // VisibleEquipment is actually current (see latestVisibleEquipment's
      // own doc comment) - snap() has already set this at least once by now
      // (it runs synchronously right after getOrCreate creates this entity,
      // before this function's first `await` even suspends).
      this.applyVisibleEquipment(remote, remote.latestVisibleEquipment);
    } catch (err) {
      console.error(`Failed to spawn remote entity (character ${characterId}, race ${race}):`, err);
    }
  }

  private loadAppearance(characterId: string): Promise<CharacterAppearance | null> {
    let cached = this.appearanceCache.get(characterId);
    if (!cached) {
      cached = getCharacterAppearance(this.sessionToken, characterId).catch((err: unknown) => {
        console.error(`Failed to load appearance for character ${characterId}:`, err);
        return null;
      });
      this.appearanceCache.set(characterId, cached);
    }
    return cached;
  }

  private remove(entityId: number): void {
    const remote = this.entities.get(entityId);
    if (!remote) return;
    remote.removed = true;
    remote.controller.dispose();
    remote.nameTag?.dispose(this.scene);
    remote.debugGizmo?.dispose();
    this.entities.delete(entityId);
  }
}
