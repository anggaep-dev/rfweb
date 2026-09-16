import type { RaceGender } from './character';
import { ModelType } from './items';

/** Real client caps an account at 3 character slots (character-select screen shows exactly 3 portraits, empty ones offer "Create"). */
export const MAX_CHARACTERS_PER_ACCOUNT = 3;

/** Real client's per-character inventory grid size. */
export const INVENTORY_SLOT_COUNT = 100;

/** 1-of-5 pre-made variant chosen at creation for each base-appearance slot (Helmet/Face/Upper/Lower/Gauntlet/Shoes only - see items.ts's ALL_MODEL_TYPES doc comment). Every one of the six base slots is required (no "unset" state), so this is a total Record over that subset, not Partial. */
export type BaseModelType = Exclude<ModelType, ModelType.Weapon | ModelType.Cloak | ModelType.Shield>;
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

/** Which real item (by its own id, e.g. "iwkna01" - the hash key it's stored under in its item JSON file, see items.ts's ItemDefinition) currently covers a body/weapon/cloak slot - absent means that slot is still showing its base appearance (or, for Weapon, nothing). */
export type EquippedItems = Partial<Record<ModelType, string>>;

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
  /** 1-8 = race rank icon; absent/0 = no rank badge. */
  rank?: number;
  /** Optional staff/VIP badge override, rendered instead of the race rank icon. */
  specialRank?: 'owner' | 'vip' | 'dev' | 'mod' | 'gm';
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

/**
 * The server's derived combat/movement stats after equipped-item effects
 * (rfworld's persistence.CharacterStatus / protocol.proto's CharacterStatus)
 * - only `moveSpeed` is modeled since it's the only one this project
 * consumes today (OnlineScene's local-player movement speed - see
 * CharacterController.setServerMoveSpeedMultiplier); the real wire payload
 * carries several more (maxHP, attackMin/Max, defense, ...) that simply pass
 * through unread. A multiplier applied on top of the server's own baseline
 * walk/run speed (movement/system.go's WalkSpeed/RunSpeed constants) - 1
 * means no bonus/penalty, not "no movement".
 */
export interface CharacterStatus {
  moveSpeed: number;
}

/** Full per-character data, fetched once entering the world (not needed by the select screen) - adds the fields that make CharacterSummary deliberately lighter. */
export interface CharacterProfile extends CharacterSummary {
  equipped: EquippedItems;
  inventory: InventorySlot[];
  /** Optional because older/never-fully-loaded character documents may predate this field - see DefaultCharacterStatus's own moveSpeed:1 baseline on the backend for what "never equipped anything with a speed effect" actually looks like on the wire (present, just at the neutral value), vs this being absent entirely. */
  status?: CharacterStatus;
}

/**
 * Public, ownership-unrestricted view of a character's look - unlike
 * CharacterProfile (gold/inventory/location/etc, readable only by the
 * owning account), any authenticated account can fetch anyone's appearance
 * (see net/CharacterClient.ts's getCharacterAppearance) since it's needed to
 * render *other* players for real instead of a generic placeholder (see
 * RemoteEntityController) - the server broadcasts each entity's race and
 * characterId (EntitySnapshot in protocol.proto) precisely so the client can
 * fetch this per remote player.
 */
export interface CharacterAppearance {
  name: string;
  race: RaceGender;
  rank?: number;
  specialRank?: 'owner' | 'vip' | 'dev' | 'mod' | 'gm';
  baseAppearance: BaseAppearance;
  equipped: EquippedItems;
}
