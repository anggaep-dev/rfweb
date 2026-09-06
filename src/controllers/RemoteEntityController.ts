import { Vector3 } from 'three';
import type { Scene } from 'three';
import { getCharacterAppearance } from '../net/CharacterClient';
import { rotationToYaw } from '../net/compassRotation';
import type { EntitySnapshot, EntityUpdate } from '../net/generated/protocol';
import { RaceGender, loadCharacter } from '../rf/character';
import type { CharacterAppearance } from '../rf/characterProfile';
import { CharacterController } from './CharacterController';
import { applyCharacterAppearance } from './characterAppearance';
import { NameTag } from './NameTag';

const UP_AXIS = new Vector3(0, 1, 0);
const LOCAL_FORWARD = new Vector3(0, 0, -1);
/** Exponential smoothing rates (per second) the rendered position/yaw chase their latest server-reported target at - server updates arrive at 20-30Hz, render runs at 60/120Hz, so this is what keeps movement from visibly stepping. */
const POSITION_SMOOTHING_RATE = 12;
const ROTATION_SMOOTHING_RATE = 10;

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
  /** Set once the appearance fetch resolves with a name (see spawn()) - null until then, so a not-yet-loaded entity simply has no tag yet rather than a placeholder one. */
  nameTag: NameTag | null;
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
  }

  exit(entityId: number, selfId: number | null): void {
    if (entityId === selfId) return;
    this.remove(entityId);
  }

  /** Smooths every tracked entity's rendered position/yaw toward its latest server-reported target, and drives its walk/idle animation - call once per render frame. */
  tick(delta: number): void {
    const posT = 1 - Math.exp(-POSITION_SMOOTHING_RATE * delta);
    const rotT = 1 - Math.exp(-ROTATION_SMOOTHING_RATE * delta);
    for (const remote of this.entities.values()) {
      remote.position.lerp(remote.targetPosition, posT);
      remote.yaw += shortestAngleDelta(remote.yaw, remote.targetYaw) * rotT;

      if (remote.isMoving) {
        const facing = LOCAL_FORWARD.clone().applyAxisAngle(UP_AXIS, remote.yaw);
        remote.controller.setMoveDirection(facing, facing, null);
      } else {
        remote.controller.setMoveDirection(null);
      }
      remote.controller.setMoveMode(remote.isRunning ? 'run' : 'walk');
      // Only for animation - CharacterController.update() also integrates
      // its own local moveDirection-driven position, which we don't want
      // here (see class doc comment); overwrite it with our own
      // server-smoothed values right after.
      remote.controller.update(delta);

      const character = remote.controller.getCharacter();
      if (character) {
        character.group.position.copy(remote.position).multiplyScalar(this.scale);
        character.group.rotation.y = remote.yaw;
      }
      remote.nameTag?.update(remote.controller.getHeadBone());
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
    const character = remote.controller.getCharacter();
    if (character) {
      character.group.position.copy(remote.position).multiplyScalar(this.scale);
      character.group.rotation.y = remote.yaw;
    }
  }

  private getOrCreate(entitySnapshot: EntitySnapshot): RemoteEntity {
    let remote = this.entities.get(entitySnapshot.entityId);
    if (!remote) {
      remote = {
        controller: new CharacterController(this.scene),
        position: new Vector3(),
        targetPosition: new Vector3(),
        yaw: 0,
        targetYaw: 0,
        isMoving: false,
        isRunning: false,
        nameTag: null,
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
    this.entities.delete(entityId);
  }
}
