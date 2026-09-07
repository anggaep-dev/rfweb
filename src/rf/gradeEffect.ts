import { AdditiveBlending, Color, DoubleSide, Matrix4, MeshBasicMaterial, SRGBColorSpace } from 'three';
import type { Material, Mesh, Object3D, SkinnedMesh, Texture } from 'three';
import { parseMaterialScript } from './materialScript';
import type { MaterialLayer, MaterialScript } from './materialScript';
import { decodeRftTexture } from './texture';

// SkinnedMesh.bind() only ever reads from the bindMatrix it's given, so this
// one instance is safe to reuse for every grade overlay mesh bound here -
// same reasoning as glowEffect.ts's own copy (kept separate rather than
// shared, per this project's existing convention of self-contained rf/*.ts
// effect modules).
const IDENTITY_MATRIX = new Matrix4();

const CHEF_BASE = '/game-assets/Chef';
const GRADE_EFFECT_BASE = `${CHEF_BASE}/GradeEffect`;

/**
 * weaponItem.json's "Grade" field (0-9 seen across the real data) selects a
 * cosmetic overlay from Chef/GradeEffect/ - but only grades 1-4 have a real
 * file there (Agrade/Bgrade/Cgrade/Dgrade, one `.mst` + `.dds` pair each;
 * grade 0 is "Common", no overlay at all). Grades 5-9 are rarer named
 * unique weapons (e.g. "Archon's Authority") that don't reach any
 * GradeEffect file - they likely get their own effect through the regular
 * ItemEffectList->EffectFileList->.eff chain (glowEffect.ts) instead, not
 * this mechanism; unconfirmed, out of scope for now (see docs/rf-format-
 * notes.md's weapon-grade-overlay section - "we start from here").
 */
const GRADE_LETTERS = ['A', 'B', 'C', 'D'];

function gradeLetter(grade: number | undefined): string | null {
  if (grade === undefined || !Number.isInteger(grade) || grade < 1 || grade > GRADE_LETTERS.length) return null;
  return GRADE_LETTERS[grade - 1];
}

const materialScriptCache = new Map<string, Promise<MaterialScript | null>>();

/**
 * Cached by grade letter, shared across every weapon of that grade - never
 * mutate a resolved MaterialLayer in place (see GradeOverlay.layer's doc
 * comment on why live edits go through a separate, per-overlay copy
 * instead).
 */
function loadGradeMaterialScript(letter: string): Promise<MaterialScript | null> {
  let cached = materialScriptCache.get(letter);
  if (!cached) {
    const url = `${GRADE_EFFECT_BASE}/${letter}grade.mst`;
    cached = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
      // Real .mst files carry a Korean comment line and are EUC-KR encoded,
      // not utf-8/ascii - see materialScript.ts's own doc comment.
      .then((buffer) => parseMaterialScript(new TextDecoder('euc-kr').decode(buffer)))
      .catch((err: unknown) => {
        console.warn(`Failed to load/parse grade material script "${url}":`, err);
        return null;
      });
    materialScriptCache.set(letter, cached);
  }
  return cached;
}

const gradeTextureCache = new Map<string, Promise<Texture | null>>();

/** Chef/GradeEffect textures are plain, unencrypted DDS, same as Chef/Tex (see glowEffect.ts's loadChefTexture) - decodeRftTexture is reused purely for its already-DDS passthrough + S3TC-fallback behavior, not decryption. */
function loadGradeTexture(letter: string): Promise<Texture | null> {
  let cached = gradeTextureCache.get(letter);
  if (!cached) {
    const url = `${GRADE_EFFECT_BASE}/${letter}grade.dds`;
    cached = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => decodeRftTexture(buffer))
      .catch((err: unknown) => {
        console.warn(`Failed to load grade texture "${url}":`, err);
        return null;
      });
    gradeTextureCache.set(letter, cached);
  }
  return cached;
}

export function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/**
 * The subset of a grade's .mst layer that's actually rendered right now
 * (see buildGradeOverlay's doc comment on which fields aren't yet wired to
 * anything) - a plain, mutable, per-overlay copy, never the shared/cached
 * MaterialLayer object itself (see GradeOverlay.layer's own doc comment).
 * This is what CharacterController.setWeaponGradeLiveValues edits and what
 * updateGradeAnimation reads every frame - editing it takes effect
 * immediately, no rebuild/re-fetch needed, since it's the same object the
 * running animation loop already holds a reference to.
 *
 * Semantics for the alpha-flicker fields are an educated guess, not
 * confirmed against any reference: no tutorial or prior research (see the
 * .eff/.spt sections in docs/rf-format-notes.md) covers this key. Real
 * files only ever pair `ani_alpha_flicker_start`/`_end` with small values
 * (0-2) alongside a separately-specified base `alpha` (0-255) - too small
 * to be alpha values in their own right, so they're treated as multipliers
 * on the base alpha instead (0 = fades to fully transparent, 2 = brightens
 * to double the base, clamped to [0,1] either way), oscillating
 * sinusoidally at `aniAlphaFlicker`'s own value used directly as a
 * cycles/second rate - the same "reasonable-looking approximation, real
 * value not in this dataset" treatment this project already gives
 * RUN_SPEED_MULTIPLIER/BOOSTER_SPEED_MULTIPLIER/FLY_SPEED_MULTIPLIER in
 * CharacterController.ts.
 */
export interface GradeLiveValues {
  alpha: number;
  color: [number, number, number];
  /** Already a plain UV-units/second rate (see materialScript.ts's MaterialLayer.uvScrollU doc comment), unlike glowEffect.ts's exponential "speed byte". 0 means no scroll. */
  uvScrollU: number;
  uvScrollV: number;
  /** Cycles/second - 0 means no flicker (start/end become moot). */
  aniAlphaFlicker: number;
  aniAlphaFlickerStart: number;
  aniAlphaFlickerEnd: number;
}

export interface GradeOverlay {
  objects: Object3D[];
  /** Parallel to `objects` - the actual material CharacterController.updateGradeAnimation/setWeaponGradeLiveValues write to each frame/edit. */
  materials: MeshBasicMaterial[];
  /** Shared animation phase for the whole overlay (not per-material) - every sub-mesh's flicker is meant to pulse in sync, so one accumulator covers all of them. Mutated in place every frame by CharacterController.updateGradeAnimation. */
  phase: number;
  /** Which GradeEffect file this came from ("A"/"B"/"C"/"D"), or null for the common "no overlay" case - debug display only (WeaponEditPanel). */
  letter: string | null;
  /** The raw parsed .mst layer this overlay was built from - every field, including the ones not yet animated (uvEnv, the uvScale trio, uvRotate, the aniTexFrame pair - see buildGradeOverlay's doc comment). Read-only reference into the shared per-letter cache (see loadGradeMaterialScript) - never mutate this; live edits go through `liveValues` instead, a separate per-overlay copy. Debug display only. */
  layer: MaterialLayer | null;
  /** This overlay's current editable values (see GradeLiveValues) - starts as a copy of `layer`'s corresponding fields, then diverges via CharacterController.setWeaponGradeLiveValues. What rendering actually reads every frame. */
  liveValues: GradeLiveValues | null;
}

const EMPTY_OVERLAY: GradeOverlay = { objects: [], materials: [], phase: 0, letter: null, layer: null, liveValues: null };

/** Writes `values`' static (non-animated-per-frame) appearance - opacity and color - onto every one of `overlay`'s materials, and stores `values` as the overlay's new liveValues. Called once at build time and again on every CharacterController.setWeaponGradeLiveValues edit, for instant visual feedback without waiting for the next updateGradeAnimation tick. Doesn't touch uv scroll/flicker - those are read fresh from liveValues every frame by updateGradeAnimation instead, so there's nothing to "apply" for them ahead of time. */
export function applyGradeLiveValues(overlay: GradeOverlay, values: GradeLiveValues): void {
  overlay.liveValues = values;
  // See docs/rf-format-notes.md's "known bugs" entry on new Color(r,g,b)
  // treating its components as already-linear - RF's raw 0-255 bytes need
  // explicit sRGB conversion or the tint visibly shifts.
  const [r, g, b] = values.color;
  const color = new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
  const opacity = clamp01(values.alpha / 255);
  for (const material of overlay.materials) {
    material.color.copy(color);
    material.opacity = opacity;
  }
}

/**
 * Builds a weapon-grade cosmetic overlay (see GRADE_LETTERS's doc comment):
 * one additively-blended sibling mesh per renderable in `sourceObjects`,
 * same cloning technique as glowEffect.ts's buildGlowOverlay (skinned
 * meshes stay bound to the same skeleton via an identity bindMatrix; rigid
 * meshes get an identical local transform under the same parent). Returns
 * an empty overlay (not null) for grade 0/undefined or an unregistered
 * grade - callers can treat "no overlay" and "overlay with zero objects"
 * the same way.
 *
 * Only GradeLiveValues' fields (map/alpha/color, uv scroll, alpha flicker)
 * are actually rendered - `uvEnv`/`uvScale*`/`uvRotate`/`aniTexFrame*` are
 * parsed (see materialScript.ts) but not yet animated, a deliberate v1
 * simplification matching how glowEffect.ts's own movementMode 0/1/3/4
 * render as a static texture too. Still exposed on `layer` for debug
 * display (WeaponEditPanel) even though nothing reads them for rendering.
 */
export async function buildGradeOverlay(grade: number | undefined, sourceObjects: Object3D[]): Promise<GradeOverlay> {
  const letter = gradeLetter(grade);
  if (!letter) return EMPTY_OVERLAY;

  const [script, texture] = await Promise.all([loadGradeMaterialScript(letter), loadGradeTexture(letter)]);
  const layer = script?.layers[0];
  if (!layer || !texture) return EMPTY_OVERLAY;

  const liveValues: GradeLiveValues = {
    alpha: layer.alpha,
    color: layer.color,
    uvScrollU: layer.uvScrollU ?? 0,
    uvScrollV: layer.uvScrollV ?? 0,
    aniAlphaFlicker: layer.aniAlphaFlicker ?? 0,
    aniAlphaFlickerStart: layer.aniAlphaFlickerStart ?? 1,
    aniAlphaFlickerEnd: layer.aniAlphaFlickerEnd ?? 1,
  };

  const objects: Object3D[] = [];
  const materials: MeshBasicMaterial[] = [];

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
      });

      const isSkinned = (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh;
      let overlayMesh: Object3D;
      if (isSkinned) {
        const skinned = mesh as unknown as SkinnedMesh;
        const clone = new (skinned.constructor as new (...args: unknown[]) => SkinnedMesh)(mesh.geometry, material);
        clone.bind(skinned.skeleton, IDENTITY_MATRIX);
        overlayMesh = clone;
      } else {
        const clone = new (mesh.constructor as new (...args: unknown[]) => Mesh)(mesh.geometry, material);
        clone.position.copy(mesh.position);
        clone.quaternion.copy(mesh.quaternion);
        clone.scale.copy(mesh.scale);
        overlayMesh = clone;
      }
      overlayMesh.name = `${mesh.name}_grade`;
      mesh.parent?.add(overlayMesh);
      objects.push(overlayMesh);
      materials.push(material);
    });
  }

  const overlay: GradeOverlay = { objects, materials, phase: 0, letter, layer, liveValues: null };
  applyGradeLiveValues(overlay, liveValues);
  return overlay;
}

/** Disposes a grade overlay's own meshes/materials (not the shared geometry/texture, which belong to the source objects and texture cache respectively). */
export function disposeGradeOverlay(overlay: GradeOverlay): void {
  for (const obj of overlay.objects) {
    obj.parent?.remove(obj);
    const mesh = obj as Mesh;
    (mesh.material as Material | undefined)?.dispose();
  }
}
