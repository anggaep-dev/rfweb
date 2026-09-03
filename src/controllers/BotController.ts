import { Vector3 } from 'three';
import type { Scene } from 'three';
import { RaceGender, loadCharacter } from '../rf/character';
import { ALL_MODEL_TYPES, loadUsableSlotItems } from '../rf/items';
import { CharacterController } from './CharacterController';

/** Hard cap on spawnBots()'s count, so a typo (or "%addbot 99999") can't try to load/equip thousands of characters at once. */
const MAX_ADDBOT_COUNT = 30;
/** Chance each bot gets a random (race-eligible) item per slot instead of staying default, for visual variety. */
const BOT_RANDOM_EQUIP_CHANCE = 0.6;
/** Sunflower-spiral spacing: spreads any number of bots out from the origin with no overlap, without needing a fixed grid size up front. */
const BOT_SPIRAL_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const BOT_SPIRAL_RADIUS_STEP = 1.6;
// Bots wander by re-issuing the same click-to-move command a player click
// would, to a random point within this ring of their spawn spot - the
// minimum keeps every hop far enough to actually look like walking, rather
// than risking a sub-arrival-threshold "hop" that snaps to stand instantly.
const BOT_WANDER_MIN_RADIUS = 1;
const BOT_WANDER_MAX_RADIUS = 50;
// A random pause between hops (instead of instantly re-issuing the next
// move on arrival) - without this, bots spawned in the same batch tend to
// become idle on the same frame and all pick their next waypoint in
// lockstep, which reads as "synchronized" even though the destinations
// themselves are already random. The randomized pause (including the
// initial one, before any bot's first move) staggers each bot onto its own
// independent timing.
const BOT_WANDER_PAUSE_MIN_SEC = 1;
const BOT_WANDER_PAUSE_MAX_SEC = 4;

const ALL_RACE_GENDERS: RaceGender[] = [
  RaceGender.Bell_Male,
  RaceGender.Bell_Female,
  RaceGender.Cora_Male,
  RaceGender.Cora_Female,
  RaceGender.Accretia,
];

interface Bot {
  controller: CharacterController;
  /** Spawn point, so wandering roams around it rather than drifting arbitrarily far over a long session. */
  home: Vector3;
  /** Seconds left before this bot's next move - independently randomized so bots never move in lockstep. */
  pauseRemaining: number;
}

function pickWanderTarget(home: Vector3): Vector3 {
  const angle = Math.random() * Math.PI * 2;
  const radius = BOT_WANDER_MIN_RADIUS + Math.random() * (BOT_WANDER_MAX_RADIUS - BOT_WANDER_MIN_RADIUS);
  return new Vector3(home.x + Math.cos(angle) * radius, home.y, home.z + Math.sin(angle) * radius);
}

function randomWanderPause(): number {
  return BOT_WANDER_PAUSE_MIN_SEC + Math.random() * (BOT_WANDER_PAUSE_MAX_SEC - BOT_WANDER_PAUSE_MIN_SEC);
}

/**
 * Owns GM-command bots: independent CharacterControllers, each with a
 * randomly picked race and (with some probability, for visual variety) a
 * randomly picked race-eligible item per slot, that wander around their
 * spawn point on their own independent timing. Loaded via loadCharacter()
 * directly rather than AssetController.loadRace() - that method's
 * generation counter is specifically for "supersede a stale switch of *the*
 * player race," which doesn't apply to bots and would incorrectly drop a
 * bot's load if the player switched races (or another spawnBots() ran)
 * while it was in flight.
 */
export class BotController {
  private scene: Scene;
  private bots: Bot[] = [];
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get count(): number {
    return this.bots.length;
  }

  /** Spawns up to MAX_ADDBOT_COUNT bots, clamped and floored to at least 1. Returns how many were actually added (a bot whose load/mount fails is skipped). */
  async spawnBots(requestedCount: number): Promise<number> {
    const count = Number.isFinite(requestedCount) ? Math.min(Math.max(Math.floor(requestedCount), 1), MAX_ADDBOT_COUNT) : 1;
    let added = 0;
    for (let i = 0; i < count; i++) {
      if (this.disposed) return added;
      const race = ALL_RACE_GENDERS[Math.floor(Math.random() * ALL_RACE_GENDERS.length)];

      let character;
      try {
        character = await loadCharacter(race);
      } catch (err) {
        console.error('Failed to load bot character:', err);
        continue;
      }
      if (this.disposed) return added;

      const controller = new CharacterController(this.scene);
      await controller.mount(character, race);
      if (this.disposed) {
        controller.dispose();
        return added;
      }

      for (const modelType of ALL_MODEL_TYPES) {
        if (Math.random() >= BOT_RANDOM_EQUIP_CHANCE) continue;
        try {
          const items = await loadUsableSlotItems(modelType, race);
          if (items.length === 0) continue;
          const item = items[Math.floor(Math.random() * items.length)];
          await controller.equipItem(modelType, item);
        } catch (err) {
          console.warn('Bot equip failed:', err);
        }
        if (this.disposed) {
          controller.dispose();
          return added;
        }
      }

      const index = this.bots.length;
      const angle = index * BOT_SPIRAL_GOLDEN_ANGLE;
      const radius = BOT_SPIRAL_RADIUS_STEP * Math.sqrt(index + 1);
      const home = new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      controller.group?.position.copy(home);

      // Also randomized (not 0) so bots spawned in the same batch don't all
      // take their first step on the same frame either.
      this.bots.push({ controller, home, pauseRemaining: randomWanderPause() });
      added++;
    }
    return added;
  }

  /** Removes and disposes every bot. Returns how many were removed. */
  clearBots(): number {
    const removed = this.bots.length;
    for (const bot of this.bots) bot.controller.dispose();
    this.bots.length = 0;
    return removed;
  }

  update(delta: number): void {
    for (const bot of this.bots) {
      bot.controller.update(delta);
      // Re-issue the same "walk here" command a player click would, once
      // the bot isn't mid-hop *and* has waited out its own random pause -
      // covers "just arrived" (isMoving() flips false the instant update()
      // clears the target), "brand new, never moved yet", and keeps every
      // bot on independent timing so a batch spawned together doesn't move
      // in lockstep.
      if (!bot.controller.isMoving()) {
        if (bot.pauseRemaining > 0) {
          bot.pauseRemaining -= delta;
        } else {
          bot.controller.moveTo(pickWanderTarget(bot.home));
          bot.pauseRemaining = randomWanderPause();
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearBots();
  }
}
