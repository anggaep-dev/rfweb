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

let meshIndexPromise: Promise<Map<string, PlayerResourceMeshEntry>> | null = null;

function loadPlayerResourceMeshIndex(): Promise<Map<string, PlayerResourceMeshEntry>> {
  if (!meshIndexPromise) {
    meshIndexPromise = fetch(PLAYER_RESOURCE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${PLAYER_RESOURCE_URL}: ${res.status}`);
        return res.json() as Promise<PlayerResourceData>;
      })
      .then((data) => {
        const index = new Map<string, PlayerResourceMeshEntry>();
        for (const entry of data.Mesh) index.set(entry.ID, entry);
        return index;
      });
    meshIndexPromise.catch(() => {
      meshIndexPromise = null;
    });
  }
  return meshIndexPromise;
}

/**
 * Resolves an item's numeric Model id to its mesh filename stem (no
 * extension), via playerResource.json's Mesh table - the only resource
 * table that currently maps arbitrary item ids to actual mesh files. Most
 * real (non-"Default ...") equipment items aren't in it yet, so this
 * commonly resolves to null; callers should treat that as "no visual mesh
 * available for this item," not an error.
 */
export async function resolveItemMeshStem(modelId: string): Promise<string | null> {
  const index = await loadPlayerResourceMeshIndex();
  const entry = index.get(modelId);
  if (!entry) return null;
  return entry.FileName.replace(/\.msh$/i, '');
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
