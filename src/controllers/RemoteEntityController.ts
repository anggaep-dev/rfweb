import { CapsuleGeometry, ConeGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Scene } from 'three';
import type { EntitySnapshot, EntityUpdate } from '../net/generated/protocol';

const HEIGHT = 1.7;
const RADIUS = 0.3;
/** Exponential smoothing rates (per second) the rendered position/yaw chase their latest server-reported target at - server updates arrive at 20-30Hz, render runs at 60/120Hz, so this is what keeps movement from visibly stepping. */
const POSITION_SMOOTHING_RATE = 12;
const ROTATION_SMOOTHING_RATE = 10;

interface RemoteEntity {
  group: Group;
  position: Vector3;
  targetPosition: Vector3;
  yaw: number;
  targetYaw: number;
}

/** The server's rotation is a 0-255 compass encoding (0 = North/-Z, 64 = East/+X, ...; see movement/system.go's directionToRotation on the backend) - this converts it to a three.js Y-axis yaw such that the object's local forward (0,0,-1) ends up facing the same way. */
function rotationToYaw(rotation: number): number {
  return -(rotation / 256) * Math.PI * 2;
}

/** Shortest signed angular distance from `from` to `to`, so yaw interpolation doesn't spin the long way around at the 0/2π wrap. */
function shortestAngleDelta(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function createPlaceholder(): Group {
  const group = new Group();

  const body = new Mesh(
    new CapsuleGeometry(RADIUS, HEIGHT - RADIUS * 2, 4, 8),
    new MeshStandardMaterial({ color: 0xff8040 }),
  );
  body.position.y = HEIGHT / 2;
  group.add(body);

  // Facing indicator - points along -Z (this project's "forward") at rest, so a remote entity's rotation is visible even though it has no real character mesh/animation to convey it.
  const nose = new Mesh(new ConeGeometry(RADIUS * 0.5, RADIUS * 1.2, 8), new MeshStandardMaterial({ color: 0xffe0a0 }));
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, HEIGHT * 0.8, -RADIUS * 1.3);
  group.add(nose);

  return group;
}

/**
 * Placeholder visuals for every other connected player. EntitySnapshot
 * carries no appearance/race data (see proto/protocol.proto), so every
 * remote entity renders as the same generic marker until the protocol
 * grows something like AppearanceUpdateEvent - swap createPlaceholder() for
 * a real mounted character at that point, the position/rotation plumbing
 * here won't need to change.
 */
export class RemoteEntityController {
  private readonly scene: Scene;
  private readonly entities = new Map<number, RemoteEntity>();
  /** Scene units per raw server world unit - see setScale(). Positions are stored raw (unscaled) below and only converted at render time, so changing this retroactively re-places every tracked entity correctly instead of needing them rebuilt. */
  private scale = 1;

  constructor(scene: Scene) {
    this.scene = scene;
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
      this.snap(this.getOrCreate(entitySnapshot.entityId), entitySnapshot);
    }
    for (const id of this.entities.keys()) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  enter(entityId: number, entitySnapshot: EntitySnapshot | undefined, selfId: number | null): void {
    if (entityId === selfId || !entitySnapshot) return;
    this.snap(this.getOrCreate(entityId), entitySnapshot);
  }

  update(entityId: number, entityUpdate: EntityUpdate, selfId: number | null): void {
    if (entityId === selfId) return;
    const remote = this.entities.get(entityId);
    if (!remote) return; // update for an entity we never got an enter/snapshot for - ignore rather than guess an absolute position from a delta alone
    remote.targetPosition.x += entityUpdate.dx;
    remote.targetPosition.y += entityUpdate.dy;
    remote.targetPosition.z += entityUpdate.dz;
    remote.targetYaw = rotationToYaw(entityUpdate.rotation);
  }

  exit(entityId: number, selfId: number | null): void {
    if (entityId === selfId) return;
    this.remove(entityId);
  }

  /** Smooths every tracked entity's rendered position/yaw toward its latest server-reported target - call once per render frame. */
  tick(delta: number): void {
    const posT = 1 - Math.exp(-POSITION_SMOOTHING_RATE * delta);
    const rotT = 1 - Math.exp(-ROTATION_SMOOTHING_RATE * delta);
    for (const remote of this.entities.values()) {
      remote.position.lerp(remote.targetPosition, posT);
      remote.group.position.copy(remote.position).multiplyScalar(this.scale);
      remote.yaw += shortestAngleDelta(remote.yaw, remote.targetYaw) * rotT;
      remote.group.rotation.y = remote.yaw;
    }
  }

  dispose(): void {
    for (const id of [...this.entities.keys()]) this.remove(id);
  }

  private snap(remote: RemoteEntity, entitySnapshot: EntitySnapshot): void {
    remote.position.set(entitySnapshot.x, entitySnapshot.y, entitySnapshot.z);
    remote.targetPosition.copy(remote.position);
    remote.group.position.copy(remote.position).multiplyScalar(this.scale);
    remote.yaw = rotationToYaw(entitySnapshot.rotation);
    remote.targetYaw = remote.yaw;
    remote.group.rotation.y = remote.yaw;
  }

  private getOrCreate(entityId: number): RemoteEntity {
    let remote = this.entities.get(entityId);
    if (!remote) {
      const group = createPlaceholder();
      this.scene.add(group);
      remote = { group, position: new Vector3(), targetPosition: new Vector3(), yaw: 0, targetYaw: 0 };
      this.entities.set(entityId, remote);
    }
    return remote;
  }

  private remove(entityId: number): void {
    const remote = this.entities.get(entityId);
    if (!remote) return;
    this.scene.remove(remote.group);
    remote.group.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      obj.geometry.dispose();
      (obj.material as MeshStandardMaterial).dispose();
    });
    this.entities.delete(entityId);
  }
}
