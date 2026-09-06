import { RaceGender } from './character';

/**
 * Character body-part item categories, matching the client's ModelType enum
 * (public/raw/include_client_resource.bt) - Weapon (slot 06) isn't part of
 * that client enum (weapons are their own PartType there), but the shop/
 * store slot layout (public/raw/client_common.bt's shopByteCode, and
 * rf_common.bt's Store_Code) places weapons at index 6 right after the six
 * body slots, so it's numbered to match that.
 *
 * This is a LOCAL numbering, not the real client's Fix_Part enum (Helmet=0,
 * Face=1, Upper=2, Lower=3, Gloves=4, Shoes=5, Cloak=6, One_Handed=8,
 * Shield=9, Amulet=10, Siege_Kit=11, Ring=12, Two_Handed=100,
 * Potion_Bullet=200, RadPot=205, Box_Potion=250, Bag=300) - only the six
 * body slots plus Cloak are modeled here so far (everything else has no
 * item data or mesh archive in this asset dump to back it). Cloak is
 * numbered 7 (not the real client's 6) purely to avoid colliding with this
 * file's own pre-existing Weapon=6.
 */
export enum ModelType {
  Helmet = 0,
  Face = 1,
  Upper = 2,
  Lower = 3,
  Gauntlet = 4,
  Shoes = 5,
  Weapon = 6,
  Cloak = 7,
}

/**
 * The six body-part slots every character has a default mesh for - these
 * are also exactly the slots the real client lets you customize at
 * character creation (its own Fix_Part subset: Helmet, Face, Upper, Lower,
 * Gloves, Shoes) rather than equip later. See CharacterController's
 * baseAppearance: whichever of the 5 pre-made DEFAULT_{PART}_00{0-4}
 * variants was chosen for a slot renders whenever nothing's equipped
 * there, and is visually replaced (not removed) by a real item. On Bell/
 * Cora specifically, the Helmet slot's "default" mesh is the character's
 * hairstyle, not a piece of armor - Accretia's is a head/faceplate design
 * instead, but mechanically identical (still just 1-of-5 variant choice).
 * Excludes Weapon and Cloak, neither of which has a "default" appearance -
 * an unarmed/cloakless character simply has nothing rendered there.
 */
export const ALL_MODEL_TYPES: ModelType[] = [
  ModelType.Helmet,
  ModelType.Face,
  ModelType.Upper,
  ModelType.Lower,
  ModelType.Gauntlet,
  ModelType.Shoes,
];

/** Every equippable slot, body parts plus weapon and cloak - for UI iteration (equip panel, item preloading). */
export const ALL_EQUIP_SLOTS: ModelType[] = [...ALL_MODEL_TYPES, ModelType.Weapon, ModelType.Cloak];

/** How many pre-made variants each base-appearance slot has to choose from - see ALL_MODEL_TYPES' doc comment. Verified against every race's DEFAULT{code}.RFS: exactly 5 (numbered 000-004) per slot, no exceptions. */
export const BASE_APPEARANCE_VARIANT_COUNT = 5;

const ITEM_FILE_BY_SLOT: Record<ModelType, string> = {
  [ModelType.Helmet]: 'helmetItem.json',
  [ModelType.Face]: 'faceItem.json',
  [ModelType.Upper]: 'upperItem.json',
  [ModelType.Lower]: 'lowerItem.json',
  [ModelType.Gauntlet]: 'gauntletItem.json',
  [ModelType.Shoes]: 'shoeItem.json',
  [ModelType.Weapon]: 'weaponItem.json',
  [ModelType.Cloak]: 'cloakItem.json',
};

/**
 * The mesh-filename token for each slot's *default* body part, e.g.
 * "{RACE}_DEFAULT_GLOVES_000.msh" - note this differs from the slot's own
 * name for Gauntlet ("GLOVES" in every mesh archive, "Gauntlet" in the
 * client's ModelType enum). Weapon and Cloak have no default part (see
 * ALL_MODEL_TYPES) so their entries are never actually read - present only
 * so this stays a total Record over ModelType.
 */
export const MODEL_TYPE_TO_PART_TOKEN: Record<ModelType, string> = {
  [ModelType.Helmet]: 'HELMET',
  [ModelType.Face]: 'FACE',
  [ModelType.Upper]: 'UPPER',
  [ModelType.Lower]: 'LOWER',
  [ModelType.Gauntlet]: 'GLOVES',
  [ModelType.Shoes]: 'SHOES',
  [ModelType.Weapon]: '',
  [ModelType.Cloak]: 'CLOAK',
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
  [ModelType.Cloak]: 'Cloak',
};

const HAIR_INSTEAD_OF_HELMET_RACES = new Set<RaceGender>([
  RaceGender.Bell_Male,
  RaceGender.Bell_Female,
  RaceGender.Cora_Male,
  RaceGender.Cora_Female,
]);

/** SLOT_LABELS, except Bell/Cora's Helmet base slot is their hairstyle, not armor - see ALL_MODEL_TYPES' doc comment. Accretia's own Helmet slot is a head/faceplate design instead, so it keeps the generic label. Only meaningful for base-appearance UI (BasePartPanel, character creation) - the equip panel (real armor items) always uses the plain SLOT_LABELS. */
export function baseSlotLabel(modelType: ModelType, raceGender: RaceGender): string {
  if (modelType === ModelType.Helmet && HAIR_INSTEAD_OF_HELMET_RACES.has(raceGender)) return 'Hairstyle';
  return SLOT_LABELS[modelType];
}

const ITEM_DATA_BASE = '/game-assets/data/item';

export interface ItemDefinition {
  /** The hash key this item is stored under in its item JSON file, e.g. "ifdbf01". */
  id: string;
  name: string;
  /** Numeric resource id, links to playerResource.json/itemResource.json's Mesh tables. */
  model: string;
  /** Raw eligibility bitmask string - see isItemUsableByRace(). */
  civil: string;
  /** Required character level to use this item, 0 if the item's file doesn't carry the field at all (faceItem.json - see loadShowcaseCandidates' doc comment). */
  levelLim: number;
}

interface RawItemEntry {
  Name?: string;
  // Almost always a string (e.g. "A10300"), but weaponItem.json's Launcher
  // (Type 7) and Grenade Launcher (Type 11) rows are frequently a bare JSON
  // number instead (e.g. 411407) - coerced to string below either way, same
  // as Civil/LevelLim's own string-vs-number split. Left uncoerced, a raw
  // number here made every Map-keyed resource lookup (resolveWeaponMesh,
  // resolveItemMeshStem, resolveCloakMeshStem - all Map<string, ...>) miss
  // outright even when a real matching entry existed, since Map key lookups
  // never coerce types - which is why every Launcher mesh resolved to
  // "unavailable" despite itemResource.json actually having most of them.
  Model?: string | number;
  // weaponItem.json and cloakItem.json both store this as a bare JSON
  // number (e.g. 11111000) rather than a zero-padded string like every
  // other slot's item file - coerced to string below either way.
  Civil?: string | number;
  // Same string-vs-number split as Civil above (weaponItem.json/cloakItem.json numeric, every other slot's file zero-padded-string).
  LevelLim?: string | number;
  /**
   * Whether this row is a real, currently-obtainable item vs. a
   * removed/unused placeholder entry (a large fraction of weaponItem.json's
   * ~10,400 rows are IsExist=0 - e.g. old event weapons). Only meaningfully
   * filtered for Weapon and Cloak (see fetchSlotItems) - checked against
   * every other slot's item file too, and every entry in at least one of
   * them (faceItem.json) turned out to be IsExist=0, which would empty that
   * slot's list entirely if filtered the same way, so this is very likely
   * data-hygiene specific to files sharing weaponItem.json's own export
   * quirks (see Civil below) rather than a rule that generalizes to every
   * slot. cloakItem.json shares both quirks (bare-number Civil, and a
   * genuinely mixed 300/1272 IsExist split rather than the degenerate
   * "everything 0" case), so it gets the same treatment.
   */
  IsExist?: string | number;
}

/**
 * "Civil" is a per-race eligibility bitmask: one decimal digit per race, in
 * the same left-to-right order as the RaceGender enum (Bell_Male,
 * Bell_Female, Cora_Male, Cora_Female, Accretia), FOLLOWED BY 3 always-zero
 * unused trailing digits - so the true value is always a multiple of 1000,
 * e.g. numeric 1000 means Accretia only, 10000 means Cora_Female only,
 * 11111000 means every race. helmetItem/lowerItem/gauntletItem/shoeItem.json
 * give this as an already-8-character zero-padded string, so it needs no
 * reconstruction; upperItem.json (despite also being string-typed) and
 * weaponItem.json/cloakItem.json (bare JSON numbers) both frequently have
 * their leading zeros lost - e.g. weaponItem.json's every Launcher
 * ("Cerberus" etc, Accretia's own weapon type) stores Civil as the bare
 * number 1000, which naively left-padded to 5 characters ("01000") would
 * misread as Bell_Female-only instead of Accretia-only. Dividing out the 3
 * always-zero trailing digits first (Math.floor(civil / 1000)) recovers the
 * true 5-digit race code regardless of how many leading zeros survived.
 * faceItem.json is the one exception - a genuinely 5-digit-wide code with no
 * unused trailing digits (e.g. "1" for an Accretia-only face) - moot in
 * practice since every one of its rows is an unused placeholder (see
 * RawItemEntry.IsExist's doc comment), but handled correctly here anyway.
 */
export function isItemUsableByRace(civil: string, raceGender: RaceGender, modelType: ModelType): boolean {
  if (modelType === ModelType.Face) {
    return civil.padStart(5, '0').charAt(raceGender) === '1';
  }
  const raceCode = Math.floor(Number(civil) / 1000);
  return String(raceCode).padStart(5, '0').charAt(raceGender) === '1';
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
    // Weapon/Cloak-only - see RawItemEntry.IsExist's doc comment on why this
    // isn't applied to every slot.
    if ((modelType === ModelType.Weapon || modelType === ModelType.Cloak) && String(entry.IsExist) === '0') continue;
    items.push({
      id,
      name: entry.Name ?? id,
      model: String(entry.Model),
      civil: String(entry.Civil),
      levelLim: entry.LevelLim === undefined ? 0 : Number(entry.LevelLim),
    });
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
  return items.filter((item) => isItemUsableByRace(item.civil, raceGender, modelType));
}

/**
 * Candidates for the character-creation race showcase (see
 * CharacterCreateRaceScene) - dressing each race in impressive high-level
 * gear rather than nothing, purely for spectacle. Ordered closest-to-
 * targetLevel first (ties favor the higher level) so a caller can try each
 * in turn via CharacterController.equipItem() until one actually resolves to
 * real mesh data and stop there - plenty of item rows in this data dump have
 * no backing mesh yet (equipItem returns 'unavailable' for those, same as
 * the debug equip panel already handles). Items with no LevelLim at all
 * (levelLim 0 - faceItem.json's rows are all placeholders, see
 * RawItemEntry.IsExist's doc comment) are excluded, not just deprioritized,
 * since they're not real showcase-able gear.
 */
export async function loadShowcaseCandidates(
  modelType: ModelType,
  raceGender: RaceGender,
  targetLevel: number,
): Promise<ItemDefinition[]> {
  const items = await loadUsableSlotItems(modelType, raceGender);
  return items
    .filter((item) => item.levelLim > 0)
    .sort((a, b) => Math.abs(a.levelLim - targetLevel) - Math.abs(b.levelLim - targetLevel) || b.levelLim - a.levelLim);
}
