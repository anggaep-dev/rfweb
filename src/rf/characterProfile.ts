import type { RaceGender } from './character';
import { ModelType } from './items';

/** Real client caps an account at 3 character slots (character-select screen shows exactly 3 portraits, empty ones offer "Create"). */
export const MAX_CHARACTERS_PER_ACCOUNT = 3;

/** Real client's per-character inventory grid size. */
export const INVENTORY_SLOT_COUNT = 100;

/** 1-of-5 pre-made variant chosen at creation for each base-appearance slot (Helmet/Face/Upper/Lower/Gauntlet/Shoes only - see items.ts's ALL_MODEL_TYPES doc comment). Every one of the six base slots is required (no "unset" state), so this is a total Record over that subset, not Partial. */
export type BaseModelType = Exclude<ModelType, ModelType.Weapon | ModelType.Cloak>;
export type BaseAppearance = Record<BaseModelType, number>;

/** Same six slots as items.ts's ALL_MODEL_TYPES, narrowed to BaseModelType so it can key a BaseAppearance without a cast. */
export const BASE_MODEL_TYPES: BaseModelType[] = [
  ModelType.Helmet,
  ModelType.Face,
  ModelType.Upper,
  ModelType.Lower,
  ModelType.Gauntlet,
  ModelType.Shoes,
];

/** All six base slots at their first pre-made variant - used as the default look when creating a new character ahead of a full "customize your look" creation flow. */
export function defaultBaseAppearance(): BaseAppearance {
  return Object.fromEntries(BASE_MODEL_TYPES.map((modelType) => [modelType, 0])) as BaseAppearance;
}

/** Which real item (by modelId) currently covers a body/weapon/cloak slot - absent means that slot is still showing its base appearance (or, for Weapon, nothing). */
export type EquippedItems = Partial<Record<ModelType, number>>;

export interface InventorySlot {
  /** Item modelId, or null for an empty slot. */
  itemId: number | null;
  quantity: number;
}

/** Matches the world's own position representation (internal/entity/player.go's Player.X/Y/Z, int32) - no map/zone field since the backend only has a single world right now. */
export interface WorldLocation {
  x: number;
  y: number;
  z: number;
}

/**
 * Everything the character-select screen needs to render one slot's card and
 * 3D preview - deliberately excludes inventory (100 slots is wasted payload
 * for a screen that never shows it) and the full EquippedItems map (the
 * preview renders baseAppearance only, same as the real client's select
 * screen showing your character's base look, not its full gear). Fetch
 * CharacterProfile instead once a character is actually entered.
 */
export interface CharacterSummary {
  id: string;
  slotIndex: number;
  name: string;
  race: RaceGender;
  level: number;
  gold: number;
  /** RF's separate faction-war currency, distinct from gold. */
  cp: number;
  exp: number;
  guildName?: string;
  lastLocation: WorldLocation;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, absent for a character that has never entered the world. */
  lastPlayedAt?: string;
  baseAppearance: BaseAppearance;
}

/** Full per-character data, fetched once entering the world (not needed by the select screen) - adds the two fields that make CharacterSummary deliberately lighter. */
export interface CharacterProfile extends CharacterSummary {
  equipped: EquippedItems;
  inventory: InventorySlot[];
}
