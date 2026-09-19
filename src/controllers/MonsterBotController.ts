import { Vector3 } from 'three';
import type { Scene } from 'three';
import { loadMonster } from '../rf/monster';
import type { MonsterMode } from './MonsterController';
import { MonsterController } from './MonsterController';

/** Same cap/reasoning as BotController's MAX_ADDBOT_COUNT - a typo like "%moncall 9999 x" shouldn't try to load/clone thousands of instances at once. */
const MAX_MONCALL_COUNT = 30;
/** Same sunflower-spiral spacing as BotController - spreads any number of spawned instances out from the origin with no overlap. A separate anchor point (not (0,0,0)) so a monster spawn doesn't land on top of any player-character bots spawned via %addbot in the same scene. */
const MONSTER_SPIRAL_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MONSTER_SPIRAL_RADIUS_STEP = 1.8;
const MONSTER_SPIRAL_ORIGIN = new Vector3(40, 0, 0);

// Same wandering shape as BotController's own constants (see its own doc
// comments for why: a minimum hop radius so a step actually looks like
// walking rather than a snap, and a randomized per-instance pause -
// including before the very first hop - so a batch spawned together
// doesn't move in lockstep).
const MONSTER_WANDER_MIN_RADIUS = 15;
const MONSTER_WANDER_MAX_RADIUS = 60;
const MONSTER_WANDER_PAUSE_MIN_SEC = 1.5;
const MONSTER_WANDER_PAUSE_MAX_SEC = 5;

interface SpawnedMonster {
  controller: MonsterController;
  name: string;
  /** Spawn point, so wandering roams around it rather than drifting arbitrarily far over a long session - same reasoning as BotController's own Bot.home. */
  home: Vector3;
  /** Seconds left before this instance's next wander hop - see BotController.pickWanderTarget/randomWanderPause for why this needs to be independently randomized per instance. */
  pauseRemaining: number;
}

function pickWanderTarget(home: Vector3): Vector3 {
  const angle = Math.random() * Math.PI * 2;
  const radius = MONSTER_WANDER_MIN_RADIUS + Math.random() * (MONSTER_WANDER_MAX_RADIUS - MONSTER_WANDER_MIN_RADIUS);
  return new Vector3(home.x + Math.cos(angle) * radius, home.y, home.z + Math.sin(angle) * radius);
}

function randomWanderPause(): number {
  return MONSTER_WANDER_PAUSE_MIN_SEC + Math.random() * (MONSTER_WANDER_PAUSE_MAX_SEC - MONSTER_WANDER_PAUSE_MIN_SEC);
}

/**
 * Owns `%moncall`-spawned monster instances for reviewing
 * scripts/monster_to_gltf.py's conversion output inside the debug viewer -
 * structurally similar to BotController (spiral placement, a flat list of
 * live instances, a shared update() loop, spawn/clear/dispose). Spawned
 * instances now DO wander on their own timing, same shape as BotController's
 * bots (see pickWanderTarget/randomWanderPause above and MonsterController's
 * moveTo/isMoving) - each hop plays that monster's own PEACEWALK/WARWALK
 * clip (whichever this batch's mode selected - see spawnMonsters), and
 * arriving picks a random STAND/IDLE clip to idle on (see
 * MonsterController.playIdleRandom) until the next hop's pause elapses.
 * Manually forcing a specific clip via setClipForAll still works exactly as
 * before - it just won't hold once that instance's own wander loop next
 * transitions it (arrival or the next hop), same as how a player's own
 * manual clip picks in DebugPanel get overridden by real movement.
 */
export class MonsterBotController {
  private scene: Scene;
  private monsters: SpawnedMonster[] = [];
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get count(): number {
    return this.monsters.length;
  }

  /** The most recently spawned monster's own embedded clip names - what a "toggle animation" dropdown should offer, since that's the type someone most likely just spawned to inspect. Empty before any successful spawn. */
  getLastSpawnedClipNames(): string[] {
    const last = this.monsters[this.monsters.length - 1];
    return last ? last.controller.getClipNames() : [];
  }

  /** Spawns up to MAX_MONCALL_COUNT copies of one monster by its exact (case-insensitive) manifest stem - e.g. "%moncall 3 TERRETB war". `mode` picks which PEACE/WAR clip family each instance wanders/idles with (see MonsterController) - defaults to 'peace'. Returns how many were actually added; 0 (with a console.error) if the name doesn't match any converted monster. */
  async spawnMonsters(name: string, requestedCount: number, mode: MonsterMode = 'peace'): Promise<number> {
    const count = Number.isFinite(requestedCount) ? Math.min(Math.max(Math.floor(requestedCount), 1), MAX_MONCALL_COUNT) : 1;

    let asset;
    try {
      asset = await loadMonster(name);
    } catch (err) {
      console.error(`Failed to load monster "${name}":`, err);
      return 0;
    }
    if (this.disposed) return 0;

    let added = 0;
    for (let i = 0; i < count; i++) {
      if (this.disposed) return added;
      const controller = new MonsterController(this.scene);
      controller.mount(asset, mode);

      const index = this.monsters.length;
      const angle = index * MONSTER_SPIRAL_GOLDEN_ANGLE;
      const radius = MONSTER_SPIRAL_RADIUS_STEP * Math.sqrt(index + 1);
      const home = new Vector3(MONSTER_SPIRAL_ORIGIN.x + Math.cos(angle) * radius, MONSTER_SPIRAL_ORIGIN.y, MONSTER_SPIRAL_ORIGIN.z + Math.sin(angle) * radius);
      controller.group?.position.copy(home);

      // Also randomized (not 0) so a batch spawned together doesn't take its first hop on the same frame either - same reasoning as BotController's identical choice.
      this.monsters.push({ controller, name: asset.name, home, pauseRemaining: randomWanderPause() });
      added++;
    }
    return added;
  }

  /** Plays `clipName` on every currently-spawned instance that has it (silently skipped otherwise - see class doc comment). Returns how many instances actually had it. */
  setClipForAll(clipName: string): number {
    let applied = 0;
    for (const { controller } of this.monsters) {
      if (controller.playClip(clipName)) applied++;
    }
    return applied;
  }

  /** Sets the PEACE/WAR clip family every currently-spawned instance wanders/idles with from now on - does not itself change what's playing this instant, just what the next wander transition (arrival or hop) picks from. */
  setModeForAll(mode: MonsterMode): void {
    for (const { controller } of this.monsters) controller.setMode(mode);
  }

  /** Removes and disposes every spawned monster. Returns how many were removed. */
  clearMonsters(): number {
    const removed = this.monsters.length;
    for (const { controller } of this.monsters) controller.dispose();
    this.monsters.length = 0;
    return removed;
  }

  update(delta: number): void {
    for (const monster of this.monsters) {
      monster.controller.update(delta);
      if (!monster.controller.isMoving()) {
        if (monster.pauseRemaining > 0) {
          monster.pauseRemaining -= delta;
        } else {
          monster.controller.moveTo(pickWanderTarget(monster.home));
          monster.pauseRemaining = randomWanderPause();
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearMonsters();
  }
}
