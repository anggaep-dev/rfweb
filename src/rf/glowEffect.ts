import { AdditiveBlending, ClampToEdgeWrapping, DoubleSide, Matrix4, MeshBasicMaterial, MeshMatcapMaterial } from 'three';
import type { Material, Mesh, MeshStandardMaterial, Object3D, SkinnedMesh, Texture } from 'three';
import { decodeRftTexture } from './texture';

// SkinnedMesh.bind() only ever reads from the bindMatrix it's given, so
// this one instance is safe to reuse for every glow overlay mesh bound
// here - same reasoning as character.ts's own IDENTITY_MATRIX (kept
// separate rather than importing/exporting theirs, since sharing a mutable
// module-level object across unrelated files is more coupling than this
// needs for one constant).
const IDENTITY_MATRIX = new Matrix4();

const CHEF_BASE = '/game-assets/Chef';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

/**
 * The real client's item-id -> glow-effect lookup is a 4-table chain, all
 * plain tab-separated text files under Chef/ (not RFS archives):
 *
 *   ItemEffectList.txt: item Model id -> "effect index" (column 1)
 *   PatternList.txt: effect index (as a 0-based line number) -> one
 *     "final index" per upgrade-level bucket (10 columns: +0, +1..+3, +4,
 *     +5..+7, ...)
 *   EffectFileList.txt: final index (explicit id in column 0, NOT the
 *     line number - the file has real gaps/reordering) -> .eff file path
 *
 * Verified directly against this project's own Chef/ files (not just the
 * tutorial this was originally researched from) - e.g. weaponItem.json's
 * "A10300" (a dagger) resolves through this chain to
 * ".\Chef\EFF\BF\WPALL.EFF", a real file. Same mechanism works unchanged
 * for armor Model ids (plain small integers, e.g. "50200") - most of
 * helmetItem.json's Model ids are present in ItemEffectList.txt too.
 */
interface EffectTables {
  itemEffectIndex: Map<string, number>;
  /** patternList[i] = the 10 final-index columns for effect index i. */
  patternList: Map<number, number[]>;
  effectFilePath: Map<number, string>;
}

let effectTablesPromise: Promise<EffectTables> | null = null;

/**
 * Fields are usually tab-separated, but the source data isn't fully
 * consistent - at least one real ItemEffectList.txt row
 * ("A10366  265\t0\t0\t0\t0\t0") uses two literal spaces between its first
 * two fields instead of a tab. Splitting on any whitespace run handles
 * both without misreading that row's model id - none of these files'
 * actual field values (ids, indices, or the backslash-separated .eff
 * paths) contain internal whitespace, so this is safe.
 */
function parseTabbedLines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/));
}

async function loadEffectTables(): Promise<EffectTables> {
  if (!effectTablesPromise) {
    effectTablesPromise = Promise.all([
      fetchText(`${CHEF_BASE}/ItemEffectList.txt`),
      fetchText(`${CHEF_BASE}/PatternList.txt`),
      fetchText(`${CHEF_BASE}/EffectFileList.txt`),
    ]).then(([itemEffectText, patternText, effectFileText]) => {
      const itemEffectIndex = new Map<string, number>();
      for (const fields of parseTabbedLines(itemEffectText)) {
        const modelId = fields[0]?.trim();
        const index = Number.parseInt(fields[1] ?? '', 10);
        if (modelId && Number.isFinite(index)) itemEffectIndex.set(modelId, index);
      }

      // Each line's own first column repeats its 0-based line number in
      // every real file seen - keyed by that value anyway rather than
      // array position, in case some file's numbering ever has a gap
      // (EffectFileList.txt's does, so this isn't a safe assumption to
      // skip checking).
      const patternList = new Map<number, number[]>();
      parseTabbedLines(patternText).forEach((fields, lineIndex) => {
        const rowIndex = Number.parseInt(fields[0] ?? '', 10);
        const values = fields.slice(1).map((f) => Number.parseInt(f, 10));
        patternList.set(Number.isFinite(rowIndex) ? rowIndex : lineIndex, values);
      });

      const effectFilePath = new Map<number, string>();
      for (const fields of parseTabbedLines(effectFileText)) {
        const id = Number.parseInt(fields[0] ?? '', 10);
        const path = fields[1]?.trim();
        if (Number.isFinite(id) && path) effectFilePath.set(id, path);
      }

      return { itemEffectIndex, patternList, effectFilePath };
    });
  }
  return effectTablesPromise;
}

/**
 * Picks which of PatternList's 10 upgrade-level columns to use. The
 * tutorial's own real example only bothered distinguishing +0 / +1-3 / +4
 * / +5-7 (columns 0/1/4/5 by observed values), so that's what's
 * implemented; this project doesn't track item upgrade level yet anyway
 * (always +0) - kept as a parameter so that's a future one-line change,
 * not a redesign.
 */
function patternColumnForUpgradeLevel(upgradeLevel: number): number {
  if (upgradeLevel <= 0) return 0;
  if (upgradeLevel <= 3) return 1;
  if (upgradeLevel === 4) return 4;
  return 5;
}

/** Converts a Chef/-relative client path (backslashes, ".\Chef\...") into a fetchable URL under this project's public/game-assets/Chef/. */
function chefPathToUrl(clientPath: string): string {
  const normalized = clientPath.replace(/\\/g, '/').replace(/^\.?\/?Chef\/?/i, '');
  return `${CHEF_BASE}/${normalized}`;
}

/** Resolves an equipped item's Model id to its .eff file's client-relative path, or null if this item has no registered glow effect. */
export async function resolveGlowEffectPath(modelId: string, upgradeLevel = 0): Promise<string | null> {
  const tables = await loadEffectTables();
  const effectIndex = tables.itemEffectIndex.get(modelId);
  if (effectIndex === undefined) return null;

  const pattern = tables.patternList.get(effectIndex);
  if (!pattern) return null;
  const column = patternColumnForUpgradeLevel(upgradeLevel);
  const finalIndex = pattern[column] ?? pattern[0];
  if (!Number.isFinite(finalIndex) || finalIndex === 0) return null;

  return tables.effectFilePath.get(finalIndex) ?? null;
}

export interface EffSection {
  /** "Surface effect" texture name (e.g. shine/metal highlight) - how the item's own surface reflects light. Null if this section doesn't use one. */
  surfaceTexture: string | null;
  /** "Glow effect" texture name - the aura/glow overlay issued from the item. Null if this section doesn't glow. */
  glowTexture: string | null;
  /**
   * 0=static, 1=distortion cycle, 2=scrolling (most common - the two real
   * weapon .eff files checked while building this both used 2), 3=
   * distortion cycle (variant), 4=metallic sheen, 5+=static. Only 2
   * (scrolling) is actually animated by loadGlowOverlay below; the rest
   * render as a static glow texture - a deliberate v1 simplification, not
   * a parsing gap.
   */
  movementMode: number;
  /** Base 0x40 = normal speed; each +1 roughly doubles it (per the source tutorial - not independently re-verified byte-for-byte here). */
  speedByte: number;
}

const EFF_MAGIC = 0xb0;
/** Byte value the authoring tool's memory allocator fills unused/uninitialized struct tail bytes with (MSVC debug heap convention) - not real data, just padding to skip over while scanning for the next string. */
const PADDING_BYTE = 0xcd;
/** Below this, a "printable ASCII run" is more likely coincidental padding bytes than an actual filename. */
const MIN_STRING_LENGTH = 4;
const RECORD_SIZE = 176;
// Fixed absolute offsets within each 176-byte record, verified against
// real files (both differ from the tutorial's own worked example, whose
// exact offsets turned out not to generalize - these were re-derived from
// this project's actual Chef/Eff/*.EFF files instead, byte-for-byte
// identical position across every sample checked regardless of how long
// the preceding filenames were, unlike the filename fields themselves).
const SPEED_BYTE_OFFSET = 0x4e;
const MOVEMENT_BYTE_OFFSET = 0x53;

/** Scans forward from `start` for the next NUL-terminated run of printable ASCII (a filename), skipping any 0xCD padding runs first. Returns the string and the offset just past its NUL terminator, or null if none found before `limit`. */
function readNextString(view: DataView, start: number, limit: number): { value: string; next: number } | null {
  let i = start;
  while (i < limit) {
    const byte = view.getUint8(i);
    if (byte === PADDING_BYTE || byte === 0) {
      i++;
      continue;
    }
    if (byte < 0x20 || byte > 0x7e) return null; // not printable ASCII - not a string field, stop scanning
    let end = i;
    while (end < limit && view.getUint8(end) >= 0x20 && view.getUint8(end) <= 0x7e) end++;
    const length = end - i;
    if (length < MIN_STRING_LENGTH) {
      i = end + 1;
      continue;
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset + i, length);
    return { value: new TextDecoder('ascii').decode(bytes), next: end + 1 };
  }
  return null;
}

/** Parses one fixed-176-byte .eff record. Only the two texture names plus the movement/speed bytes are extracted - see EffSection's doc comments for what's deliberately not modeled yet. */
function parseEffSection(buffer: ArrayBuffer, recordOffset: number): EffSection {
  const view = new DataView(buffer, recordOffset, RECORD_SIZE);
  const nameRegionEnd = 0x40; // numeric fields start here regardless of how much of the preceding region the names actually used

  let cursor = 0x03;
  const surface = readNextString(view, cursor, nameRegionEnd);
  let surfaceTexture: string | null = null;
  let glowTexture: string | null = null;
  // Defensive only: nameRegionEnd should already cut the scan off before
  // the literal ".\CHEF\TEX\" path prefix string that follows both name
  // fields in every real record seen - this guards against a filename
  // field being unexpectedly wide enough to swallow it.
  const looksLikePathPrefix = (s: string) => /CHEF/i.test(s);

  if (surface && !looksLikePathPrefix(surface.value)) {
    surfaceTexture = surface.value;
    cursor = surface.next;
    const glow = readNextString(view, cursor, nameRegionEnd);
    if (glow && !looksLikePathPrefix(glow.value)) glowTexture = glow.value;
  }

  return {
    surfaceTexture,
    glowTexture,
    speedByte: view.getUint8(SPEED_BYTE_OFFSET),
    movementMode: view.getUint8(MOVEMENT_BYTE_OFFSET),
  };
}

/** Parses a .eff file - one or more fixed-176-byte sections concatenated (multi-part weapons have one section per attachment point). */
export function parseEffFile(buffer: ArrayBuffer): EffSection[] {
  const sections: EffSection[] = [];
  for (let offset = 0; offset + RECORD_SIZE <= buffer.byteLength; offset += RECORD_SIZE) {
    const view = new DataView(buffer, offset, 3);
    if (view.getUint8(0) !== EFF_MAGIC) continue; // not a recognized record header - skip rather than throw, this format isn't fully understood
    sections.push(parseEffSection(buffer, offset));
  }
  return sections;
}

const effFileCache = new Map<string, Promise<EffSection[]>>();

function loadEffFile(clientPath: string): Promise<EffSection[]> {
  let cached = effFileCache.get(clientPath);
  if (!cached) {
    const url = chefPathToUrl(clientPath);
    cached = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then(parseEffFile)
      .catch((err: unknown) => {
        console.warn(`Failed to load/parse glow effect file "${clientPath}":`, err);
        return [];
      });
    effFileCache.set(clientPath, cached);
  }
  return cached;
}

const chefTextureCache = new Map<string, Promise<Texture | null>>();

/** Chef/Tex textures are plain, unencrypted DDS (verified - no .RFT-style XOR header here), so this reuses decodeRftTexture purely for its "already-DDS passthrough + S3TC-fallback" behavior, not its decryption. Shared by both effect kinds below (glow overlays and surface shine), keyed by filename regardless of which one's using it. */
function loadChefTexture(textureName: string): Promise<Texture | null> {
  let cached = chefTextureCache.get(textureName);
  if (!cached) {
    const url = `${CHEF_BASE}/Tex/${textureName}`;
    cached = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => decodeRftTexture(buffer))
      .catch((err: unknown) => {
        console.warn(`Failed to load Chef/Tex texture "${textureName}":`, err);
        return null;
      });
    chefTextureCache.set(textureName, cached);
  }
  return cached;
}

export interface GlowOverlay {
  objects: Object3D[];
  /** Non-empty only when at least one section used movementMode 2 (scrolling) - see animateGlowOverlay in the controller. */
  scrollingMaterials: { material: MeshBasicMaterial; speedByte: number }[];
}

/**
 * Builds a glow overlay for an already-built, already-attached equipped
 * part: one additively-blended sibling mesh per renderable object in
 * `sourceObjects`, sharing geometry (and, for skinned meshes, the same
 * skeleton) so it deforms identically to the part it's glowing on top of.
 * Returns an empty overlay (not null) when the item has no registered
 * glow effect or its .eff has no usable texture - callers can treat "no
 * glow" and "glow with zero sections" the same way.
 */
export async function buildGlowOverlay(modelId: string, sourceObjects: Object3D[]): Promise<GlowOverlay> {
  const effPath = await resolveGlowEffectPath(modelId);
  if (!effPath) return { objects: [], scrollingMaterials: [] };

  const sections = await loadEffFile(effPath);
  const glowSection = sections.find((s) => s.glowTexture);
  if (!glowSection?.glowTexture) return { objects: [], scrollingMaterials: [] };

  const texture = await loadChefTexture(glowSection.glowTexture);
  if (!texture) return { objects: [], scrollingMaterials: [] };

  const objects: Object3D[] = [];
  const scrollingMaterials: { material: MeshBasicMaterial; speedByte: number }[] = [];

  for (const source of sourceObjects) {
    source.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;

      const material = new MeshBasicMaterial({
        map: texture,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        color: 0xffffff,
      });

      const isSkinned = (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh;
      let glowMesh: Object3D;
      if (isSkinned) {
        const skinned = mesh as unknown as SkinnedMesh;
        const clone = new (skinned.constructor as new (...args: unknown[]) => SkinnedMesh)(mesh.geometry, material);
        clone.bind(skinned.skeleton, IDENTITY_MATRIX);
        glowMesh = clone;
      } else {
        const clone = new (mesh.constructor as new (...args: unknown[]) => Mesh)(mesh.geometry, material);
        clone.position.copy(mesh.position);
        clone.quaternion.copy(mesh.quaternion);
        clone.scale.copy(mesh.scale);
        glowMesh = clone;
      }
      glowMesh.name = `${mesh.name}_glow`;
      mesh.parent?.add(glowMesh);
      objects.push(glowMesh);

      if (glowSection.movementMode === 2) scrollingMaterials.push({ material, speedByte: glowSection.speedByte });
    });
  }

  return { objects, scrollingMaterials };
}

/** Disposes a glow overlay's own meshes/materials (not the shared geometry/texture, which belong to the source objects and texture cache respectively). */
export function disposeGlowOverlay(overlay: GlowOverlay): void {
  for (const obj of overlay.objects) {
    obj.parent?.remove(obj);
    const mesh = obj as Mesh;
    (mesh.material as Material | undefined)?.dispose();
  }
}

/**
 * Applies a `.eff`'s "surface" effect (see EffSection's doc comment) - a
 * classic sphere-mapped shine texture (what three.js calls a "matcap": a 2D
 * texture sampled by view-space normal, baking in a fixed lit/reflective
 * look with no real lighting or geometry needed) that RF's original engine
 * projected onto an item's own surface for a cheap fake-metal/chrome look.
 * Confirmed against a real item (the Intense Beam Mace's registered
 * ".\Chef\Eff\Bb\MACE\MA_LV20.EFF" has a surfaceTexture, "ENV_Y_M.DDS", and
 * no glowTexture at all) - this is a genuinely separate mechanism from
 * buildGlowOverlay above, not a variant of it, and most weapons that read
 * as "glowing" in the original client turn out to use this one, not glow.
 *
 * Unlike buildGlowOverlay, this doesn't add any new geometry - it swaps
 * each source mesh's own material in place for a MeshMatcapMaterial that
 * keeps the mesh's existing base texture as `map` (so its actual surface
 * art still shows through) and adds the effect texture as `matcap`. That
 * means no separate caller-side disposal/bookkeeping is needed the way
 * GlowOverlay needs: the swapped material is owned by (and torn down with)
 * the mesh itself, exactly like its original material was - a caller only
 * needs to await this once, fire-and-forget, same as buildGlowOverlay.
 * Returns whether anything was actually applied (false for the common "no
 * registered effect" / "no surface section" / "texture failed to load"
 * cases), so a caller can tell "definitely did nothing" from "might still
 * be loading" if it cares to.
 */
export async function applySurfaceShine(modelId: string, sourceObjects: Object3D[]): Promise<boolean> {
  const effPath = await resolveGlowEffectPath(modelId);
  if (!effPath) return false;

  const sections = await loadEffFile(effPath);
  const shineSection = sections.find((s) => s.surfaceTexture);
  if (!shineSection?.surfaceTexture) return false;

  const matcap = await loadChefTexture(shineSection.surfaceTexture);
  if (!matcap) return false;
  // A matcap texture is sampled by view-space normal, always within [0,1] -
  // there's no legitimate case for it to tile, unlike this project's other
  // (UV-mapped) textures which default to RepeatWrapping (see texture.ts's
  // applyCommonTextureSettings).
  matcap.wrapS = ClampToEdgeWrapping;
  matcap.wrapT = ClampToEdgeWrapping;

  let applied = false;
  for (const source of sourceObjects) {
    source.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;

      const prevMaterial = mesh.material as MeshStandardMaterial;
      mesh.material = new MeshMatcapMaterial({
        map: prevMaterial.map,
        matcap,
        color: prevMaterial.color,
        side: prevMaterial.side,
      });
      prevMaterial.dispose(); // safe regardless of the shared `map` - Material.dispose() never touches its textures
      applied = true;
    });
  }
  return applied;
}
