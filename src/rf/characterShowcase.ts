import { getRaceArmorArchives, loadCloakArchives, RaceGender } from './character';
import { loadShowcaseCandidates, loadSlotItems, ModelType } from './items';
import type { ItemDefinition } from './items';

/**
 * One race's curated "look impressive" loadout for the character-creation
 * race showcase (see CharacterCreateRaceScene) - hand-picked item ids (the
 * hash key each item is stored under in its own item JSON file, e.g.
 * "iwkna01"), not derived from any formula, since a lot of item rows have no
 * backing mesh data and only a human checking the result can tell which ones
 * actually look right. Face has no slot here - every row in faceItem.json is
 * an unused placeholder (see items.ts's RawItemEntry.IsExist doc comment),
 * so there's nothing real to show there.
 */
export interface ShowcaseLoadout {
  helmet?: string;
  upper?: string;
  lower?: string;
  gauntlet?: string;
  shoes?: string;
  weapon?: string;
  cloak?: string;
}

type ShowcaseConfig = Partial<Record<string, ShowcaseLoadout>>;

const SHOWCASE_CONFIG_URL = '/game-assets/data/characterCreateShowcase.json';

const SLOT_KEY_TO_MODEL_TYPE: Record<keyof ShowcaseLoadout, ModelType> = {
  helmet: ModelType.Helmet,
  upper: ModelType.Upper,
  lower: ModelType.Lower,
  gauntlet: ModelType.Gauntlet,
  shoes: ModelType.Shoes,
  weapon: ModelType.Weapon,
  cloak: ModelType.Cloak,
};

let configPromise: Promise<ShowcaseConfig> | null = null;

function loadShowcaseConfig(): Promise<ShowcaseConfig> {
  if (!configPromise) {
    configPromise = fetch(SHOWCASE_CONFIG_URL).then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch ${SHOWCASE_CONFIG_URL}: ${res.status}`);
      return res.json() as Promise<ShowcaseConfig>;
    });
  }
  return configPromise;
}

export interface ShowcaseEquip {
  modelType: ModelType;
  /** Candidates to try in order (see CharacterCreateRaceScene.dressForShowcase) - normally just the one configured item, but falls back to the closest-to-level-50 items available (see items.ts's loadShowcaseCandidates) for a slot/race the JSON hasn't been filled in for yet, so an unfinished config still looks reasonable rather than bare. */
  candidates: ItemDefinition[];
}

/** Resolves characterCreateShowcase.json's configured ids into actual ItemDefinitions for one race, one entry per slot the config (or the level-50 fallback) has anything for. */
export async function loadShowcaseLoadout(raceGender: RaceGender): Promise<ShowcaseEquip[]> {
  const config = await loadShowcaseConfig();
  const loadout = config[String(raceGender)] ?? {};

  const results: ShowcaseEquip[] = [];
  for (const slotKey of Object.keys(SLOT_KEY_TO_MODEL_TYPE) as (keyof ShowcaseLoadout)[]) {
    const modelType = SLOT_KEY_TO_MODEL_TYPE[slotKey];
    const configuredId = loadout[slotKey];

    if (configuredId) {
      const items = await loadSlotItems(modelType);
      const item = items.find((i) => i.id === configuredId);
      if (item) {
        results.push({ modelType, candidates: [item] });
        continue;
      }
      console.warn(`characterCreateShowcase.json: item "${configuredId}" not found in slot "${slotKey}" for race ${raceGender}`);
    }

    // Not configured (or the configured id doesn't exist) - fall back to a
    // best-guess candidate list rather than leaving the slot bare.
    const fallback = await loadShowcaseCandidates(modelType, raceGender, 50);
    if (fallback.length > 0) results.push({ modelType, candidates: fallback });
  }
  return results;
}

/**
 * Warms the mesh archives every race's showcase loadout needs, so
 * CharacterCreateRaceScene's equip calls hit an already-populated cache
 * instead of each kicking off its own fetch - called as soon as the player
 * heads toward character creation (see CharacterSelectScreen), well before
 * the showcase scene itself needs the data. Deliberately NOT part of the
 * app's startup preload (preloadAllRaces) - that was made lazy/on-demand on
 * purpose (see character.ts's RaceAssets doc comment) specifically to keep
 * startup fast, and this would undo that for players who never create a
 * character this session.
 */
export function preloadShowcaseAssets(): void {
  loadShowcaseConfig()
    .then((config) => {
      for (const raceKey of Object.keys(config)) {
        const race = Number(raceKey) as RaceGender;
        if (!(race in RaceGender)) continue;
        void getRaceArmorArchives(race);
      }
      void loadCloakArchives();
    })
    .catch((err: unknown) => console.error('Failed to preload showcase assets:', err));
}
