import { Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry } from 'three';
import type { Texture } from 'three';
import { materialAlphaOptions } from './character';
import { fetchChefAssetCaseInsensitive } from './glowEffect';
import { parseBsp } from './bsp';
import { parseEbpCollision } from './ebp';
import type { CollisionWall } from './ebp';
import { parseR3M } from './r3m';
import { parseR3T } from './r3t';
import { decodeRftTexture } from './texture';
import { getMapDetails } from '../net/MapClient';
import type { MapMonsterSpawn, MapPortal, MapSoundEntity, MapVec3 } from '../net/MapClient';

/**
 * Loads a map's world geometry (`.bsp` + its sibling `.r3m`/`.r3t`, all
 * client-parsed in the browser - see bsp.ts/r3m.ts/r3t.ts) into a
 * ready-to-add three.js Group, one Mesh per distinct material - plus a debug
 * overlay of portal/monster-spawn/sound-entity markers from the same GET
 * /map response (see docs/map.md's "Development Checklist").
 *
 * Matches the raw-client-asset convention `public/game-assets/README.md`
 * already documents for the map milestone: files live under
 * `public/game-assets/maps/{MapName}/`, preserving the client's own
 * (inconsistent - e.g. real Elan ships `elan.bsp` but `Elan.ebp`) casing,
 * fetched case-insensitively the same way particleSystem.ts's Chef/ loader
 * already does for its own `.r3m`/`.r3t` pairs (see
 * fetchChefAssetCaseInsensitive - generic despite living in glowEffect.ts).
 */

/** Matches the backend's own MAP_ROOT_PATH default (see docs/map.md) - used only as a client-side fallback name when GET /map itself can't be reached, so map geometry (a pure static-asset concern, unlike gameplay) can still load without a running backend. */
const DEFAULT_MAP_NAME = 'Elan';

const GAME_ASSETS_MAPS_BASE = '/game-assets/maps';

/** Debug-overlay marker radius, native RF units - tuned by eye against this project's own measured map/character scale (docs/rf-format-notes.md: a sword blade is ~28 raw units), not any real in-game marker size. */
const DEBUG_MARKER_RADIUS = 30;
const PORTAL_MARKER_COLOR = 0x38bdf8;
const MONSTER_SPAWN_MARKER_COLOR = 0xf43f5e;
const SOUND_ENTITY_MARKER_COLOR = 0x9c62ea;
/** Translucent red - the common game-dev convention for "this is a blocking volume," distinct from both the real map's own materials and the portal/spawn/sound markers above. */
const COLLISION_WALL_COLOR = 0xff3355;
const COLLISION_WALL_OPACITY = 0.35;

export interface LoadedMap {
  name: string;
  object3D: Group;
  /** World-space (native RF units, unconverted scale - see bsp.ts's own doc comment) bounds of the loaded geometry, or null if the map had no renderable faces at all. */
  bounds: Box3 | null;
  /** From GET /map's own `warnings` (dev diagnostics) - see docs/map.md. Empty if the backend fetch failed (see DEFAULT_MAP_NAME's own doc comment) rather than the map genuinely having none. */
  warnings: string[];
  portals: MapPortal[];
  monsterSpawns: MapMonsterSpawn[];
  soundEntities: MapSoundEntity[];
  /** Debug markers for portals/monsterSpawns/soundEntities (see docs/map.md's "Development Checklist") - a sibling Group to `object3D`, not a child of it, so a caller that only wants the real geometry can ignore it. Always present (possibly empty) even when the GET /map fetch itself failed. */
  debugOverlay: Group;
  /** The map's own `.ebp` collision walls (see ebp.ts) rendered as translucent red quads - the same native data the backend's own movement collision (rfworld's internal/worldmap/collision.go) enforces, made visible for debugging "why did/didn't I stop here". A sibling to `object3D`/`debugOverlay`, not a child of either. Always present (possibly empty) even if the `.ebp` fetch/parse failed - see loadMapUncached's own handling. */
  collisionOverlay: Group;
}

function vec3ToTuple(v: MapVec3): [number, number, number] {
  return [v.x, v.y, v.z];
}

/** One reusable geometry/material per marker category - three.js instances, not per-marker allocations, matching every other shared-resource convention in this project (e.g. character.ts's pooled meshes/textures). Wireframe + no depth test-independent MeshBasicMaterial (not MeshStandardMaterial, which the real map geometry uses) so a marker reads clearly as a debug overlay, not part of the actual world. */
function createMarkerMaterial(color: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(color), wireframe: true, depthTest: false });
}

const markerGeometry = new SphereGeometry(DEBUG_MARKER_RADIUS, 12, 8);

/**
 * Builds the debug-overlay Group for one GET /map response - see
 * docs/map.md's "Development Checklist": "Add a debug overlay for portals,
 * monsterSpawns, and soundEntities" and "Use native RF position.x/y/z for
 * gameplay placement" (soundEntities' own `blenderPosition` is a debug/
 * asset-import-only field per that same doc - deliberately never read here).
 * A portal/monsterSpawn with no resolved `position` (both fields are
 * optional - see MapClient.ts) is silently skipped rather than defaulting
 * to the origin, which would misleadingly imply a real position.
 */
function buildDebugOverlay(portals: MapPortal[], monsterSpawns: MapMonsterSpawn[], soundEntities: MapSoundEntity[]): Group {
  const overlay = new Group();
  overlay.name = 'MapDebugOverlay';

  const portalMaterial = createMarkerMaterial(PORTAL_MARKER_COLOR);
  for (const portal of portals) {
    if (!portal.position) continue;
    const marker = new Mesh(markerGeometry, portalMaterial);
    marker.name = `Portal_${portal.name}`;
    marker.position.set(...vec3ToTuple(portal.position));
    overlay.add(marker);
  }

  const monsterSpawnMaterial = createMarkerMaterial(MONSTER_SPAWN_MARKER_COLOR);
  for (const spawn of monsterSpawns) {
    if (!spawn.position) continue;
    const marker = new Mesh(markerGeometry, monsterSpawnMaterial);
    marker.name = `MonsterSpawn_${spawn.name}`;
    marker.position.set(...vec3ToTuple(spawn.position));
    overlay.add(marker);
  }

  const soundEntityMaterial = createMarkerMaterial(SOUND_ENTITY_MARKER_COLOR);
  for (const [index, sound] of soundEntities.entries()) {
    const marker = new Mesh(markerGeometry, soundEntityMaterial);
    marker.name = `SoundEntity_${index}`;
    marker.position.set(...vec3ToTuple(sound.position));
    overlay.add(marker);
  }

  return overlay;
}

/**
 * Builds one merged, translucent Mesh from every parsed collision wall - a
 * quad per wall (start, end, and both points extruded by `height`), all in
 * a single non-indexed BufferGeometry so the whole overlay is one draw call
 * regardless of wall count (real Elan.ebp has ~5800 of them).
 *
 * Extrudes along +Y, not +Z: `ebp.ts`'s vertices are already converted to
 * three.js space (Y-up) via convertVec3Unity, but the reference addon's own
 * visualization (bsp.py) adds `height` to its own already-Blender-space
 * vertices' Z component (Blender's own up axis) - the three.js-space
 * equivalent of "up" is Y, so that's the axis this adds to here instead,
 * not a literal translation of the addon's own axis choice.
 *
 * Real wall heights (Elan: consistently 1000 native units) are far taller
 * than this project's own measured character scale (docs/rf-format-notes.md:
 * a sword is ~28 units) - this looks intentional on the native data's part
 * (a coarse "blocks regardless of vertical position" sentinel for the
 * server's own 2.5D collision check, not a literal rendered wall height),
 * so it's rendered as-is rather than clamped to something more
 * human-proportioned - a debug overlay should show what the data actually
 * says, not a prettied-up guess.
 */
function buildCollisionOverlay(walls: CollisionWall[]): Group {
  const overlay = new Group();
  overlay.name = 'MapCollisionOverlay';
  if (walls.length === 0) return overlay;

  const vertices = new Float32Array(walls.length * 6 * 3);
  let i = 0;
  for (const wall of walls) {
    const { start, end, height } = wall;
    const startX = start.x, startY = start.y, startZ = start.z;
    const endX = end.x, endY = end.y, endZ = end.z;
    const startUpY = startY + height;
    const endUpY = endY + height;

    // Two triangles: (start, end, endUp), (start, endUp, startUp).
    vertices[i++] = startX; vertices[i++] = startY; vertices[i++] = startZ;
    vertices[i++] = endX; vertices[i++] = endY; vertices[i++] = endZ;
    vertices[i++] = endX; vertices[i++] = endUpY; vertices[i++] = endZ;

    vertices[i++] = startX; vertices[i++] = startY; vertices[i++] = startZ;
    vertices[i++] = endX; vertices[i++] = endUpY; vertices[i++] = endZ;
    vertices[i++] = startX; vertices[i++] = startUpY; vertices[i++] = startZ;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();

  const material = new MeshBasicMaterial({
    color: new Color(COLLISION_WALL_COLOR),
    transparent: true,
    opacity: COLLISION_WALL_OPACITY,
    side: DoubleSide,
    depthWrite: false,
  });
  overlay.add(new Mesh(geometry, material));
  return overlay;
}

/**
 * Loads `mapName` (the backend's configured default when omitted - resolved
 * via GET /map, per docs/map.md's documented "current supported flow").
 * Geometry loading itself never depends on that fetch succeeding - a
 * failed/unreachable backend only means DEFAULT_MAP_NAME, no debug-overlay
 * markers, and no warnings, not a failed map load - but a failed *geometry*
 * fetch (missing/renamed asset files) does reject, same as any other
 * required asset in this project.
 *
 * Cached (including in-flight) by `mapName` for the lifetime of the page,
 * same pooling philosophy as character.ts's own race/mesh/texture caches
 * (never invalidated - there's only ever one map worth loading right now) -
 * this is what makes CharacterSelectScreen's own "predownload" call and
 * OnlineScene's later real call share one download+parse+decode instead of
 * paying for the ~70MB Elan asset trio twice. Every real caller today omits
 * `mapName` (there's exactly one map), so this doesn't handle mixing an
 * explicit name with an omitted one for what's actually the same map -
 * same caveat MapClient.ts's own getMapDetails cache documents.
 */
export function loadMap(mapName?: string): Promise<LoadedMap> {
  const cacheKey = mapName ?? '';
  let cached = loadMapCache.get(cacheKey);
  if (!cached) {
    cached = loadMapUncached(mapName);
    loadMapCache.set(cacheKey, cached);
    cached.catch(() => {
      loadMapCache.delete(cacheKey);
    });
  }
  return cached;
}

const loadMapCache = new Map<string, Promise<LoadedMap>>();

async function loadMapUncached(mapName?: string): Promise<LoadedMap> {
  let resolvedName = mapName ?? DEFAULT_MAP_NAME;
  let warnings: string[] = [];
  let portals: MapPortal[] = [];
  let monsterSpawns: MapMonsterSpawn[] = [];
  let soundEntities: MapSoundEntity[] = [];
  try {
    const details = await getMapDetails(mapName);
    resolvedName = details.name;
    warnings = details.warnings ?? [];
    portals = details.portals;
    monsterSpawns = details.monsterSpawns;
    soundEntities = details.soundEntities;
  } catch (err) {
    console.warn(`GET /map failed - loading map geometry using the client-side default name "${resolvedName}" instead:`, err);
  }

  const dirUrl = `${GAME_ASSETS_MAPS_BASE}/${resolvedName}`;
  const [bspBuffer, r3mBuffer, r3tBuffer] = await Promise.all([
    fetchChefAssetCaseInsensitive(dirUrl, `${resolvedName}.bsp`),
    fetchChefAssetCaseInsensitive(dirUrl, `${resolvedName}.r3m`),
    fetchChefAssetCaseInsensitive(dirUrl, `${resolvedName}.r3t`),
  ]);

  const bspMesh = parseBsp(bspBuffer);
  const materials = parseR3M(r3mBuffer);
  const textures = parseR3T(r3tBuffer);

  // Separate try/catch from the bsp/r3m/r3t trio above - the collision
  // overlay is a debug nice-to-have (see buildCollisionOverlay's own doc
  // comment), not a requirement for the map to load at all, unlike the
  // real geometry those three represent.
  let collisionWalls: CollisionWall[] = [];
  try {
    const ebpBuffer = await fetchChefAssetCaseInsensitive(dirUrl, `${resolvedName}.ebp`);
    collisionWalls = parseEbpCollision(ebpBuffer).walls;
  } catch (err) {
    console.warn(`Failed to load collision overlay for map "${resolvedName}" (playing without it):`, err);
  }

  const textureCache = new Map<number, Texture | null>();
  const resolveTexture = (textureId: number | undefined): Texture | null => {
    if (!textureId || textureId <= 0) return null;
    let cached = textureCache.get(textureId);
    if (cached === undefined) {
      const entry = textures.get(textureId);
      cached = entry ? decodeRftTexture(entry.data) : null;
      textureCache.set(textureId, cached);
    }
    return cached;
  };

  const object3D = new Group();
  object3D.name = `Map_${resolvedName}`;
  const bounds = new Box3();
  let hasGeometry = false;

  for (const group of bspMesh.groups) {
    if (group.vertices.length === 0) continue;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(group.vertices, 3));
    geometry.setAttribute('uv', new BufferAttribute(group.uvs, 2));
    // BSP faces carry no stored normals (see bsp.ts's own doc comment) and
    // this project doesn't merge duplicate vertices the way the reference
    // addon's own `remove_doubles` + `shade_smooth` does before export, so
    // this yields flat per-triangle shading rather than smoothly-blended
    // normals - an accepted, visible-but-not-broken gap for this first
    // pass (a real duplicate-vertex weld pass is future work if the
    // faceting turns out to matter visually).
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    if (geometry.boundingBox) bounds.union(geometry.boundingBox);
    hasGeometry = true;

    const material = materials[group.materialId];
    const texture = resolveTexture(material?.textureLayers[0]?.textureId);
    const mesh = new Mesh(
      geometry,
      new MeshStandardMaterial({
        map: texture,
        color: texture ? 0xffffff : 0xcccccc,
        side: DoubleSide,
        ...materialAlphaOptions(texture),
      }),
    );
    mesh.name = material?.name ?? `material_${group.materialId}`;
    object3D.add(mesh);
  }

  return {
    name: resolvedName,
    object3D,
    bounds: hasGeometry ? bounds : null,
    warnings,
    portals,
    monsterSpawns,
    soundEntities,
    debugOverlay: buildDebugOverlay(portals, monsterSpawns, soundEntities),
    collisionOverlay: buildCollisionOverlay(collisionWalls),
  };
}
