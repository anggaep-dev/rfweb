import type { RaceGender } from './character';

const PLAYER_RESOURCE_URL = '/game-assets/data/resource/playerResource.json';

interface PlayerResourceMeshEntry {
  ID: string;
  BoneID: string;
  PathName: string;
  FileName: string;
  // Sic - matches the source JSON field's own typo.
  TexutrePath: string;
}

interface PlayerResourceData {
  Mesh: PlayerResourceMeshEntry[];
}

/**
 * playerResource.json gives every race its own contiguous 0x100000-wide
 * block of Mesh ids for real armor tiers (verified empirically: every id in
 * [race*0x100000, race*0x100000 + 0xFFFFF) is that race's own
 * "{RACE}_ARMOR_..." file, zero cross-race collisions, across every body
 * slot) - and RaceGender's own enum values (Bell_Male=0 .. Accretia=4)
 * happen to already match that block index, so no separate lookup table is
 * needed. An item's Model id encodes which part/tier via its low 20 bits
 * (0xFFFFF) - e.g. Model 0x700200 for a Bellato-flavored item and Model
 * 0x400200 for the Accretia-flavored equivalent both carry the same low
 * bits (0x00200, "UPPER tier 0"), just written under whichever race
 * happened to be listed for that particular item row. So resolving for the
 * *currently equipping* race just means swapping in that race's own block
 * over those low bits - see resolveItemMeshStem.
 */
const RACE_MESH_BLOCK_SIZE = 0x100000;

interface PlayerResourceMeshIndexes {
  /** Exact-string-keyed, matching the raw (inconsistently 5-or-6-digit-padded) ID field verbatim. */
  byId: Map<string, PlayerResourceMeshEntry>;
  /** Same entries, keyed by parsed integer value - a computed candidate id (see resolveItemMeshStem) can't rely on the source data's inconsistent padding, so it's looked up numerically instead. */
  byValue: Map<number, PlayerResourceMeshEntry>;
}

let meshIndexesPromise: Promise<PlayerResourceMeshIndexes> | null = null;

function loadPlayerResourceMeshIndexes(): Promise<PlayerResourceMeshIndexes> {
  if (!meshIndexesPromise) {
    meshIndexesPromise = fetch(PLAYER_RESOURCE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${PLAYER_RESOURCE_URL}: ${res.status}`);
        return res.json() as Promise<PlayerResourceData>;
      })
      .then((data) => {
        const byId = new Map<string, PlayerResourceMeshEntry>();
        const byValue = new Map<number, PlayerResourceMeshEntry>();
        for (const entry of data.Mesh) {
          byId.set(entry.ID, entry);
          const value = Number.parseInt(entry.ID, 16);
          if (!Number.isNaN(value)) byValue.set(value, entry);
        }
        return { byId, byValue };
      });
    meshIndexesPromise.catch(() => {
      meshIndexesPromise = null;
    });
  }
  return meshIndexesPromise;
}

/**
 * Resolves an item's Model id to its mesh filename stem (no extension) for
 * a specific race, via playerResource.json's Mesh table. Tries an exact
 * match first (covers simple/legacy items whose Model already IS a literal
 * resource id), then falls back to the per-race block correction described
 * above (covers real armor tiers). Returns null if neither resolves -
 * callers should treat that as "no visual mesh available for this item,"
 * not an error.
 */
export async function resolveItemMeshStem(modelId: string, raceGender: RaceGender): Promise<string | null> {
  const { byId, byValue } = await loadPlayerResourceMeshIndexes();

  const direct = byId.get(modelId);
  if (direct) return direct.FileName.replace(/\.msh$/i, '');

  if (!/^[0-9a-fA-F]+$/.test(modelId)) return null;
  const low = Number.parseInt(modelId, 16) & 0xfffff;
  const candidateValue = raceGender * RACE_MESH_BLOCK_SIZE + low;

  const candidate = byValue.get(candidateValue);
  if (!candidate) return null;
  return candidate.FileName.replace(/\.msh$/i, '');
}

const ITEM_RESOURCE_URL = '/game-assets/data/resource/itemResource.json';

interface ItemResourceEntry {
  BoneID: string;
  PathName: string;
  FileName: string;
  // Sic - matches the source JSON field's own typo (see playerResource.json above).
  TexutrePath: string;
}

// Unlike playerResource.json's Mesh array, itemResource.json is a flat
// object keyed directly by model id - used for weapons/shields/cloaks/etc,
// items that live outside the per-race player Mesh/Tex archives.
type ItemResourceData = Record<string, ItemResourceEntry>;

let itemResourceIndexPromise: Promise<Map<string, ItemResourceEntry>> | null = null;

function loadItemResourceIndex(): Promise<Map<string, ItemResourceEntry>> {
  if (!itemResourceIndexPromise) {
    itemResourceIndexPromise = fetch(ITEM_RESOURCE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${ITEM_RESOURCE_URL}: ${res.status}`);
        return res.json() as Promise<ItemResourceData>;
      })
      .then((data) => {
        const index = new Map<string, ItemResourceEntry>();
        for (const [id, entry] of Object.entries(data)) {
          if (entry.FileName) index.set(id, entry);
        }
        return index;
      });
    itemResourceIndexPromise.catch(() => {
      itemResourceIndexPromise = null;
    });
  }
  return itemResourceIndexPromise;
}

export interface WeaponMeshInfo {
  /** Mesh filename stem (no extension) - an entry name shared by both the mesh (item/Weapon/Mesh/WEM*.RFS) and texture (item/Weapon/Tex/WET*.RFS) archives, so this one stem doubles as the lookup key for both - see loadWeaponMeshObjects in character.ts. */
  stem: string;
  /**
   * The weapon's animation-set token (e.g. "RKNIFE", "TSWORD", "DAXE"),
   * parsed straight out of the mesh stem's own "..._WEAPON_<TOKEN>_<number>"
   * naming - the same token used by the per-race combat clip archive
   * (character/player/Ani/{race}COA.RFS's "..._COMBAT_WALK_<TOKEN>_..." /
   * "..._COMBAT_STAND_<TOKEN>_..." entries), so no separate weapon-type-to-
   * animation-token table is needed. Null if the stem doesn't match that
   * pattern (nothing to key combat animation off of - callers should just
   * fall back to unarmed).
   */
  weaponToken: string | null;
}

const WEAPON_TOKEN_PATTERN = /_WEAPON_([A-Z]+)_\d+$/;

/**
 * Resolves a weapon item's numeric Model id to its mesh/texture stem and
 * animation token, via itemResource.json (not playerResource.json - weapon
 * meshes aren't per-race body parts, they're common loose files shared
 * across races/items). Most weapon items reference model variants not
 * present in this asset drop, so this commonly resolves to null; callers
 * should treat that as "no visual mesh available," not an error.
 */
export async function resolveWeaponMesh(modelId: string): Promise<WeaponMeshInfo | null> {
  const index = await loadItemResourceIndex();
  const entry = index.get(modelId);
  if (!entry) return null;
  const stem = entry.FileName.replace(/\.msh$/i, '');
  const match = WEAPON_TOKEN_PATTERN.exec(stem.toUpperCase());
  return { stem, weaponToken: match ? match[1] : null };
}

/**
 * Resolves a cloak item's Model id to its mesh filename stem, via
 * itemResource.json - same table as weapons (not playerResource.json's
 * per-race Mesh blocks, which was the wrong table: verified only 12 of
 * cloakItem.json's 1572 rows have a matching entry there at all, none
 * backed by a real archive file). Direct id match here gets ~27% (425/1572)
 * instead - a real, if partial, hit rate, since cloak meshes turn out to
 * live under item/Armor/Mesh/ (see loadCloakArchives in character.ts), a
 * race-agnostic shared archive set the same way weapon meshes are, not a
 * per-race body-part swap. No weapon-token parsing needed (a cloak isn't
 * combat-clip-relevant), unlike resolveWeaponMesh above.
 */
export async function resolveCloakMeshStem(modelId: string): Promise<string | null> {
  const index = await loadItemResourceIndex();
  const entry = index.get(modelId);
  if (!entry) return null;
  return entry.FileName.replace(/\.msh$/i, '');
}
