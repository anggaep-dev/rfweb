import { AdditiveBlending, ClampToEdgeWrapping, DataTexture, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, MeshMatcapMaterial, PlaneGeometry, RedFormat } from 'three';
import type { Material, MeshStandardMaterial, Object3D, SkinnedMesh, Texture } from 'three';
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
  /**
   * This section's own attachment-socket name (e.g. "EFFECT1"/"P02").
   * Confirmed to **exactly, case-insensitively name-match a real socket on
   * the weapon's own .msh** (see CharacterController.
   * getEquippedWeaponEffectSockets/getEquippedWeaponParticleSockets):
   * "Man Eater"'s own `.eff` (`Unick_TSWORDlv1.EFF`) has 5 sections
   * labeled "EFFECT1"/"EFFECT2"/"P01"/"P02"/"P03", exactly matching
   * `COM_WEAPON_TSWORD_003.msh`'s own 5 sockets of those same names. Use
   * this to pick the *specific* socket a section belongs to instead of
   * guessing by array order (see pairSectionsToSockets) - a real fix, not
   * a heuristic, once this field is present and matches a real socket
   * name. This project originally reverse-engineered this field's offset
   * by byte analysis alone and called it "socketLabel"; a real binary
   * struct definition for this format (`eff.strs`, a community 010-editor-
   * style template, supplied directly by the user) independently confirms
   * the same offset and calls it "Particle_name" instead - both readings
   * describe the same real bytes, kept as `socketLabel` here since this
   * project only ever uses it to match sockets by name.
   */
  socketLabel: string | null;
  /**
   * 1-based indices into `Chef/Particle.ini`'s `[PARTICLEn]` blocks (see
   * resolveParticlePath) - any that resolve give a real `.spt` particle
   * path that should spawn at this section's own socket (socketLabel
   * above). Confirmed end-to-end on real data: `Unick_TSWORDlv1.EFF`'s
   * "EFFECT1"-labeled section has one nonzero id, 400, and
   * `Particle.ini`'s `PARTICLE400` block is literally
   * `Unick_up/C_W_TSWORD/400p.spt` - the exact file this project had
   * previously been hardcoding as an unconfirmed guess (see
   * resolveWeaponParticles). A section can carry up to 3 simultaneous ids
   * (confirmed on `Unick_DAXElv7.EFF`, whose "P01" section has 3 distinct
   * nonzero ids) - already filtered to just the nonzero ones, in field
   * order, duplicates included (not deliberately deduplicated - none seen
   * in a single section so far, but nothing here assumes uniqueness).
   */
  particleIds: number[];
}

const RECORD_SIZE = 176;
// Fixed absolute offsets within each 176-byte record, confirmed against a
// real binary struct definition (`eff.strs`, a community 010-editor-style
// template, supplied directly by the user) that independently re-derived
// this project's own earlier byte-analysis findings and named several
// fields this project's analysis alone hadn't identified (ParticleIDn,
// EntityID). Every field below is a FIXED-width slot at a FIXED offset
// regardless of neighboring fields' actual content length - this
// project's own earlier analysis had wrongly assumed the two texture-name
// fields "floated" based on each other's length (scanning for runs of
// printable ASCII and treating gaps as 0xCD padding to skip over); they
// don't - DDS1/DDS2/DDS_DIR are simply three adjacent 20-byte slots
// starting at 0x03, and the socket-name field (this project's own
// "socketLabel", `Particle_name` per the struct - see EffSection.
// socketLabel) is a fourth, independent 20-byte slot at 0x98. `EntityID`
// (u32 at 0x90) is confirmed real (nonzero on 152 of this project's own
// 1151 real .eff files, always on a section labeled "W00" - the weapon's
// own main mesh object, never on an effectN/P0N socket) but not modeled
// here - no consumer for it yet, revisit if a real feature needs it.
const DDS1_OFFSET = 0x03; // "surface effect" texture name - 20-byte slot
const DDS2_OFFSET = 0x17; // "glow effect" texture name - 20-byte slot
// DDS_DIR follows at 0x2b (20-byte slot, a literal ".\CHEF\TEX\"-style
// path prefix) - not read, Chef/Tex/ is already known.
const STRING_FIELD_SIZE = 20;
const SPEED_BYTE_OFFSET = 0x4e;
const MOVEMENT_BYTE_OFFSET = 0x53;
/** See EffSection.particleIds. */
const PARTICLE_ID_OFFSETS = [0x60, 0x70, 0x80] as const;
const SOCKET_LABEL_OFFSET = 0x98; // "Particle_name" per eff.strs - see EffSection.socketLabel

/** Reads a fixed-width string slot: ASCII up to the first NUL byte (or the full width if none), null for an empty/unused slot (starts with NUL). No scanning/padding-skip needed - every slot here is a real fixed-offset field, not a floating one (see the offset table's own doc comment above). */
function readFixedString(view: DataView, offset: number, length: number): string | null {
  let end = offset;
  const limit = offset + length;
  while (end < limit && view.getUint8(end) !== 0) end++;
  if (end === offset) return null;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, end - offset);
  return new TextDecoder('ascii').decode(bytes);
}

/** Parses one fixed-176-byte .eff record - see the offset table's doc comment above for how these fields were confirmed. */
function parseEffSection(buffer: ArrayBuffer, recordOffset: number): EffSection {
  const view = new DataView(buffer, recordOffset, RECORD_SIZE);

  return {
    surfaceTexture: readFixedString(view, DDS1_OFFSET, STRING_FIELD_SIZE),
    glowTexture: readFixedString(view, DDS2_OFFSET, STRING_FIELD_SIZE),
    speedByte: view.getUint8(SPEED_BYTE_OFFSET),
    movementMode: view.getUint8(MOVEMENT_BYTE_OFFSET),
    socketLabel: readFixedString(view, SOCKET_LABEL_OFFSET, STRING_FIELD_SIZE),
    particleIds: PARTICLE_ID_OFFSETS.map((offset) => view.getUint32(offset, true)).filter((id) => id !== 0),
  };
}

/** Parses a .eff file - one or more fixed-176-byte sections concatenated (multi-part weapons have one section per attachment point). */
export function parseEffFile(buffer: ArrayBuffer): EffSection[] {
  const sections: EffSection[] = [];
  for (let offset = 0; offset + RECORD_SIZE <= buffer.byteLength; offset += RECORD_SIZE) {
    const view = new DataView(buffer, offset, 2);
    if (view.getUint16(0, true) !== RECORD_SIZE) continue; // not a recognized record header - skip rather than throw, this format isn't fully understood
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

/**
 * Fetches one URL, treating it as a miss (returns null instead of the
 * response) rather than throwing on either failure signature actually seen
 * for a case-mismatched Chef/Tex filename:
 * - A real static host: a plain 404 (`!res.ok`).
 * - Vite's own dev server: worse - its static middleware does a
 *   case-SENSITIVE lookup regardless of the underlying OS (confirmed:
 *   requesting the real, on-disk "env_t10.dds" as "ENV_T10.DDS" gets a
 *   `200 OK` back, but it's the SPA's own `index.html` fallback page, not
 *   the texture), so `!res.ok` alone never catches this case in dev -
 *   checking the content-type for "text/html" does.
 */
async function fetchChefAssetOrNull(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  if ((res.headers.get('content-type') ?? '').includes('text/html')) return null;
  return res.arrayBuffer();
}

/**
 * Fetches a Chef/-relative asset, retrying with the requested filename's
 * all-lowercase and all-uppercase spellings if the exact case given 404s
 * (or - see fetchChefAssetOrNull - looks like Vite's dev-server SPA
 * fallback instead of a real miss). Real on-disk Chef/Tex casing is a
 * genuine mix (confirmed: 101 of 224 files under Chef/Tex have at least
 * one uppercase letter, e.g. "55SHIELD_BC.dds", so a blanket
 * `.toLowerCase()` isn't safe) while `.eff`/`.mst` files reference
 * textures using whatever casing the original artist happened to type
 * (confirmed: a real `.eff` references "ENV_T10.DDS", but the actual file
 * is "env_t10.dds") - exact case is tried first (correct and fastest for
 * the common case where they already match), falling back to the two
 * blanket spellings only when that misses.
 */
export async function fetchChefAssetCaseInsensitive(dirUrl: string, filename: string): Promise<ArrayBuffer> {
  const exact = await fetchChefAssetOrNull(`${dirUrl}/${filename}`);
  if (exact) return exact;

  for (const candidate of [filename.toLowerCase(), filename.toUpperCase()]) {
    if (candidate === filename) continue;
    const hit = await fetchChefAssetOrNull(`${dirUrl}/${candidate}`);
    if (hit) return hit;
  }

  throw new Error(`Failed to fetch ${dirUrl}/${filename} (tried exact, lowercase, and uppercase casing)`);
}

const chefTextureCache = new Map<string, Promise<Texture | null>>();

/** Chef/Tex textures are plain, unencrypted DDS (verified - no .RFT-style XOR header here), so this reuses decodeRftTexture purely for its "already-DDS passthrough + S3TC-fallback" behavior, not its decryption. Shared by both effect kinds below (glow overlays and surface shine), keyed by filename regardless of which one's using it. */
function loadChefTexture(textureName: string): Promise<Texture | null> {
  let cached = chefTextureCache.get(textureName);
  if (!cached) {
    cached = fetchChefAssetCaseInsensitive(`${CHEF_BASE}/Tex`, textureName)
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
  /** The resolved .eff path this came from, or null for the common "no registered effect" case - debug display only (WeaponEditPanel). */
  effPath: string | null;
  /** The specific .eff section (of possibly several - see EffSection) whose glowTexture was actually used - debug display only. */
  section: EffSection | null;
}

const EMPTY_GLOW_OVERLAY: GlowOverlay = { objects: [], scrollingMaterials: [], effPath: null, section: null };

/**
 * Builds a glow overlay for an already-built, already-attached equipped
 * part: one additively-blended sibling mesh per renderable object in
 * `sourceObjects`, sharing geometry (and, for skinned meshes, the same
 * skeleton) so it deforms identically to the part it's glowing on top of.
 * Returns an empty overlay (not null) when the item has no registered
 * glow effect or its .eff has no usable texture - callers can treat "no
 * glow" and "glow with zero sections" the same way.
 */
export async function buildGlowOverlay(modelId: string, sourceObjects: Object3D[], upgradeLevel = 0): Promise<GlowOverlay> {
  const effPath = await resolveGlowEffectPath(modelId, upgradeLevel);
  if (!effPath) return EMPTY_GLOW_OVERLAY;

  const sections = await loadEffFile(effPath);
  const glowSection = sections.find((s) => s.glowTexture);
  if (!glowSection?.glowTexture) return EMPTY_GLOW_OVERLAY;

  const texture = await loadChefTexture(glowSection.glowTexture);
  if (!texture) return EMPTY_GLOW_OVERLAY;

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

  return { objects, scrollingMaterials, effPath, section: glowSection };
}

/** Disposes a glow overlay's own meshes/materials (not the shared geometry/texture, which belong to the source objects and texture cache respectively). */
export function disposeGlowOverlay(overlay: GlowOverlay): void {
  for (const obj of overlay.objects) {
    obj.parent?.remove(obj);
    const mesh = obj as Mesh;
    (mesh.material as Material | undefined)?.dispose();
  }
}

/** Three.js units - a real point-glow needs to actually read against a full weapon at normal camera distance, not disappear into it. */
const SOCKET_GLOW_SIZE = 0.5;

let socketGlowRadialMask: DataTexture | null = null;

/**
 * A soft round falloff (opaque white center fading to transparent black at
 * the corners), used as every socket-glow billboard's alphaMap - see
 * buildSocketGlow. Not every real glow texture is authored as a "black
 * background, additive-safe" sprite the way a weapon's own effectN glow
 * often is (confirmed: `Chef/Tex/env_t01.dds`, TSWORD's real glow, is a
 * clean fire-ring on pure black; `Chef/Tex/recall02.dds`, "The End"
 * (COM_WEAPON_DAXE)'s real glow per its own real `.eff` data, is a filled
 * reddish "portal plate" with fully opaque (255) alpha and no near-black
 * margin at all) - additively blending the latter onto a flat quad shows
 * the whole square as a visible, hard-edged patch instead of a clean aura.
 * This mask hides that square silhouette regardless of what the source
 * texture's own edges look like, without needing to special-case textures
 * by name or alpha content; it only ever dims edges further, so it doesn't
 * regress already-clean sprites like env_t01.dds.
 */
function getSocketGlowRadialMask(): DataTexture {
  if (socketGlowRadialMask) return socketGlowRadialMask;

  const size = 32;
  const data = new Uint8Array(size * size);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      data[y * size + x] = Math.round(255 * (1 - dist) ** 2);
    }
  }

  const texture = new DataTexture(data, size, size, RedFormat);
  texture.needsUpdate = true;
  socketGlowRadialMask = texture;
  return texture;
}

export interface SocketGlow {
  /** One additively-blended billboard quad per matched socket - see buildSocketGlow. */
  objects: Mesh[];
  /** Parallel to `objects` - non-null entries are the ones whose section used movementMode 2 (scrolling), same convention as GlowOverlay.scrollingMaterials - see updateSocketGlowBillboards in the controller, which reuses the exact same speed-byte decode as the whole-mesh path. Most sockets don't scroll (null), matching how most .eff sections checked so far don't either. */
  speedBytes: (number | null)[];
}

const EMPTY_SOCKET_GLOW: SocketGlow = { objects: [], speedBytes: [] };

/**
 * Pairs `.eff` sections to live weapon sockets by name first - each
 * section's own socketLabel (see EffSection.socketLabel) matched
 * case-insensitively against a real socket's `Object3D.name` - falling
 * back to plain array order for whichever sections/sockets are left once
 * every name match is resolved (a section with no label, or one whose
 * label doesn't match any live socket on this weapon, e.g. "Man Eater"'s
 * own main glow record). Shared by buildSocketGlow (glow-bearing sections)
 * and resolveWeaponParticles (particle-bearing sections) - same real
 * mechanism, different section filter/consumer.
 */
function pairSectionsToSockets<T extends { socketLabel: string | null }>(
  sockets: Object3D[],
  sections: T[],
): { section: T; socket: Object3D }[] {
  const socketByName = new Map(sockets.map((socket) => [socket.name.toLowerCase(), socket] as const));
  const usedSockets = new Set<Object3D>();
  const pairs: { section: T; socket: Object3D }[] = [];

  for (const section of sections) {
    const label = section.socketLabel?.toLowerCase();
    const matched = label ? socketByName.get(label) : undefined;
    if (matched && !usedSockets.has(matched)) {
      pairs.push({ section, socket: matched });
      usedSockets.add(matched);
    }
  }

  const remainingSockets = sockets.filter((socket) => !usedSockets.has(socket));
  const remainingSections = sections.filter((section) => !pairs.some((pair) => pair.section === section));
  const fallbackCount = Math.min(remainingSockets.length, remainingSections.length);
  for (let i = 0; i < fallbackCount; i++) {
    pairs.push({ section: remainingSections[i], socket: remainingSockets[i] });
  }

  return pairs;
}

/**
 * Builds a small glow billboard at each of a weapon's own "effectN"
 * attachment sockets (see CharacterController.getEquippedWeaponEffectSockets),
 * one per registered .eff section that actually carries a glowTexture -
 * confirmed on a real multi-record file (`COM_WEAPON_TMACE_144_1.EFF`, 3
 * records: one empty placeholder, two with independent surface+glow
 * textures) that a multi-socket weapon really does carry one independent
 * glow per attachment point, not just one shared surface-wide aura.
 *
 * Sockets and glow-bearing sections are paired by name first: each
 * section's own internal tail label (EffSection.socketLabel, read at fixed
 * offset 0x98) was confirmed against a real file+mesh pair
 * (`Unick_TSWORDlv1.EFF`'s 5 records = EFFECT1/EFFECT2/P01/P02/P03,
 * exactly matching `COM_WEAPON_TSWORD_003.msh`'s 5 real socket names,
 * case-insensitively) to genuinely be the socket this section belongs to -
 * not a loose ordering heuristic. Any section with no label, or whose
 * label doesn't match a live socket on this weapon (e.g. a weapon with
 * real glow texture data but no per-socket labels at all, like "Man
 * Eater"), falls back to being paired by plain array order against
 * whichever sockets/sections are left over once every name match is
 * resolved. Whichever list (sockets or glow-bearing sections) is shorter
 * determines how many billboards get built in total; any leftover sockets
 * are simply left unglowed.
 *
 * Unlike buildGlowOverlay's whole-mesh-surface aura, these billboards
 * aren't oriented at build time - CharacterController.
 * updateSocketGlowBillboards rotates each one to face the camera every
 * frame (the same "billboard" concept particleSystem.ts's ParticleEffect
 * already uses, just applied to a single always-additive quad instead of a
 * particle burst).
 */
export async function buildSocketGlow(modelId: string, sockets: Object3D[], upgradeLevel = 0): Promise<SocketGlow> {
  if (sockets.length === 0) return EMPTY_SOCKET_GLOW;

  const effPath = await resolveGlowEffectPath(modelId, upgradeLevel);
  if (!effPath) return EMPTY_SOCKET_GLOW;

  const sections = await loadEffFile(effPath);
  const glowSections = sections.filter((s): s is EffSection & { glowTexture: string } => !!s.glowTexture);
  if (glowSections.length === 0) return EMPTY_SOCKET_GLOW;

  const pairs = pairSectionsToSockets(sockets, glowSections);

  const objects: Mesh[] = [];
  const speedBytes: (number | null)[] = [];
  const geometry = new PlaneGeometry(SOCKET_GLOW_SIZE, SOCKET_GLOW_SIZE);
  for (const { section, socket } of pairs) {
    const texture = await loadChefTexture(section.glowTexture);
    if (!texture) continue;

    const material = new MeshBasicMaterial({
      map: texture,
      alphaMap: getSocketGlowRadialMask(),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    const quad = new Mesh(geometry, material);
    quad.name = `${socket.name}_socketGlow`;
    socket.add(quad);
    objects.push(quad);
    speedBytes.push(section.movementMode === 2 ? section.speedByte : null);
  }

  return { objects, speedBytes };
}

/** Disposes a socket glow's own billboard meshes/materials/geometry - every billboard built by one buildSocketGlow() call shares a single PlaneGeometry instance (own only by that call's result, not shared across different weapons/equips - see buildSocketGlow), so it's disposed once here rather than once per billboard. */
export function disposeSocketGlow(overlay: SocketGlow): void {
  overlay.objects[0]?.geometry.dispose();
  for (const obj of overlay.objects) {
    obj.parent?.remove(obj);
    (obj.material as Material).dispose();
  }
}

let particleIndexPromise: Promise<Map<number, string>> | null = null;

/**
 * `Chef/Particle.ini`'s own `[PARTICLEn]` blocks (`INDEX = n` /
 * `PARTICLE = <client path>`, one block per index, comments in Korean
 * elsewhere in the file - not needed here) - the table `EffSection.
 * particleIds` indexes into. `MAXPARTICLE=1174` in the file's own header
 * matches the highest real id seen across every `.eff` file in this
 * project (confirmed by scanning all 1151 real files), a good sanity
 * check that this is the right table and a 1-based, non-sparse indexing
 * scheme.
 */
function loadParticleIndex(): Promise<Map<number, string>> {
  if (!particleIndexPromise) {
    particleIndexPromise = fetchText(`${CHEF_BASE}/Particle.ini`).then((text) => {
      const map = new Map<number, string>();
      let pendingIndex: number | null = null;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        const indexMatch = /^INDEX\s*=\s*(\d+)/i.exec(line);
        if (indexMatch) {
          pendingIndex = Number.parseInt(indexMatch[1], 10);
          continue;
        }
        const particleMatch = /^PARTICLE\s*=\s*(\S+)/i.exec(line);
        if (particleMatch && pendingIndex !== null) {
          map.set(pendingIndex, particleMatch[1]);
          pendingIndex = null;
        }
      }
      return map;
    });
  }
  return particleIndexPromise;
}

/** Resolves one of EffSection.particleIds to its real client-relative `.spt` path, or null if this project's Particle.ini has no such index (shouldn't happen for a real id, but this table is community-sourced, not authoritative). */
export async function resolveParticlePath(index: number): Promise<string | null> {
  if (index === 0) return null;
  const map = await loadParticleIndex();
  return map.get(index) ?? null;
}

export interface WeaponParticleSpawn {
  /** The live weapon socket this particle should be parented to - see pairSectionsToSockets. */
  socket: Object3D;
  /** Client-relative `.spt` path (e.g. ".\Chef\Unick_up\C_W_TSWORD\400p.spt"), ready to hand to ParticleEffect.load. */
  sptPath: string;
}

/**
 * Resolves the equipped weapon's REAL per-socket particle data - see
 * EffSection.particleIds' own doc comment for how this was confirmed
 * end-to-end (a real .eff record's ParticleID pointing at a real
 * Particle.ini index, resolving to the exact .spt path this project had
 * previously been hardcoding as an unconfirmed guess for every weapon).
 * Reuses the same .eff resolution (resolveGlowEffectPath/loadEffFile) and
 * name-based socket pairing (pairSectionsToSockets) buildSocketGlow uses -
 * a section can be a particle carrier, a glow carrier, both, or neither,
 * independently. A weapon can carry more than one particle per socket
 * (see EffSection.particleIds) - every nonzero id on a matched section
 * becomes its own spawn entry sharing that socket. Returns an empty array
 * (not null) for the common case of a weapon with no registered particle
 * data at all.
 */
export async function resolveWeaponParticles(modelId: string, sockets: Object3D[], upgradeLevel = 0): Promise<WeaponParticleSpawn[]> {
  if (sockets.length === 0) return [];

  const effPath = await resolveGlowEffectPath(modelId, upgradeLevel);
  if (!effPath) return [];

  const sections = await loadEffFile(effPath);
  const particleSections = sections.filter((s) => s.particleIds.length > 0);
  if (particleSections.length === 0) return [];

  const pairs = pairSectionsToSockets(sockets, particleSections);
  const spawns: WeaponParticleSpawn[] = [];
  for (const { section, socket } of pairs) {
    for (const id of section.particleIds) {
      const sptPath = await resolveParticlePath(id);
      if (sptPath) spawns.push({ socket, sptPath });
    }
  }
  return spawns;
}

export interface SocketEffectSection {
  surfaceTexture: string | null;
  glowTexture: string | null;
  movementMode: number;
  speedByte: number;
  particleIds: number[];
}

export interface SocketEffectInfo {
  socketName: string;
  /** The resolved .eff path for the currently-equipped weapon, or null if it has no registered effect at all (see resolveGlowEffectPath). */
  effPath: string | null;
  /** Every section in that .eff whose own socketLabel exactly (case-insensitively) names this socket - see EffSection.socketLabel. Can be more than one (a socket can carry both a glow section and a separate particle-only section), or empty (this socket only gets a whole-mesh/array-order-fallback effect, not one addressed to it by name - see buildSocketGlow/resolveWeaponParticles's own fallback behavior, not reproducible here from just one socket's perspective). */
  sections: SocketEffectSection[];
  /** Every real .spt path resolved from every matched section's own particleIds (see resolveParticlePath) - flattened across sections, not one list per section. */
  particlePaths: string[];
}

/**
 * Debug-only: reports exactly what a single named socket on the
 * currently-equipped weapon resolves to in the `.eff` chain - which
 * section(s) explicitly target it by name, their glow/surface texture
 * names, and every real `.spt` particle path their own ParticleID fields
 * resolve to (see EffSection.socketLabel/particleIds for how this
 * mapping was confirmed real). Built for `%efedit`'s per-socket click
 * inspector (ViewerScene/CharacterController.getSocketDebugInfo) rather
 * than any rendering path - buildSocketGlow/resolveWeaponParticles above
 * do the real per-socket pairing (including the array-order fallback for
 * unlabeled sections) for actually building/spawning effects; this only
 * reports the *labeled* matches for one socket in isolation, for display.
 */
export async function describeSocketEffect(modelId: string, socketName: string, upgradeLevel = 0): Promise<SocketEffectInfo> {
  const effPath = await resolveGlowEffectPath(modelId, upgradeLevel);
  if (!effPath) return { socketName, effPath: null, sections: [], particlePaths: [] };

  const allSections = await loadEffFile(effPath);
  const matched = allSections.filter((s) => s.socketLabel?.toLowerCase() === socketName.toLowerCase());

  const particlePaths: string[] = [];
  for (const section of matched) {
    for (const id of section.particleIds) {
      const sptPath = await resolveParticlePath(id);
      if (sptPath) particlePaths.push(sptPath);
    }
  }

  return {
    socketName,
    effPath,
    sections: matched.map((s) => ({
      surfaceTexture: s.surfaceTexture,
      glowTexture: s.glowTexture,
      movementMode: s.movementMode,
      speedByte: s.speedByte,
      particleIds: s.particleIds,
    })),
    particlePaths,
  };
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
export async function applySurfaceShine(modelId: string, sourceObjects: Object3D[], upgradeLevel = 0): Promise<boolean> {
  const effPath = await resolveGlowEffectPath(modelId, upgradeLevel);
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
