import { Vector3 } from 'three';
import type { Scene } from 'three';
import { getCharacterAppearance } from '../net/CharacterClient';
import { rotationToYaw } from '../net/compassRotation';
import type { EntitySnapshot, EntityUpdate } from '../net/generated/protocol';
import { RaceGender, classifyMovementAgainstFacing, loadCharacter } from '../rf/character';
import type { LocomotionDirection } from '../rf/character';
import type { CharacterAppearance } from '../rf/characterProfile';
import { CharacterController } from './CharacterController';
import { applyCharacterAppearance } from './characterAppearance';
import { LocomotionDebugGizmo } from './LocomotionDebugGizmo';
import { NameTag } from './NameTag';

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
  /** TEMP debug gizmo (facing/moveDirection arrows + locomotion/clip label) - see LocomotionDebugGizmo's own doc comment. Set once mount() resolves (needs CharacterBounds.radius), same lifecycle as nameTag. */
  debugGizmo: LocomotionDebugGizmo | null;
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
  /** Scene units per raw server world unit - see setScale(). Positions are stored raw (unscaled) below and only converted at render time, so changing this retroactively re-places every tracked entity correctly instead of needing them rebuilt. */
  private scale = 1;
  /** Scratch vectors reused across every entity in a single tick() pass - fully consumed synchronously within one iteration, never held across frames. */
  private readonly scratchRight = new Vector3();
  private readonly renderedFacingScratch = new Vector3();

  constructor(scene: Scene, sessionToken: string) {
    this.scene = scene;
    this.sessionToken = sessionToken;
  }

  /**
   * The server's X/Y/Z/dx/dy/dz are its own simulation's raw integer units
   * (see spatial/grid.go's CellSize comment on the backend) with no
   * inherent relationship to this client's scene units - applying them 1:1
   * made remote players move ~30x too fast and land off the visual grid.
   * Callers derive this by matching the server's known walk-speed constant
   * (movement/system.go: WalkSpeed=1 world-unit/tick @ WorldTickHz=30, i.e.
   * 30 world-units/sec) against the local character's own walk speed
   * (CharacterController.WALK_SPEED_RADIUS_PER_SEC * radius, in scene
   * units/sec) for the same real-world speed. Revisit both sides' constants
   * if the backend changes its tick rate or WalkSpeed.
   */
  setScale(scale: number): void {
    this.scale = scale;
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
      remote.moveDirection.set(entityUpdate.dx / len, 0, entityUpdate.dz / len);
    }
  }

  exit(entityId: number, selfId: number | null): void {
    if (entityId === selfId) return;
    this.remove(entityId);
  }

  /** Current tracked positions (raw, unscaled server world-units - see setScale) of every entity here, for OnlineScene's radar relative-position math (see RadarFrame). Order is not meaningful or stable. */
  getEntityPositions(): { x: number; z: number }[] {
    const positions: { x: number; z: number }[] = [];
    for (const remote of this.entities.values()) positions.push({ x: remote.position.x, z: remote.position.z });
    return positions;
  }

  /** Smooths every tracked entity's rendered position/yaw toward its latest server-reported target, and drives its walk/idle animation - call once per render frame. */
  tick(delta: number): void {
    const posT = 1 - Math.exp(-POSITION_SMOOTHING_RATE * delta);
    const rotT = 1 - Math.exp(-ROTATION_SMOOTHING_RATE * delta);
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

      remote.controller.setWorldYaw(remote.yaw);
      const character = remote.controller.getCharacter();
      if (character) character.group.position.copy(remote.position).multiplyScalar(this.scale);
      remote.nameTag?.update(remote.controller.getHeadBone());
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
    if (character) character.group.position.copy(remote.position).multiplyScalar(this.scale);
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
        debugGizmo: null,
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
      if (remote.removed) return;
      remote.debugGizmo = new LocomotionDebugGizmo(this.scene, bounds.radius);

      const appearance = await this.loadAppearance(characterId);
      if (remote.removed || !appearance) return;
      if (appearance.name) remote.nameTag = new NameTag(this.scene, appearance.name, bounds.radius);
      await applyCharacterAppearance(remote.controller, appearance, () => remote.removed);
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
