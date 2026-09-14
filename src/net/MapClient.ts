import { isSecurePage, pageHostname, SERVER_PORT } from './serverHost';

/**
 * Client for the backend's `GET /map` / `GET /maps/{name}` inspection
 * endpoints - see `docs/map.md` (the backend repo's own frontend contract
 * for this). Unlike CharacterClient.ts's REST calls, this endpoint needs no
 * `Authorization` header - it's documented as safe to call before login,
 * purely a static readout of a map folder's native RF file contents.
 *
 * `portals`/`monsterSpawns`/`soundEntities` are modeled with real shape -
 * rf/map.ts's debug overlay is a real consumer of all three now (see
 * docs/map.md's "Development Checklist"). `helpers`/`staticEntities`/
 * `soundAssets`/`files` stay typed loosely as `unknown[]` - still no
 * consumer for those, so speculatively modeling their full shape now would
 * just be dead code to keep in sync with the backend by hand.
 */

function defaultHttpBase(): string {
  return `${isSecurePage() ? 'https:' : 'http:'}//${pageHostname()}:${SERVER_PORT}`;
}

function httpBase(): string {
  return (import.meta.env.VITE_HTTP_URL as string | undefined) ?? defaultHttpBase();
}

export interface MapVec3 {
  x: number;
  y: number;
  z: number;
}

export interface MapBounds {
  min: MapVec3;
  max: MapVec3;
}

export interface MapCollisionSummary {
  vertices: number;
  lines: number;
  leaves: number;
  bounds?: MapBounds;
}

export interface MapPortal {
  name: string;
  index?: number;
  sourceFile?: string;
  /** Native RF world position - see the module doc comment on why this (never a `blenderPosition`) is what gameplay/overlay placement uses. Absent for a portal the backend couldn't resolve a helper position for. */
  position?: MapVec3;
  bounds?: MapBounds;
  fields?: string[];
}

export interface MapMonsterEntry {
  row: number;
  code: string;
  respawnMs: number;
  count: number;
  rate: number;
}

export interface MapMonsterSpawn {
  name: string;
  group: number;
  index?: number;
  sourceFile: string;
  position?: MapVec3;
  bounds: MapBounds;
  monsters?: MapMonsterEntry[];
}

export interface MapSoundEntity {
  index: number;
  soundId: number;
  soundPath?: string;
  flags: number;
  rangeMin: number;
  rangeMax: number;
  /** Native RF world position - see MapPortal.position's own doc comment. */
  position: MapVec3;
  /** Python-converter debug space (x/z/y swap) - asset-import/debug comparisons only, per docs/map.md; never used for gameplay/overlay placement in this project. */
  blenderPosition: MapVec3;
  extents: MapVec3;
  volume: number;
}

export interface MapDetails {
  name: string;
  directory: string;
  coordinateNote: string;
  files: unknown[];
  bsp?: unknown;
  ebp?: unknown;
  collision?: MapCollisionSummary;
  helpers: unknown[];
  portals: MapPortal[];
  monsterSpawns: MapMonsterSpawn[];
  monsterFiles: unknown[];
  staticEntities: unknown[];
  soundAssets: unknown[];
  soundEntities: MapSoundEntity[];
  warnings?: string[];
}

async function fetchMapDetails(mapName?: string): Promise<MapDetails> {
  const query = mapName ? `?name=${encodeURIComponent(mapName)}` : '';
  const res = await fetch(`${httpBase()}/map${query}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to fetch map details (${res.status})`);
  }
  return res.json() as Promise<MapDetails>;
}

// Keyed by the raw `mapName` argument (every real caller today passes none -
// CharacterSelectScreen's prefetch and OnlineScene both just want "the
// server's default map"), not the resolved `MapDetails.name` - see rf/map.ts's
// own loadMap cache for the same convention/caveat. In-flight promises are
// cached too, not just settled results (same reasoning as this project's
// character-asset caches - see character.ts): CharacterSelectScreen kicks
// this off while the player is still browsing, and OnlineScene's own later
// call should join that same request rather than firing a second one.
const mapDetailsCache = new Map<string, Promise<MapDetails>>();

/**
 * Fetches native RF map metadata for `mapName` (the server's own configured
 * default map when omitted, per docs/map.md) - step 5 of the documented
 * "current supported flow", called once before opening the gameplay
 * WebSocket. A failed fetch (map not found, server unreachable) rejects (and
 * evicts the cache entry, so a later retry - e.g. OnlineScene's own call -
 * isn't stuck replaying the same failure forever); callers should treat that
 * as non-fatal to entering the world (same degrade-gracefully treatment
 * CharacterClient's cosmetic fetches get in OnlineScene.mount) since none of
 * this data is required to play, only to render the map's own
 * geometry/overlays.
 */
export function getMapDetails(mapName?: string): Promise<MapDetails> {
  const cacheKey = mapName ?? '';
  let cached = mapDetailsCache.get(cacheKey);
  if (!cached) {
    cached = fetchMapDetails(mapName);
    mapDetailsCache.set(cacheKey, cached);
    cached.catch(() => {
      mapDetailsCache.delete(cacheKey);
    });
  }
  return cached;
}
