import { loadCharacter, preloadAllRaces } from '../rf/character';
import type { RaceGender, RfCharacter } from '../rf/character';

/**
 * Thin orchestration layer over rf/character.ts's fetch/parse/cache
 * functions: preloading every race up front, and per-race loads that
 * discard stale results instead of racing a newer request (the user
 * switching races again before the first load finishes, or the component
 * unmounting mid-load).
 */
export class AssetController {
  private loadGeneration = 0;

  preload(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    return preloadAllRaces(onProgress);
  }

  /**
   * Loads one race's character. If cancelPending() is called, or another
   * loadRace() starts, before this resolves, the result is dropped (resolves
   * to null) instead of overwriting whatever the newer call produced.
   */
  async loadRace(race: RaceGender): Promise<RfCharacter | null> {
    const generation = ++this.loadGeneration;
    const character = await loadCharacter(race);
    if (generation !== this.loadGeneration) return null;
    return character;
  }

  /** Invalidates any in-flight loadRace() call - e.g. on unmount, so a slow load can't resolve into a disposed scene. */
  cancelPending(): void {
    this.loadGeneration += 1;
  }
}
