import { Vector3 } from 'three';
import type { AnimationAction, Box3, Object3D, Scene } from 'three';
import { LoopOnce, LoopRepeat } from 'three';
import { rotationToYaw } from '../net/compassRotation';
import type { EntitySnapshot, EntityUpdate } from '../net/generated/protocol';
import { GroundHeightProvider } from '../rf/groundHeight';
import { loadMonster, instantiateMonster } from '../rf/monster';
import type { MonsterInstance } from '../rf/monster';
import { nativeToScene } from '../rf/map';

/** entity.MonsterState on the backend (internal/entity/monster.go), broadcast verbatim as EntitySnapshot/EntityUpdate's `state` field. */
const MONSTER_STATE_IDLE = 0;
const MONSTER_STATE_PATROLLING = 1;
const MONSTER_STATE_CHASING = 2;
const MONSTER_STATE_DEAD = 3;
/** entity.MonsterMode on the backend - same PEACE/WAR split MonsterController's %moncall preview clip selection already uses. */
const MONSTER_MODE_WAR = 1;

const POSITION_SMOOTHING_RATE = 12;
const ROTATION_SMOOTHING_RATE = 14;

/**
 * How much longer a dead monster keeps rendering/animating after its own
 * EntityExit arrives - see exit()'s own doc comment for why this exists:
 * the backend's own corpse-linger window (world.tickDeadMonsterLocked) is
 * about when the corpse leaves AOI bookkeeping, not about whether this
 * particular client has actually finished playing DIE/settled into CORPSE
 * yet. Long enough for a typical DIE clip plus a beat of visible CORPSE
 * pose, not tuned to any specific model's exact clip duration.
 */
const DEATH_EXIT_GRACE_SECONDS = 2.5;

/**
 * Ground-height raycasting, same shape/constants as RemoteEntityController's
 * own (see that class's applyRemoteGroundHeight) - this turned out to be
 * load-bearing for correctness, not just cosmetic polish: on any real map
 * (native RF collision loaded - see world.snapMonsterToTerrainLocked's own
 * doc comment on the backend), the server has no height data at all past
 * spawn, so without this a monster patrolling/chasing away from its spawn
 * point along a slope would just float or sink increasingly the further it
 * moves. A prior version did this unbudgeted (one raycast per monster per
 * sample, no cap) and was a measured real frame-time cost with many
 * monsters in view - GROUND_QUERY_BUDGET_PER_FRAME caps the total number of
 * raycasts across every tracked monster in one tick() call, deferring the
 * rest to later frames exactly like the player controller already does,
 * rather than removing the raycast (which would trade a performance
 * problem for a correctness one).
 */
const GROUND_QUERY_BUDGET_PER_FRAME = 24;
const GROUND_SAMPLE_INTERVAL = 0.2;
const GROUND_SAMPLE_DISTANCE = 40;
const GROUND_DESCEND_RATE = 18;
const GROUND_UNDER_EPSILON = 2;

const UP_AXIS = new Vector3(0, 1, 0);

function shortestAngleDelta(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/** First name in `candidates` this instance actually has a clip for, or null. */
function firstAvailableClip(instance: MonsterInstance, candidates: string[]): string | null {
  for (const name of candidates) {
    if (instance.clips.some((c) => c.name === name)) return name;
  }
  return null;
}

/**
 * Picks which embedded clip a remote monster should play for its current
 * wire state/mode - deterministic (no random STAND/IDLE pick the way the
 * locally-driven MonsterController does for `%moncall` preview, see its own
 * playIdleRandom) since this is a server-observed entity, not one this
 * client is steering: two clients watching the same monster should see the
 * same clip.
 */
function pickClipName(instance: MonsterInstance, state: number, mode: number, corpseReady: boolean): string | null {
  const prefix = mode === MONSTER_MODE_WAR ? 'WAR' : 'PEACE';
  if (state === MONSTER_STATE_DEAD) {
    // Once DIE has actually finished playing (see tick()'s own corpseReady
    // handling), settle on the static CORPSE pose instead of holding DIE's
    // last frame forever - falls back to DIE's own candidates if this
    // model has no CORPSE clip (see docs/monster.md's "not every monster
    // has every state").
    if (corpseReady) {
      return firstAvailableClip(instance, [`${prefix}CORPSE`, 'WARCORPSE', 'PEACECORPSE', `${prefix}DIE`, 'WARDIE', 'PEACEDIE']);
    }
    return firstAvailableClip(instance, [`${prefix}DIE`, 'WARDIE', 'PEACEDIE']);
  }
  if (state === MONSTER_STATE_CHASING) {
    return firstAvailableClip(instance, [`${prefix}RUN`, `${prefix}WALK`]);
  }
  if (state === MONSTER_STATE_PATROLLING) {
    return firstAvailableClip(instance, [`${prefix}WALK`, `${prefix}RUN`]);
  }
  return firstAvailableClip(instance, [`${prefix}STAND`, `${prefix}IDLE`]);
}

interface RemoteMonster {
  instance: MonsterInstance | null;
  position: Vector3;
  targetPosition: Vector3;
  yaw: number;
  targetYaw: number;
  state: number;
  mode: number;
  name: string;
  hp: number;
  maxHp: number;
  currentClip: string | null;
  /** Set by playHitReaction while a DAMAGE swing plays - see that method's own doc comment for why tick() prefers this over pickClipName's usual state/mode resolution while it's set. */
  reactionClip: string | null;
  /** The pending 'finished' listener for the in-flight reaction action, if any - removed before starting a new one (see playHitReaction) so a rapid second hit's own .stop() on the first action doesn't leak a listener that can now never fire (stop() doesn't emit 'finished'). */
  reactionFinishedListener: ((event: { action: AnimationAction }) => void) | null;
  /** True once this monster's DIE clip has finished playing (see tick()'s own DEAD-state handling) - false while DIE is still playing (or hasn't started), which is what keeps tick() showing DIE instead of jumping straight to CORPSE. Set true immediately for a corpse seen fresh (see `snap`) rather than replaying a death we never witnessed. */
  corpseReady: boolean;
  /** Temporary: set once we've logged a "no clip matched at all" warning for this instance, so tick() doesn't spam it every frame - see the "no monster animation ever plays" investigation. */
  loggedNoClip: boolean;
  /** Counting down to actual removal, or null if not pending - see exit()'s own doc comment. Cleared by snap()/update() so a monster that re-enters AOI (a fast respawn) before the grace period elapses is treated as a normal live sighting, not left ticking toward a stale removal. */
  pendingRemovalSecondsRemaining: number | null;
  groundTargetY: number | null;
  groundSampleTimer: number;
  lastGroundSamplePosition: Vector3;
  removed: boolean;
}

/** Snapshot of one monster's targetable info - see getTargetInfo, for the attack UI's selected-target display (name + HP). */
export interface MonsterTargetInfo {
  name: string;
  hp: number;
  maxHp: number;
  alive: boolean;
}

/**
 * Server-driven counterpart to RemoteEntityController, for MONSTER-kind
 * entities (see protocol.proto's EntityKind) - a real monster's position/
 * state/mode are purely authoritative from the server (this class only
 * smooths and animates), unlike MonsterController's own %moncall preview
 * instances, which steer themselves locally. OnlineScene routes entities to
 * one controller or the other based on EntityKind (see its own handlePacket).
 *
 * Does its own budgeted ground-height raycasting (see
 * GROUND_QUERY_BUDGET_PER_FRAME's own doc comment) - the server's X/Z are
 * authoritative but its Y is not, past spawn, on any real map (see
 * world.snapMonsterToTerrainLocked on the backend).
 */
export class RemoteMonsterController {
  private readonly scene: Scene;
  private readonly monsters = new Map<number, RemoteMonster>();
  private groundProvider: GroundHeightProvider | null = null;
  private readonly groundProbePosition = new Vector3();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  setMapGeometry(object3D: Object3D | null, bounds: Box3 | null = null): void {
    this.groundProvider = object3D ? new GroundHeightProvider(object3D, bounds) : null;
  }

  applySnapshot(monsterSnapshots: EntitySnapshot[]): void {
    const seen = new Set<number>();
    for (const snapshot of monsterSnapshots) {
      seen.add(snapshot.entityId);
      this.snap(this.getOrCreate(snapshot), snapshot);
    }
    for (const id of this.monsters.keys()) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  enter(snapshot: EntitySnapshot | undefined): void {
    if (!snapshot) return;
    this.snap(this.getOrCreate(snapshot), snapshot);
  }

  update(entityId: number, entityUpdate: EntityUpdate): void {
    const monster = this.monsters.get(entityId);
    if (!monster) return;
    monster.targetPosition.x += entityUpdate.dx;
    monster.targetPosition.y += entityUpdate.dy;
    monster.targetPosition.z += entityUpdate.dz;
    monster.targetYaw = rotationToYaw(entityUpdate.rotation);
    monster.state = entityUpdate.state;
    // An update means the backend still considers this entity in AOI - any
    // pending grace-period removal from a stale exit() is no longer valid
    // (see exit()'s own doc comment).
    monster.pendingRemovalSecondsRemaining = null;
    // Only meaningful while dead (see tick()'s own DEAD-state handling) -
    // clearing it on every non-dead update means a fresh death always
    // starts from "DIE hasn't finished yet" (the field's own default),
    // ready for the next respawn/death cycle too.
    if (monster.state !== MONSTER_STATE_DEAD) monster.corpseReady = false;
    if (entityUpdate.mode !== undefined && entityUpdate.mode !== monster.mode) {
      console.log(`[attack] entity=${entityId} mode changed ${monster.mode} -> ${entityUpdate.mode}`);
      monster.mode = entityUpdate.mode;
    }
    if (entityUpdate.hp !== undefined) monster.hp = entityUpdate.hp;
  }

  /** Selected-target display info (name/HP) for the attack UI - null if this id isn't (or is no longer) a tracked monster. */
  getTargetInfo(entityId: number): MonsterTargetInfo | null {
    const monster = this.monsters.get(entityId);
    if (!monster) return null;
    return { name: monster.name, hp: monster.hp, maxHp: monster.maxHp, alive: monster.state !== MONSTER_STATE_DEAD };
  }

  /**
   * A dead monster's own death animation shouldn't get cut off just because
   * the backend's corpse-linger window (world.tickDeadMonsterLocked)
   * happened to elapse - that's backend AOI bookkeeping, not "this client
   * has finished showing the death." A monster that's still alive when it
   * leaves AOI (walked out of range, no death involved) has no animation to
   * protect, so that case removes immediately as before.
   */
  exit(entityId: number): void {
    const monster = this.monsters.get(entityId);
    if (monster && monster.state === MONSTER_STATE_DEAD && monster.pendingRemovalSecondsRemaining === null) {
      monster.pendingRemovalSecondsRemaining = DEATH_EXIT_GRACE_SECONDS;
      return;
    }
    this.remove(entityId);
  }

  /**
   * Frontend-only hit-reaction flourish: plays this monster's `<mode>DAMAGE`
   * clip once (see docs/monster.md's 22-state vocabulary) when it takes a
   * hit, purely cosmetic - the server has no concept of this at all (no
   * wire message triggers it; OnlineScene calls this straight off a
   * CombatHitEvent client-side). Takes over tick()'s clip selection for
   * that one monster until the swing finishes, then falls back to
   * pickClipName's normal state/mode resolution automatically (same
   * finished-event handoff pattern as CharacterController.playAttack for
   * the local player).
   *
   * Falls back the same way pickClipName's own DIE case does - "not every
   * monster has every state" (docs/monster.md) turned out to include
   * DAMAGE itself on some real monsters (confirmed live: a boss-tier
   * monster with no WARDAMAGE at all, silently doing nothing under the old
   * single-candidate lookup) - CRITICAL is close enough as a "got hit"
   * reaction, and the opposite mode's clips are a last resort rather than
   * no reaction at all. True no-op only if a model has none of the four.
   */
  playHitReaction(entityId: number): void {
    const monster = this.monsters.get(entityId);
    const instance = monster?.instance;
    console.log(`[attack] playHitReaction entity=${entityId} found=${!!monster} instanceReady=${!!instance} mode=${monster?.mode} state=${monster?.state} currentClip=${monster?.currentClip}`);
    if (!monster || !instance) return;
    const prefix = monster.mode === MONSTER_MODE_WAR ? 'WAR' : 'PEACE';
    const otherPrefix = prefix === 'WAR' ? 'PEACE' : 'WAR';
    const clipName = firstAvailableClip(instance, [`${prefix}DAMAGE`, `${prefix}CRITICAL`, `${otherPrefix}DAMAGE`, `${otherPrefix}CRITICAL`]);
    if (!clipName) {
      console.warn(`[attack] no hit-reaction clip available for entity=${entityId} (mode=${monster.mode}) - model has none of DAMAGE/CRITICAL in either mode`, instance.clips.map((c) => c.name));
      return;
    }
    const clip = instance.clips.find((c) => c.name === clipName);
    console.log(`[attack] playHitReaction resolved clip="${clipName}" clipObjectFound=${!!clip}`);
    if (!clip) return;

    // A rapid second hit lands while the first reaction is still playing -
    // that first action is about to be .stop()'d below, which (unlike a
    // natural finish) never emits 'finished', so its own listener would
    // otherwise sit on the mixer forever, referencing a clip action that
    // can now never complete.
    if (monster.reactionFinishedListener) {
      instance.mixer.removeEventListener('finished', monster.reactionFinishedListener);
      monster.reactionFinishedListener = null;
    }

    instance.mixer.stopAllAction();
    const action = instance.mixer.clipAction(clip).reset();
    action.setLoop(LoopOnce, 1);
    // true, not false: clampWhenFinished=false disables the action the
    // instant it naturally finishes, and three.js immediately restores its
    // bones to their bind pose - a T-pose flash the moment the reaction
    // ends, before the 'finished' listener below even clears reactionClip,
    // let alone before tick()'s own stopAllAction()+play() hard-cut into
    // the next idle/walk loop runs on a later frame. clampWhenFinished=true
    // instead pauses on the last frame at full weight, holding the pose
    // cleanly until that hard-cut overwrites it.
    action.clampWhenFinished = true;
    action.play();
    monster.reactionClip = clipName;
    monster.currentClip = clipName;

    const onFinished = (event: { action: AnimationAction }) => {
      if (event.action !== action) return;
      instance.mixer.removeEventListener('finished', onFinished);
      if (monster.reactionFinishedListener === onFinished) monster.reactionFinishedListener = null;
      if (monster.reactionClip === clipName) monster.reactionClip = null;
    };
    monster.reactionFinishedListener = onFinished;
    instance.mixer.addEventListener('finished', onFinished);
  }

  /** Current tracked positions (raw native RF world-units) of every monster - see RemoteEntityController.getEntityPositions' own doc comment for why radar wants these unconverted. */
  getEntityPositions(): { x: number; z: number }[] {
    const positions: { x: number; z: number }[] = [];
    for (const monster of this.monsters.values()) positions.push({ x: monster.position.x, z: monster.position.z });
    return positions;
  }

  /** Entity id + root Object3D for every monster whose model has finished loading - for click-to-attack raycasting (see OnlineScene's own click handler). A monster still mid-load (instance === null) simply isn't targetable yet. */
  getTargetableObjects(): { entityId: number; object: Object3D }[] {
    const targets: { entityId: number; object: Object3D }[] = [];
    for (const [entityId, monster] of this.monsters) {
      if (monster.instance) targets.push({ entityId, object: monster.instance.root });
    }
    return targets;
  }

  tick(delta: number): void {
    const posT = 1 - Math.exp(-POSITION_SMOOTHING_RATE * delta);
    const rotT = 1 - Math.exp(-ROTATION_SMOOTHING_RATE * delta);
    let groundQueriesRemaining = GROUND_QUERY_BUDGET_PER_FRAME;
    const expiredIds: number[] = [];
    for (const [entityId, monster] of this.monsters) {
      if (monster.pendingRemovalSecondsRemaining !== null) {
        monster.pendingRemovalSecondsRemaining -= delta;
        if (monster.pendingRemovalSecondsRemaining <= 0) {
          expiredIds.push(entityId);
          continue; // about to be removed - no point animating/ground-sampling it any further this frame
        }
      }
      monster.position.lerp(monster.targetPosition, posT);
      monster.yaw += shortestAngleDelta(monster.yaw, monster.targetYaw) * rotT;

      const instance = monster.instance;
      if (!instance) continue;

      // playHitReaction owns clip selection for this monster until its
      // DAMAGE swing finishes (its own 'finished' listener clears
      // reactionClip) - skipping pickClipName entirely here, rather than
      // letting it immediately resolve back to idle/walk/run next frame and
      // stomp the reaction a single frame after it started.
      if (!monster.reactionClip) {
        const clipName = pickClipName(instance, monster.state, monster.mode, monster.corpseReady);
        if (!clipName && !monster.loggedNoClip) {
          monster.loggedNoClip = true;
          console.warn(
            `[monster-anim] no clip matched state=${monster.state} mode=${monster.mode} for this model - it has ${instance.clips.length} clip(s):`,
            instance.clips.map((c) => c.name),
          );
        }
        if (clipName && clipName !== monster.currentClip) {
          const clip = instance.clips.find((c) => c.name === clipName);
          if (!clip && !monster.loggedNoClip) {
            monster.loggedNoClip = true;
            console.warn(`[monster-anim] pickClipName resolved to "${clipName}" but no matching clip exists on this instance`, instance.clips.map((c) => c.name));
          }
          if (clip) {
            instance.mixer.stopAllAction();
            const action = instance.mixer.clipAction(clip).reset();
            // Only the DIE clip itself plays once and clamps - once it's
            // done, corpseReady flips true and the next pickClipName call
            // resolves to CORPSE instead (looped like every other ambient
            // state, see the else branch), not a second one-shot hold.
            if (monster.state === MONSTER_STATE_DEAD && !monster.corpseReady) {
              action.setLoop(LoopOnce, 1);
              action.clampWhenFinished = true;
              const onDieFinished = (event: { action: AnimationAction }) => {
                if (event.action !== action) return;
                instance.mixer.removeEventListener('finished', onDieFinished);
                monster.corpseReady = true;
              };
              instance.mixer.addEventListener('finished', onDieFinished);
            } else {
              action.setLoop(LoopRepeat, Infinity);
            }
            action.play();
            monster.currentClip = clipName;
          }
        }
      }
      instance.mixer.update(delta);

      const previousRenderY = Number.isFinite(instance.root.position.y) ? instance.root.position.y : nativeToScene(monster.position).y;
      instance.root.position.copy(nativeToScene(monster.position));
      instance.root.position.y = previousRenderY;
      groundQueriesRemaining = this.applyGroundHeight(monster, instance.root.position, previousRenderY, delta, groundQueriesRemaining);
      instance.root.quaternion.setFromAxisAngle(UP_AXIS, monster.yaw);
    }
    for (const id of expiredIds) this.remove(id);
  }

  dispose(): void {
    for (const id of [...this.monsters.keys()]) this.remove(id);
  }

  private applyGroundHeight(monster: RemoteMonster, position: Vector3, referenceY: number, delta: number, groundQueriesRemaining: number): number {
    if (!this.groundProvider) return groundQueriesRemaining;
    monster.groundSampleTimer += delta;
    const sampledBefore = Number.isFinite(monster.lastGroundSamplePosition.x);
    const movedSinceSample = sampledBefore
      ? Math.hypot(position.x - monster.lastGroundSamplePosition.x, position.z - monster.lastGroundSamplePosition.z)
      : Number.POSITIVE_INFINITY;
    const needsSample =
      monster.groundTargetY === null || monster.groundSampleTimer >= GROUND_SAMPLE_INTERVAL || movedSinceSample >= GROUND_SAMPLE_DISTANCE;
    if (needsSample && groundQueriesRemaining > 0) {
      groundQueriesRemaining--;
      this.groundProbePosition.copy(position);
      const hit = this.groundProvider.getGroundAt(this.groundProbePosition.x, this.groundProbePosition.z, {
        mode: monster.groundTargetY === null ? 'spawn' : 'movement',
        referenceY,
      });
      if (hit) monster.groundTargetY = hit.y;
      monster.groundSampleTimer = 0;
      monster.lastGroundSamplePosition.copy(position);
    }

    if (monster.groundTargetY === null) return groundQueriesRemaining;
    if (position.y < monster.groundTargetY - GROUND_UNDER_EPSILON) {
      position.y = monster.groundTargetY;
      return groundQueriesRemaining;
    }
    position.y += (monster.groundTargetY - position.y) * (1 - Math.exp(-GROUND_DESCEND_RATE * delta));
    return groundQueriesRemaining;
  }

  private snap(monster: RemoteMonster, snapshot: EntitySnapshot): void {
    monster.position.set(snapshot.x, snapshot.y, snapshot.z);
    monster.targetPosition.copy(monster.position);
    monster.yaw = rotationToYaw(snapshot.rotation);
    monster.targetYaw = monster.yaw;
    monster.state = snapshot.state;
    // A fresh sighting (WorldSnapshot/EntityEnter) means the backend
    // currently considers this entity in AOI - supersedes any pending
    // grace-period removal from a stale exit() (see that method's own doc
    // comment), e.g. a fast respawn re-entering AOI before the grace
    // period elapsed.
    monster.pendingRemovalSecondsRemaining = null;
    // A corpse seen for the first time (fresh sighting via WorldSnapshot/
    // EntityEnter, e.g. it died before this monster ever entered AOI) never
    // gets to play its DIE clip - there's no death moment to animate,
    // that already happened. Show CORPSE immediately rather than replaying
    // DIE out of context.
    monster.corpseReady = snapshot.state === MONSTER_STATE_DEAD;
    if (snapshot.monster) {
      monster.mode = snapshot.monster.mode;
      monster.name = snapshot.monster.name;
      monster.hp = snapshot.monster.hp;
      monster.maxHp = snapshot.monster.maxHp;
    }
  }

  private getOrCreate(snapshot: EntitySnapshot): RemoteMonster {
    let monster = this.monsters.get(snapshot.entityId);
    if (!monster) {
      monster = {
        instance: null,
        position: new Vector3(),
        targetPosition: new Vector3(),
        yaw: 0,
        targetYaw: 0,
        state: MONSTER_STATE_IDLE,
        mode: snapshot.monster?.mode ?? 0,
        name: snapshot.monster?.name ?? '',
        hp: snapshot.monster?.hp ?? 0,
        maxHp: snapshot.monster?.maxHp ?? 0,
        currentClip: null,
        reactionClip: null,
        reactionFinishedListener: null,
        corpseReady: false,
        loggedNoClip: false,
        pendingRemovalSecondsRemaining: null,
        groundTargetY: null,
        groundSampleTimer: Number.POSITIVE_INFINITY,
        lastGroundSamplePosition: new Vector3(Number.NaN, Number.NaN, Number.NaN),
        removed: false,
      };
      this.monsters.set(snapshot.entityId, monster);
      const modelStem = snapshot.monster?.modelStem;
      if (modelStem) void this.spawn(monster, modelStem);
      else console.error(`Monster entity ${snapshot.entityId} has no model_stem - cannot render`);
    }
    return monster;
  }

  private async spawn(monster: RemoteMonster, modelStem: string): Promise<void> {
    try {
      const asset = await loadMonster(modelStem);
      if (monster.removed) return;
      const instance = instantiateMonster(asset);
      monster.instance = instance;
      // Temporary trace for the "no monster animation ever plays"
      // investigation - the raw clip names actually embedded in this glb,
      // straight from the loader, before any WAR/PEACE-prefix matching.
      console.log(`[monster-anim] "${modelStem}" loaded with ${instance.clips.length} clip(s):`, instance.clips.map((c) => c.name));
      instance.root.position.copy(nativeToScene(monster.position));
      // One immediate, unbudgeted ground snap at spawn (mirrors
      // RemoteEntityController's own identical treatment) - without it the
      // model would render at whatever Y nativeToScene gives it (the
      // server's own, possibly stale-past-spawn value - see
      // GROUND_QUERY_BUDGET_PER_FRAME's own doc comment) for however many
      // frames it takes the budgeted per-tick sampler to get around to it.
      const hit = this.groundProvider?.getGroundAt(instance.root.position.x, instance.root.position.z, {
        mode: 'spawn',
        referenceY: instance.root.position.y,
      });
      if (hit) {
        instance.root.position.y = hit.y;
        monster.groundTargetY = hit.y;
        monster.lastGroundSamplePosition.copy(instance.root.position);
        monster.groundSampleTimer = 0;
      }
      this.scene.add(instance.root);
    } catch (err) {
      console.error(`Failed to load remote monster "${modelStem}":`, err);
    }
  }

  private remove(entityId: number): void {
    const monster = this.monsters.get(entityId);
    if (!monster) return;
    monster.removed = true;
    if (monster.instance) {
      this.scene.remove(monster.instance.root);
      monster.instance.mixer.stopAllAction();
    }
    this.monsters.delete(entityId);
  }
}
