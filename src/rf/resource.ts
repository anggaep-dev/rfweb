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
