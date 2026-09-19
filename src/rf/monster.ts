import { AnimationMixer } from 'three';
import type { AnimationClip, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Where converted monster `.glb`s are served from - see
 * scripts/monster_to_gltf.py / scripts/unpack_and_convert_monsters.py for how
 * they're produced. Local-only for now (`public/game-assets` is gitignored
 * game data, same as every other raw/converted asset category - see that
 * folder's own README), not yet on the real CDN weapon/character/cloak/
 * shield assets already moved to (see character.ts's RFS_CDN_ROOT) - this
 * constant is the one place to repoint once monster assets get uploaded
 * there too.
 */
const RFS_CDN_ROOT = (import.meta.env.VITE_RFS_CDN_URL as string | undefined) ?? 'https://rfscdn.ketikart.com/rfs';
const MONSTER_GLB_BASE = `${RFS_CDN_ROOT}/monster/glb`;

/**
 * A monster's own standalone rigged model - real glTF `skins`/animations,
 * unlike player equipment's rigid-parts-on-a-shared-skeleton `.glb`s (see
 * msh_to_gltf.py's own doc comment for why monsters don't need that
 * machinery): `template` is the loaded scene graph, kept pristine and never
 * added to a live scene directly - every spawned instance is a
 * SkeletonUtils.clone() of it (see instantiateMonster) so many copies of the
 * same monster can animate independently from one fetch/parse.
 */
export interface MonsterAsset {
  name: string;
  template: Object3D;
  clips: AnimationClip[];
}

export interface MonsterInstance {
  root: Object3D;
  mixer: AnimationMixer;
  clips: AnimationClip[];
}

let manifestPromise: Promise<string[]> | null = null;

/** Every successfully-converted monster stem (scripts/unpack_and_convert_monsters.py's own manifest.json) - for populating a searchable monster picker without hardcoding the list here. Cached for the lifetime of the page. */
export function loadMonsterManifest(): Promise<string[]> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${MONSTER_GLB_BASE}/manifest.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch monster manifest: ${res.status}`);
        return res.json() as Promise<string[]>;
      })
      .catch((err: unknown) => {
        manifestPromise = null; // let a later call retry instead of caching a permanent failure
        throw err;
      });
  }
  return manifestPromise;
}

const assetCache = new Map<string, Promise<MonsterAsset>>();
const glbLoader = new GLTFLoader();

/**
 * Fetches and parses one monster's `.glb` (cached per name - see
 * assetCache). Every real manifest stem is already upper-case (see
 * unpack_and_convert_monsters.py's collect_monster_stems), so `name` is
 * normalized to upper-case before both the cache lookup AND the fetch URL
 * itself - not just the cache key - since the file on disk really is named
 * e.g. "BLUEPIG.glb": a lower-case "%moncall 1 bluepig" typed straight into
 * the GM console would otherwise 404 on any case-sensitive host, even
 * though it happens to resolve locally on Windows' case-insensitive
 * filesystem.
 */
export function loadMonster(name: string): Promise<MonsterAsset> {
  const key = name.toUpperCase();
  let cached = assetCache.get(key);
  if (!cached) {
    cached = (async () => {
      const res = await fetch(`${MONSTER_GLB_BASE}/${key}.glb`);
      if (!res.ok) throw new Error(`Failed to fetch monster "${key}": ${res.status}`);
      const buffer = await res.arrayBuffer();
      const gltf = await glbLoader.parseAsync(buffer, '');
      return { name: key, template: gltf.scene, clips: gltf.animations };
    })();
    assetCache.set(key, cached);
  }
  return cached;
}

/**
 * Spawns one independent, animatable copy of an already-loaded monster
 * asset. Plain Object3D.clone() does not correctly re-bind a SkinnedMesh's
 * skeleton (every clone would share - and fight over - the same live bones),
 * so this uses three.js's own SkeletonUtils.clone, which rebuilds the bone
 * hierarchy and re-parents each cloned SkinnedMesh onto it. The returned
 * mixer is bound to this clone's own root, so playing a clip on it can never
 * affect any other instance (or the pristine template).
 */
export function instantiateMonster(asset: MonsterAsset): MonsterInstance {
  const root = cloneSkeleton(asset.template);
  const mixer = new AnimationMixer(root);
  return { root, mixer, clips: asset.clips };
}
