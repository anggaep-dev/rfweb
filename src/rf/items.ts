import { RaceGender } from './character';

/**
 * Character body-part item categories, matching the client's ModelType enum
 * (public/raw/include_client_resource.bt) - Weapon (slot 06) isn't part of
 * that client enum (weapons are their own PartType there), but the shop/
 * store slot layout (public/raw/client_common.bt's shopByteCode, and
 * rf_common.bt's Store_Code) places weapons at index 6 right after the six
 * body slots, so it's numbered to match that.
 */
export enum ModelType {
  Helmet = 0,
  Face = 1,
  Upper = 2,
  Lower = 3,
  Gauntlet = 4,
  Shoes = 5,
  Weapon = 6,
}

/** The six body-part slots every character has a default mesh for - excludes Weapon, which has no "default" (an unarmed character just has empty hands). */
export const ALL_MODEL_TYPES: ModelType[] = [
  ModelType.Helmet,
  ModelType.Face,
  ModelType.Upper,
  ModelType.Lower,
  ModelType.Gauntlet,
  ModelType.Shoes,
];

/** Every equippable slot, body parts plus the weapon slot - for UI iteration (equip panel, item preloading). */
export const ALL_EQUIP_SLOTS: ModelType[] = [...ALL_MODEL_TYPES, ModelType.Weapon];

const ITEM_FILE_BY_SLOT: Record<ModelType, string> = {
  [ModelType.Helmet]: 'helmetItem.json',
  [ModelType.Face]: 'faceItem.json',
  [ModelType.Upper]: 'upperItem.json',
  [ModelType.Lower]: 'lowerItem.json',
  [ModelType.Gauntlet]: 'gauntletItem.json',
  [ModelType.Shoes]: 'shoeItem.json',
  [ModelType.Weapon]: 'weaponItem.json',
};

/**
 * The mesh-filename token for each slot's *default* body part, e.g.
 * "{RACE}_DEFAULT_GLOVES_000.msh" - note this differs from the slot's own
 * name for Gauntlet ("GLOVES" in every mesh archive, "Gauntlet" in the
 * client's ModelType enum). Weapon has no default part (see ALL_MODEL_TYPES)
 * so its entry is never actually read - present only so this stays a total
 * Record over ModelType.
 */
export const MODEL_TYPE_TO_PART_TOKEN: Record<ModelType, string> = {
  [ModelType.Helmet]: 'HELMET',
  [ModelType.Face]: 'FACE',
  [ModelType.Upper]: 'UPPER',
  [ModelType.Lower]: 'LOWER',
  [ModelType.Gauntlet]: 'GLOVES',
  [ModelType.Shoes]: 'SHOES',
  [ModelType.Weapon]: '',
};

/** Human-readable label per slot, for UI (equip panel rows, warning/error messages). */
export const SLOT_LABELS: Record<ModelType, string> = {
  [ModelType.Helmet]: 'Helmet',
  [ModelType.Face]: 'Face',
  [ModelType.Upper]: 'Upper',
  [ModelType.Lower]: 'Lower',
  [ModelType.Gauntlet]: 'Gauntlet',
  [ModelType.Shoes]: 'Shoes',
  [ModelType.Weapon]: 'Weapon',
};

const ITEM_DATA_BASE = '/game-assets/data/item';

export interface ItemDefinition {
  /** The hash key this item is stored under in its item JSON file, e.g. "ifdbf01". */
  id: string;
  name: string;
  /** Numeric resource id, links to playerResource.json/itemResource.json's Mesh tables. */
  model: string;
  /** Raw eligibility bitmask string - see isItemUsableByRace(). */
  civil: string;
}

interface RawItemEntry {
  Name?: string;
  Model?: string;
  // weaponItem.json stores this as a bare JSON number (e.g. 11111000)
  // rather than a zero-padded string like every other slot's item file -
  // coerced to string below either way.
  Civil?: string | number;
  /**
   * Whether this row is a real, currently-obtainable item vs. a
   * removed/unused placeholder entry (a large fraction of weaponItem.json's
   * ~10,400 rows are IsExist=0 - e.g. old event weapons). Only meaningfully
   * filtered for the Weapon slot (see fetchSlotItems) - checked against
   * every other slot's item file too, and every entry in at least one of
   * them (faceItem.json) turned out to be IsExist=0, which would empty that
   * slot's list entirely if filtered the same way, so this is very likely
   * weapon-specific data hygiene rather than a rule that generalizes.
   * Stored as a bare number here (matching Civil's own weaponItem.json-only
   * quirk above); other slots' files store it as a string ("0"/"1") instead.
   */
  IsExist?: string | number;
}

/**
 * "Civil" is a per-race eligibility bitmask: one decimal digit per race, in
 * the same left-to-right order as the RaceGender enum (Bell_Male,
 * Bell_Female, Cora_Male, Cora_Female, Accretia) - e.g. "10000" means
 * Bell_Male only, "11000000" means either Bellato gender. Verified against
 * the real item data: faceItem.json stores it unpadded ("1" for an
 * Accretia-only face), while gauntletItem.json stores it zero-padded to 8
 * digits with 3 unused trailing digits ("00001000" for Accretia-only
 * gloves) - left-padding to 5 before indexing by RaceGender handles both.
 */
export function isItemUsableByRace(civil: string, raceGender: RaceGender): boolean {
  const padded = civil.padStart(5, '0');
  return padded.charAt(raceGender) === '1';
}

const slotItemsCache = new Map<ModelType, Promise<ItemDefinition[]>>();

async function fetchSlotItems(modelType: ModelType): Promise<ItemDefinition[]> {
  const url = `${ITEM_DATA_BASE}/${ITEM_FILE_BY_SLOT[modelType]}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const raw = (await res.json()) as Record<string, RawItemEntry>;

  const items: ItemDefinition[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry.Model || entry.Civil === undefined) continue;
    // Weapon-only - see RawItemEntry.IsExist's doc comment on why this
    // isn't applied to every slot.
    if (modelType === ModelType.Weapon && String(entry.IsExist) === '0') continue;
    items.push({ id, name: entry.Name ?? id, model: entry.Model, civil: String(entry.Civil) });
  }
  return items;
}

/** Loads (and caches) every item defined for a slot, across all races - the file content itself is race-independent. */
export function loadSlotItems(modelType: ModelType): Promise<ItemDefinition[]> {
  let cached = slotItemsCache.get(modelType);
  if (!cached) {
    cached = fetchSlotItems(modelType);
    slotItemsCache.set(modelType, cached);
  }
  return cached;
}

/** Loads a slot's items filtered to the ones a given race/gender is actually allowed to wear. */
export async function loadUsableSlotItems(modelType: ModelType, raceGender: RaceGender): Promise<ItemDefinition[]> {
  const items = await loadSlotItems(modelType);
  return items.filter((item) => isItemUsableByRace(item.civil, raceGender));
}
