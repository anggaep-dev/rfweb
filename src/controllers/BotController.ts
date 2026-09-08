import { Vector3 } from 'three';
import type { Camera, Scene } from 'three';
import { RaceGender, loadCharacter } from '../rf/character';
import { ALL_EQUIP_SLOTS, ModelType, loadUsableSlotItems } from '../rf/items';
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

export interface SpawnBotOptions {
  /**
   * Case-insensitive substring match against a weapon item's own `name`
   * (not required to be the full/exact name - "crimson" matches both
   * "Crimson Eater" and every "Crimson [Hora] <Type>[Rare D]" item) -
   * forces every bot's weapon slot to a random race-eligible item
   * matching this filter instead of the normal random-per-slot equip
   * chance, so a specific real weapon family can be stress-tested (e.g.
   * "%addbot 5 crimson 7" - see ViewerScene.runCommand) without equipping
   * one bot at a time by hand. A bot whose own race has no matching item
   * (Civil eligibility can differ per item) just ends up unarmed for this
   * slot, same graceful-miss handling as the normal random equip path
   * below.
   */
  weaponNameFilter?: string;
  /** Simulated +N upgrade level (see CharacterController.setDebugWeaponUpgradeLevel) - applied to whichever weapon a bot actually ends up with, whether or not weaponNameFilter forced a specific one. */
  weaponUpgradeLevel?: number;
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
 * randomly picked race-eligible item per slot, spawned in War mode (see
 * spawnBots) so an equipped weapon actually shows rather than sitting
 * hidden the way Peace mode always renders it, that wander around their
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

  /** Spawns up to MAX_ADDBOT_COUNT bots, clamped and floored to at least 1. Returns how many were actually added (a bot whose load/mount fails is skipped). See SpawnBotOptions for the optional weapon-filter/upgrade-level stress-testing hooks - omitted or empty, every slot (weapon included) just gets the normal random-per-slot equip roll. */
  async spawnBots(requestedCount: number, options?: SpawnBotOptions): Promise<number> {
    const count = Number.isFinite(requestedCount) ? Math.min(Math.max(Math.floor(requestedCount), 1), MAX_ADDBOT_COUNT) : 1;
    const weaponNameFilter = options?.weaponNameFilter?.toLowerCase();
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
      // War mode, not the default Peace - a bot's whole point here is
      // visual/stress testing (see SpawnBotOptions), and Peace hides the
      // weapon mesh entirely (see CharacterController.applyWeaponVisibility)
      // regardless of what actually got equipped below, which defeated
      // every purpose an equipped bot serves.
      controller.setBattleMode('war');

      for (const modelType of ALL_EQUIP_SLOTS) {
        // ALL_EQUIP_SLOTS, not items.ts's own ALL_MODEL_TYPES - that name
        // is misleading (it's only the *body* slots: Helmet/Face/Upper/
        // Lower/Gauntlet/Shoes, deliberately excluding Weapon/Cloak - see
        // its own doc comment) - using it here silently meant a bot could
        // never equip a weapon or cloak at all, regardless of
        // BOT_RANDOM_EQUIP_CHANCE or any weaponNameFilter, a real bug this
        // project had from before weaponNameFilter/weaponUpgradeLevel even
        // existed (reported as "bot only walking... i cannot see the
        // weapon" - the actual cause wasn't War-mode visibility, it was
        // that no weapon was ever being equipped in the first place).
        //
        // A forced weapon filter always attempts that slot, bypassing the
        // normal random chance below - every other slot (and the weapon
        // slot too, when no filter is given) keeps the usual roll.
        const isForcedWeapon = modelType === ModelType.Weapon && weaponNameFilter;
        if (!isForcedWeapon && Math.random() >= BOT_RANDOM_EQUIP_CHANCE) continue;

        try {
          const items = await loadUsableSlotItems(modelType, race);
          const candidates = isForcedWeapon ? items.filter((item) => item.name.toLowerCase().includes(weaponNameFilter)) : items;
          if (candidates.length === 0) continue;
          const item = candidates[Math.floor(Math.random() * candidates.length)];
          await controller.equipItem(modelType, item);
          if (modelType === ModelType.Weapon && options?.weaponUpgradeLevel !== undefined) {
            controller.setDebugWeaponUpgradeLevel(options.weaponUpgradeLevel);
          }
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

  /**
   * `camera` is only needed for each bot's own socket-glow billboards and
   * weapon particles (both need to face the camera - see
   * CharacterController.updateSocketGlowBillboards/
   * updateDebugSocketParticle's own doc comments) - without calling these
   * here too, a bot's weapon particle/glow renders once at spawn and then
   * visibly freezes forever (reported directly: "particle is visible but
   * not animated on bot"), since ViewerScene.update() only ever drove
   * these for its own player-facing `characterController`, never for any
   * bot's own independent one.
   */
  update(delta: number, camera: Camera): void {
    for (const bot of this.bots) {
      bot.controller.update(delta);
      bot.controller.updateSocketGlowBillboards(camera, delta);
      bot.controller.updateDebugSocketParticle(camera, delta);
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
