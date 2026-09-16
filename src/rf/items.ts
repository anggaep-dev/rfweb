import { RACE_LABELS, RaceGender } from './character';

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
  Shield = 8,
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

/** Every equippable slot, body parts plus weapon, cloak and shield - for UI iteration (equip panel, item preloading). */
export const ALL_EQUIP_SLOTS: ModelType[] = [...ALL_MODEL_TYPES, ModelType.Weapon, ModelType.Cloak, ModelType.Shield];

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
  // Sic - matches the real on-disk filename's own capitalization typo
  // ("shielDItem.json", capital D) exactly; case matters here since this
  // is fetched as a URL path, not opened via a case-insensitive filesystem
  // API.
  [ModelType.Shield]: 'shielDItem.json',
};

/**
 * Inventory-icon sprite sheet per slot (public/game-assets/gfx/item_icon/)
 * for itemIcon.ts - each a single DXT1 DDS atlas of 64x64 cells, indexed by
 * ItemDefinition.icon (row-major, verified by decoding known items: e.g.
 * weapon.dds icon 1 is iwkna01 "Dagger"'s actual dagger icon). `Face` has no
 * entry - it's not a real inventory item (see ItemDefinition.icon's own doc
 * comment), so it's left out of this Partial rather than pointing at a
 * meaningless sheet. Ring/amulet/bullet/shield items have no catalog at all
 * (see findItemDefinitionByCode's own doc comment) despite sheets existing
 * for some of them (shield.dds, ammo.dds, ringcloak.dds's ring half) - there
 * being an icon sheet doesn't imply there's item data to look an icon index
 * up from.
 */
export const ICON_SHEET_BY_SLOT: Partial<Record<ModelType, string>> = {
  [ModelType.Helmet]: 'helmet.dds',
  [ModelType.Upper]: 'upper.dds',
  [ModelType.Lower]: 'lower.dds',
  [ModelType.Gauntlet]: 'gauntlet.dds',
  [ModelType.Shoes]: 'shoe.dds',
  [ModelType.Weapon]: 'weapon.dds',
  // Cloak and Ring items are both drawn from one shared atlas in the
  // original game data - confirmed by decoding real cloak items' IconID
  // against it (e.g. ikbpc01 "Premium Booster" -> its actual booster icon).
  [ModelType.Cloak]: 'ringcloak.dds',
  [ModelType.Shield]: 'shield.dds',
};

/**
 * The mesh-filename token for each slot's *default* body part, e.g.
 * "{RACE}_DEFAULT_GLOVES_000.msh" - note this differs from the slot's own
 * name for Gauntlet ("GLOVES" in every mesh archive, "Gauntlet" in the
 * client's ModelType enum). Weapon, Cloak and Shield have no default part
 * (see ALL_MODEL_TYPES) so their entries are never actually read - present
 * only so this stays a total Record over ModelType.
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
  [ModelType.Shield]: '',
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
  [ModelType.Shield]: 'Shield',
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
  /**
   * The real client's item-grade tier (public/raw/client_common.bt's own
   * `enum Grade`: 0=Normal_Item, 1=Intense_Item, 2=Type_B_Item,
   * 3=Type_C_Item, 4=Relic_Item, 5=Uniform_Item, 6=Special_Item,
   * 7=Majesty_Item, 8=Leon_Item, 9=Archon_Item, 45=Monster_Item - see
   * GRADE_LABELS/itemGradeLabel). Read from weaponItem.json's own bare-number
   * "Grade" field, or every other slot's numeric-string "ItemGrade" field
   * otherwise (see RawItemEntry) - the two are mutually exclusive per file,
   * never both present on the same row. Confirmed against real data:
   * "Intense Dagger" is Grade 1, "Dagger" is Grade 3 (Type_C_Item);
   * cloakItem.json's "Premium Booster" is ItemGrade 5 (Uniform_Item). Grades
   * 1-4 additionally select a Chef/GradeEffect/ cosmetic overlay via
   * gradeEffect.ts's gradeLetter (that A-D lettering isn't a separate naming
   * scheme - Grade 2 "Type_B_Item" literally is Bgrade.dds, Grade 3
   * "Type_C_Item" is Cgrade.dds) - today only ever applied for
   * ModelType.Weapon (see CharacterController's own equippedGradeOverlays
   * doc comment), regardless of how many other slots now carry a real grade
   * value.
   */
  grade?: number;
  /** Physical defense rating ("DefFc") - present on every non-weapon slot's item file, undefined for weaponItem.json (armor/shield/cloak have defense, weapons have attack instead). */
  defense?: number;
  /** Elemental resistance/affinity ratings ("FireTol"/"WaterTol"/"SoilTol"/"WindTol") - same non-weapon-only presence as `defense`. 0 is the common "no effect" baseline, same convention as ItemEffect's 0/-1 - a caller should typically hide a 0 row rather than display it. */
  fireTol?: number;
  waterTol?: number;
  soilTol?: number;
  windTol?: number;
  /**
   * Row-major index into this slot's icon sprite sheet (ICON_SHEET_BY_SLOT) -
   * weaponItem.json calls the field "Icon" (a bare number); every other
   * slot's file calls it "IconID" (a numeric string) instead, see
   * RawItemEntry's own fields. 0 is itself a real, renderable icon (a
   * "Default" placeholder glyph baked into every sheet, not "no icon") - a
   * genuinely icon-less item (faceItem.json's rows, which aren't real
   * inventory items at all) just also happens to read 0.
   */
  icon: number;
  /** EDF "IsExchange" - whether this item can be traded to another player. Present (as a string/number split identical to Civil/LevelLim's own) across every slot's item file, not just weaponItem.json. */
  tradeable: boolean;
  /** EDF "IsSell" - whether this item can be sold to an NPC shop. Present across every slot's item file, same string/number split as tradeable. */
  sellable: boolean;
  /** EDF "IsGround" - whether this item can be dropped on the ground. Present across every slot's item file, same string/number split as tradeable. */
  droppable: boolean;
  /** weaponItem.json only ("GAMinAF"/"GAMaxAF") - physical attack range. undefined for every other slot's item file, which doesn't carry these columns at all. */
  attackMin?: number;
  attackMax?: number;
  /** weaponItem.json only ("MAMinAF"/"MAMaxAF") - force/magic attack range, alongside attackMin/attackMax. */
  forceAttackMin?: number;
  forceAttackMax?: number;
  /** This item's special effects (Eff1Code..Eff4Code/Eff1Unit..Eff4Unit) - see SPECIAL_EFFECT_TYPE_LABELS. Always an array, empty when the item has none (every EffNCode is 0/-1/unset). */
  effects: ItemEffect[];
}

/** One EffNCode/EffNUnit pair - see parseEffects. */
export interface ItemEffect {
  /** SpecialEffectType (see SPECIAL_EFFECT_TYPE_LABELS) - not necessarily a recognized value; an unrecognized code is still kept (with a numeric fallback label, see effectLabel) rather than dropped, since the code/value themselves are still real data. */
  code: number;
  unit: number;
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
  // weaponItem.json only - a plain small JSON number (0-9 seen), no string/number split to handle here.
  Grade?: number;
  // Every other slot's file's own grade field (helmet/upper/lower/gauntlet/
  // shoe/cloak/shielDItem.json) - same Grade enum/value range as weaponItem.
  // json's bare-number "Grade" above, but as a numeric string instead (e.g.
  // "0", cloakItem.json's Premium Booster rows are "5" - Uniform_Item,
  // matching GRADE_LABELS[5]). weaponItem.json has no "ItemGrade" field at
  // all, so exactly one of Grade/ItemGrade is ever present on a given row.
  ItemGrade?: string | number;
  // weaponItem.json's own icon field - a bare JSON number. Every other slot's file has no "Icon" field at all, only "IconID" below.
  Icon?: number;
  // helmet/upper/lower/gauntlet/shoe/cloak/faceItem.json's icon field - a numeric string (e.g. "39"), unlike weaponItem.json's bare-number "Icon".
  IconID?: string | number;
  // Same string-vs-number split as Civil/LevelLim above (weaponItem.json bare-number, every other slot's file zero/one as a string).
  IsExchange?: string | number;
  // "Can this item be sold to an NPC shop" / "can it be dropped on the
  // ground" - present across every slot's item file (weapon included),
  // same string-vs-number split as IsExchange above.
  IsSell?: string | number;
  IsGround?: string | number;
  // weaponItem.json only - plain JSON numbers, no string/number split to handle.
  GAMinAF?: number;
  GAMaxAF?: number;
  MAMinAF?: number;
  MAMaxAF?: number;
  // Physical defense rating - every non-weapon slot's item file (helmet/
  // upper/lower/gauntlet/shoe/cloak/shielDItem.json) carries this; weaponItem.
  // json has no "DefFc" column at all. A numeric string, same split as Civil/
  // LevelLim above.
  DefFc?: string | number;
  // Elemental resistance/affinity ratings - same non-weapon-slots-only
  // presence and numeric-string typing as DefFc above.
  FireTol?: string | number;
  WaterTol?: string | number;
  SoilTol?: string | number;
  WindTol?: string | number;
  // Present across every slot's item file, not just weaponItem.json. Codes
  // are always a plain JSON number; units are the odd one - a plain number
  // for a flat value (e.g. 3, -3) but a EUC-KR-locale comma-decimal STRING
  // for a fractional/rate one (e.g. "0,079999998") - see parseEffUnit.
  Eff1Code?: number;
  Eff2Code?: number;
  Eff3Code?: number;
  Eff4Code?: number;
  Eff1Unit?: string | number;
  Eff2Unit?: string | number;
  Eff3Unit?: string | number;
  Eff4Unit?: string | number;
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

const ALL_RACES: RaceGender[] = [
  RaceGender.Bell_Male,
  RaceGender.Bell_Female,
  RaceGender.Cora_Male,
  RaceGender.Cora_Female,
  RaceGender.Accretia,
];

/** Human-readable race-eligibility summary for an item's tooltip (see isItemUsableByRace) - "All races" when every race can use it (the common case), the actual race list otherwise, or "None" for a row that, per its own Civil bitmask, no race can currently use. */
export function itemRaceLabel(civil: string, modelType: ModelType): string {
  const usable = ALL_RACES.filter((race) => isItemUsableByRace(civil, race, modelType));
  if (usable.length === ALL_RACES.length) return 'All races';
  if (usable.length === 0) return 'None';
  return usable.map((race) => RACE_LABELS[race]).join(', ');
}

/** public/raw/client_common.bt's own `enum Grade`, humanized (underscore->space, "_Item" suffix dropped) - see ItemDefinition.grade's own doc comment for how this was confirmed against real data. */
export const GRADE_LABELS: Record<number, string> = {
  0: 'Normal',
  1: 'Intense',
  2: 'Type B',
  3: 'Type C',
  4: 'Relic',
  5: 'Uniform',
  6: 'Special',
  7: 'Majesty',
  8: 'Leon',
  9: 'Archon',
  45: 'Monster',
};

/** An item's grade-tier label for a tooltip - null for grade 0 ("Normal", the overwhelming majority of items - see GRADE_LABELS) or an undefined/unrecognized value, same "omit rather than show an uninformative/wrong row" treatment every other tooltip field in this module gets. */
export function itemGradeLabel(grade: number | undefined): string | null {
  if (!grade) return null;
  return GRADE_LABELS[grade] ?? null;
}

/**
 * Per-grade item name/tooltip-border color - a reference table supplied
 * directly (not derived from any asset/data file the way GRADE_LABELS'
 * names were), so treat the actual hex values as authoritative even where
 * they look unusual (5 and 6, and separately 2 and 3, are intentionally
 * identical pairs). Grade 45 (Monster_Item) has no supplied color.
 */
export const GRADE_COLORS: Record<number, string> = {
  0: '#ffffff',
  1: '#fcff77',
  2: '#ff9900',
  3: '#ff9900',
  4: '#0279cd',
  5: '#b62a09',
  6: '#b62a09',
  7: '#a8dcae',
  8: '#61ff39',
  9: '#d67a7a',
};

/** An item's grade color (see GRADE_COLORS) - undefined grade defaults to grade 0's white, the same "no special tier" baseline GRADE_LABELS treats it as; only a genuinely unrecognized grade value (45/Monster_Item, or anything else outside GRADE_COLORS) returns undefined. */
export function itemGradeColor(grade: number | undefined): string | undefined {
  return GRADE_COLORS[grade ?? 0];
}

/** `specialEffectTypes` - an item's Eff1Code..Eff4Code (see parseEffects/ItemEffect), humanized (underscore->space). -1/0 (No_EffectNegative/No_Effect) are deliberately absent - parseEffects already filters those two out before an ItemEffect is ever created for one. */
export const SPECIAL_EFFECT_TYPE_LABELS: Record<number, string> = {
  1: 'SP',
  2: 'FP Consumption',
  3: 'Accuracy',
  4: 'Avoidance',
  5: 'HP/FP',
  6: 'Attack',
  7: 'Defense',
  8: 'Skill LVL',
  9: 'Stealth',
  10: 'Detect',
  11: 'Remove Skill Protect',
  12: 'Mov.speed',
  14: 'FP Recovery',
  15: 'Force Attack',
  16: 'FP',
  17: 'Vampire Steal HP',
  19: 'Critical',
  20: 'Range',
  21: 'Siege Kit Def',
  22: 'Debuff Assist Incr',
  23: 'HP Recovery',
  25: 'Launcher Speed',
  26: 'Force Range',
  27: 'Critical Hit',
  28: 'Shield Succes Rate',
  29: 'Resistances',
  30: 'Strenght HP',
  31: 'Force Debuff',
  32: 'Ignore Def Rate',
  34: 'Skill Delay',
  35: 'Force Attack Delay',
};

/** An effect's display name - a recognized code's humanized name (SPECIAL_EFFECT_TYPE_LABELS), or a numeric fallback ("Effect #<code>") for a code outside that table - the code/value are still real data even when this module can't name it, so it's shown rather than silently dropped (see ItemEffect's own doc comment). */
export function effectLabel(code: number): string {
  return SPECIAL_EFFECT_TYPE_LABELS[code] ?? `Effect #${code}`;
}

/** A tooltip row's full label for one effect - "Increase"/"Decrease" (by unit's sign; a unit of exactly 0 reads as Increase, same as any other non-negative value) followed by the effect's own name, e.g. "Increase Strenght HP", "Decrease Wind Speed". */
export function effectRowLabel(effect: ItemEffect): string {
  return `${effect.unit < 0 ? 'Decrease' : 'Increase'} ${effectLabel(effect.code)}`;
}

/**
 * EffNUnit is a plain JSON number for a flat value (e.g. 3, -3) but a
 * EUC-KR-locale comma-decimal STRING for a fractional/rate one (e.g.
 * "0,079999998", i.e. 0.08) - both convert to the same real number here.
 */
function parseEffUnit(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  return typeof raw === 'number' ? raw : Number(raw.replace(',', '.'));
}

/**
 * Formats an ItemEffect.unit for display - there's no per-effect-type
 * metadata available here (unlike the backend's own player.lua-driven
 * apply_normal_item_std_effect table, see docs/inventory-action.md's
 * CharacterEffect notes) to know for certain whether a given code's unit is
 * a flat stat delta or a rate, so this falls back to the same heuristic
 * that data dump itself uses to distinguish the two: a fractional value
 * (everything seen so far is comma-decimal-STRING-encoded, |unit| < 1) is a
 * rate/percentage, a whole number is a flat delta.
 */
export function formatEffectValue(unit: number): string {
  if (unit !== 0 && Math.abs(unit) < 1) return `${unit >= 0 ? '+' : ''}${(unit * 100).toFixed(1)}%`;
  return unit >= 0 ? `+${unit}` : String(unit);
}

/** Builds an item's ItemEffect list from its 4 EffNCode/EffNUnit column pairs - 0 (No_Effect) and -1 (No_EffectNegative) are dropped, not kept as effects with a "None" label. */
function parseEffects(entry: RawItemEntry): ItemEffect[] {
  const pairs: [number | undefined, string | number | undefined][] = [
    [entry.Eff1Code, entry.Eff1Unit],
    [entry.Eff2Code, entry.Eff2Unit],
    [entry.Eff3Code, entry.Eff3Unit],
    [entry.Eff4Code, entry.Eff4Unit],
  ];
  const effects: ItemEffect[] = [];
  for (const [code, unit] of pairs) {
    if (code === undefined || code === 0 || code === -1) continue;
    effects.push({ code, unit: parseEffUnit(unit) });
  }
  return effects;
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
    // Weapon/Cloak/Shield-only - see RawItemEntry.IsExist's doc comment on
    // why this isn't applied to every slot. shielDItem.json shares the same
    // pattern (real items alongside removed/unused "*C"/"*D" placeholder
    // variants, e.g. "Shield1C"/"Shield1D" next to "Round Shield"), not the
    // degenerate all-zero case faceItem.json has.
    if ((modelType === ModelType.Weapon || modelType === ModelType.Cloak || modelType === ModelType.Shield) && String(entry.IsExist) === '0')
      continue;
    const rawIcon = Number(entry.Icon ?? entry.IconID ?? 0);
    items.push({
      id,
      name: entry.Name ?? id,
      model: String(entry.Model),
      civil: String(entry.Civil),
      levelLim: entry.LevelLim === undefined ? 0 : Number(entry.LevelLim),
      grade: entry.Grade ?? (entry.ItemGrade === undefined ? undefined : Number(entry.ItemGrade)),
      defense: entry.DefFc === undefined ? undefined : Number(entry.DefFc),
      fireTol: entry.FireTol === undefined ? undefined : Number(entry.FireTol),
      waterTol: entry.WaterTol === undefined ? undefined : Number(entry.WaterTol),
      soilTol: entry.SoilTol === undefined ? undefined : Number(entry.SoilTol),
      windTol: entry.WindTol === undefined ? undefined : Number(entry.WindTol),
      icon: Number.isFinite(rawIcon) ? rawIcon : 0,
      tradeable: Number(entry.IsExchange) === 1,
      sellable: Number(entry.IsSell) === 1,
      droppable: Number(entry.IsGround) === 1,
      attackMin: entry.GAMinAF,
      attackMax: entry.GAMaxAF,
      forceAttackMin: entry.MAMinAF,
      forceAttackMax: entry.MAMaxAF,
      effects: parseEffects(entry),
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

export interface ResolvedItem {
  item: ItemDefinition;
  /** Which catalog actually matched - the caller needs this to look the item's icon up in the right ICON_SHEET_BY_SLOT sheet (item.icon alone is meaningless without knowing which sheet it indexes into). */
  modelType: ModelType;
}

/**
 * Best-effort item lookup by its raw item_code (InventorySlot/
 * EquipmentSlots' own key, see docs/inventory.md) - for InventoryWindow's
 * bag/equip display, which has no other source of item metadata. Only the
 * 8 body/weapon/cloak slot catalogs (ITEM_FILE_BY_SLOT) exist in this asset
 * dump, so a bag item from any other EDF category (potions, rings, bullets,
 * ...) simply won't resolve - callers should fall back to showing the raw
 * item_code (and no icon) in that case, not treat null as an error.
 */
export async function findItemDefinitionByCode(itemCode: string): Promise<ResolvedItem | null> {
  const results = await Promise.all(
    ALL_EQUIP_SLOTS.map(async (modelType) => ({
      modelType,
      items: await loadSlotItems(modelType).catch((err: unknown) => {
        console.error(`Failed to load item catalog for slot ${modelType}:`, err);
        return [] as ItemDefinition[];
      }),
    })),
  );
  for (const { modelType, items } of results) {
    const item = items.find((i) => i.id === itemCode);
    if (item) return { item, modelType };
  }
  return null;
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
