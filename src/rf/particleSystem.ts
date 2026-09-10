import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Frustum,
  InstancedMesh,
  InstancedBufferAttribute,
  Matrix4,
  Object3D,
  SRGBColorSpace,
  Sphere,
  Vector3,
} from 'three';
import type { Camera, Texture } from 'three';
import {
  attribute,
  buffer,
  float,
  instanceIndex,
  mix,
  modelViewMatrix,
  positionGeometry,
  radians,
  select,
  sin,
  cos,
  texture as sampleTexture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { InstancedMesh as WebGpuInstancedMesh, NodeBuilder } from 'three/webgpu';
import { convertVec3 } from './coords';
import { fetchChefAssetCaseInsensitive } from './glowEffect';
import { parseMaterialIndex, parseMaterialScript } from './materialScript';
import { parseParticleTemplate, resolveNumberOrRange } from './particleTemplate';
import type { NumberOrRange, ParticleTemplate } from './particleTemplate';
import { parseR3E } from './r3e';
import type { R3EMesh } from './r3e';
import { parseR3M } from './r3m';
import { parseR3T } from './r3t';
import { decodeRftTexture } from './texture';

const CHEF_BASE = '/game-assets/Chef';

/** Effects beyond this raw scene-space distance begin reducing their instance budget. The RF character/weapon assets are much larger than conventional three.js demo units, so this intentionally starts well outside normal close-up inspection range. */
const PARTICLE_LOD_FULL_DISTANCE = 80;
/** At this distance an effect has reached its smallest visible instance count. */
const PARTICLE_LOD_MIN_DISTANCE = 240;
const PARTICLE_LOD_MIN_INSTANCES = 4;
/** Effects whose emitter origin is farther than this from the camera are not rendered. */
const PARTICLE_RENDER_DISTANCE = 250;
/** A particle template can request far more copies than it needs to read as a continuous effect. This cap applies before distance LOD, with Van der Corput phases preserving coverage across the full lifetime. */
const PARTICLE_VISIBLE_INSTANCE_CAP = 12;
const PARTICLE_SCENE_INSTANCE_BUDGET = 600;
let particleVisibleInstanceCap = PARTICLE_VISIBLE_INSTANCE_CAP;
// Deterministic midpoint curves are the default performance mode. Besides
// being a useful visual baseline, identical templates now produce identical
// shader source and can share WebGL programs across effects/bots. The GM
// command `%particlerandom 1` restores RF-style random range sampling.
let particleRandomnessEnabled = false;

export function setParticleRandomnessEnabled(enabled: boolean): void {
  particleRandomnessEnabled = enabled;
}

/** ViewerScene divides this fixed scene-wide budget across active effects once per frame. */
export function setParticleEffectCountForBudget(effectCount: number): void {
  particleVisibleInstanceCap = effectCount > 0
    ? Math.max(PARTICLE_LOD_MIN_INSTANCES, Math.floor(PARTICLE_SCENE_INSTANCE_BUDGET / effectCount))
    : PARTICLE_VISIBLE_INSTANCE_CAP;
}

function resolveParticleNumber(range: NumberOrRange): number {
  return particleRandomnessEnabled ? resolveNumberOrRange(range) : (range.min + range.max) * 0.5;
}

function chefPathToUrl(clientPath: string): string {
  const normalized = clientPath.replace(/\\/g, '/').replace(/^\.?\/?Chef\/?/i, '');
  return `${CHEF_BASE}/${normalized}`;
}

/**
 * `MainMaterial.mst` (sibling to the entity file) maps a material slot id
 * to a named `.mst` file in the same folder, which itself names the
 * actual `map_name` texture - the material convention every *originally
 * loose* Chef/ entity uses (see materialScript.ts's module doc comment).
 * Throws (doesn't return null) when `MainMaterial.mst` itself can't be
 * found at all, so the caller can tell "no .mst here, try .r3m/.r3t
 * instead" apart from "a real .mst chain exists but resolved to nothing"
 * (still null, further down) - only entities that came from a
 * `Chef/ChefEntityN.rpk` archive lack `.mst` files entirely (confirmed:
 * scanning every real `.R3E` entity folder in this project, 577 of 712
 * have no `MainMaterial.mst` at all - exactly the rpk-sourced ones, see
 * scripts/extract_rpk.mjs).
 */
async function loadTextureFromMst(dirUrl: string, materialId: number): Promise<Texture | null> {
  const indexBuffer = await fetchChefAssetCaseInsensitive(dirUrl, 'MainMaterial.mst');
  const indexEntries = parseMaterialIndex(new TextDecoder('euc-kr').decode(indexBuffer));
  const entry = indexEntries.find((e) => e.slot === materialId);
  if (!entry) {
    console.warn(`No MainMaterial.mst slot ${materialId} at "${dirUrl}" - particle renders untextured (flat keyframe color).`);
    return null;
  }

  const materialBuffer = await fetchChefAssetCaseInsensitive(dirUrl, `${entry.name}.mst`);
  const script = parseMaterialScript(new TextDecoder('euc-kr').decode(materialBuffer));
  const mapName = script.layers[0]?.mapName;
  if (!mapName) {
    console.warn(`"${entry.name}.mst" at "${dirUrl}" has no map_name - particle renders untextured (flat keyframe color).`);
    return null;
  }

  const textureBuffer = await fetchChefAssetCaseInsensitive(dirUrl, mapName);
  return decodeRftTexture(textureBuffer);
}

/**
 * `.r3m`/`.r3t` (see r3m.ts/r3t.ts's own doc comments) - the material
 * convention a `Chef/ChefEntityN.rpk`-sourced entity uses instead of
 * `.mst`, sharing the entity's own file stem (e.g. "aura.R3E" pairs with
 * "aura.r3m"/"aura.r3t" in the same folder, not a fixed "MainMaterial"
 * name). `.r3t`'s embedded per-texture DDS data reuses decodeRftTexture
 * directly - its 128-byte header is "encrypted" with the exact same XOR
 * password this project's own `.RFT` character textures already use
 * (confirmed byte-exact - see r3t.ts).
 */
async function loadTextureFromR3mR3t(dirUrl: string, materialId: number, entityFileName: string): Promise<Texture | null> {
  const stem = entityFileName.replace(/\.[^./\\]+$/, '');

  const r3mBuffer = await fetchChefAssetCaseInsensitive(dirUrl, `${stem}.r3m`);
  const materials = parseR3M(r3mBuffer);
  const material = materials[materialId];
  const textureId = material?.textureLayers[0]?.textureId;
  if (!textureId || textureId <= 0) return null;

  const r3tBuffer = await fetchChefAssetCaseInsensitive(dirUrl, `${stem}.r3t`);
  const textures = parseR3T(r3tBuffer);
  const entry = textures.get(textureId);
  if (!entry) return null;

  return decodeRftTexture(entry.data);
}

/**
 * Resolves an `.R3E` entity's own real texture - tries the `.mst` chain
 * first (the common case for originally-loose entities), falling back to
 * `.r3m`/`.r3t` only when `MainMaterial.mst` itself doesn't exist at all
 * (see loadTextureFromMst/loadTextureFromR3mR3t's own doc comments for
 * why an entity only ever has one or the other, never both by accident -
 * `Chef/Unick_up/C_W_TSWORD/400p/aura.R3E` is a rare exception that
 * genuinely has both, used to verify the `.r3m`/`.r3t` reader against a
 * known-good `.mst`-resolved texture rather than trusting it blind).
 * Hardcoded to slot/material 0 - every real particle entity checked so
 * far is a single-material shape, so this doesn't yet handle a
 * multi-material entity picking a different texture per `R3EGroup.
 * materialId` (that data is parsed - see r3e.ts - just not consumed
 * per-group here yet). Returns null for the common "no material data at
 * all for this entity" case, same as every other best-effort Chef/
 * lookup in this codebase.
 */
async function loadR3EMaterialTexture(entityClientPath: string, materialId: number): Promise<Texture | null> {
  const normalized = entityClientPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dirUrl = chefPathToUrl(normalized.slice(0, lastSlash));
  const entityFileName = normalized.slice(lastSlash + 1);

  try {
    return await loadTextureFromMst(dirUrl, materialId);
  } catch {
    // No MainMaterial.mst at all - fall through to .r3m/.r3t below.
  }

  try {
    return await loadTextureFromR3mR3t(dirUrl, materialId, entityFileName);
  } catch (err) {
    console.warn(`Failed to load material texture for R3E entity "${entityClientPath}" (material ${materialId}):`, err);
    return null;
  }
}

const r3eMaterialTextureCache = new Map<string, Promise<Texture | null>>();

function loadR3EMaterialTextureCached(entityClientPath: string, materialId: number): Promise<Texture | null> {
  const key = `${entityClientPath}#${materialId}`;
  let cached = r3eMaterialTextureCache.get(key);
  if (!cached) {
    cached = loadR3EMaterialTexture(entityClientPath, materialId);
    r3eMaterialTextureCache.set(key, cached);
  }
  return cached;
}

export interface ParticleEntityDebugInfo {
  entityFile: string;
  material:
    | { kind: 'mst'; mstName: string; textureName: string | null }
    | { kind: 'r3m'; r3mName: string; textureName: string | null }
    | null;
}

/**
 * Debug-only: reports which material system (`.mst` or `.r3m`/`.r3t` -
 * see loadR3EMaterialTexture's own doc comment) a real `.spt`'s own
 * entity resolves through, and the real filenames involved - not decoded
 * textures, just names, for a human-readable inspector (see `%efedit`'s
 * per-socket click handler in ViewerScene/CharacterController.
 * getSocketDebugInfo). Mirrors loadR3EMaterialTexture's own mst-then-
 * r3m/r3t fallback exactly, but returns null (not a thrown error) for
 * "no material data at all" the same way that function does.
 */
export async function describeParticleEntity(sptPath: string): Promise<ParticleEntityDebugInfo | null> {
  const template = await loadParticleTemplate(sptPath);
  if (!template || !template.entityFile) return null;

  const normalized = template.entityFile.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dirUrl = chefPathToUrl(normalized.slice(0, lastSlash));
  const entityFileName = normalized.slice(lastSlash + 1);

  try {
    const indexBuffer = await fetchChefAssetCaseInsensitive(dirUrl, 'MainMaterial.mst');
    const indexEntries = parseMaterialIndex(new TextDecoder('euc-kr').decode(indexBuffer));
    const entry = indexEntries.find((e) => e.slot === 0);
    if (entry) {
      const mstName = `${entry.name}.mst`;
      const materialBuffer = await fetchChefAssetCaseInsensitive(dirUrl, mstName);
      const script = parseMaterialScript(new TextDecoder('euc-kr').decode(materialBuffer));
      return { entityFile: template.entityFile, material: { kind: 'mst', mstName, textureName: script.layers[0]?.mapName ?? null } };
    }
  } catch {
    // No MainMaterial.mst at all - fall through to .r3m/.r3t below.
  }

  try {
    const stem = entityFileName.replace(/\.[^./\\]+$/, '');
    const r3mName = `${stem}.r3m`;
    const r3mBuffer = await fetchChefAssetCaseInsensitive(dirUrl, r3mName);
    const materials = parseR3M(r3mBuffer);
    const textureId = materials[0]?.textureLayers[0]?.textureId;

    let textureName: string | null = null;
    if (textureId && textureId > 0) {
      const r3tBuffer = await fetchChefAssetCaseInsensitive(dirUrl, `${stem}.r3t`);
      textureName = parseR3T(r3tBuffer).get(textureId)?.name ?? null;
    }
    return { entityFile: template.entityFile, material: { kind: 'r3m', r3mName, textureName } };
  } catch {
    return { entityFile: template.entityFile, material: null };
  }
}

const r3eGeometryCache = new Map<string, Promise<BufferGeometry | null>>();

function loadR3EGeometry(clientPath: string): Promise<BufferGeometry | null> {
  let cached = r3eGeometryCache.get(clientPath);
  if (!cached) {
    // Case-insensitive, same reasoning as loadR3EMaterialTexture's own
    // .mst/texture lookups just below - a real `.spt`'s own `entity_file`
    // line can (and does) reference a different case than what's actually
    // on disk (confirmed: "aura.R3E" referenced, "aura.r3e" on disk, after
    // scripts/extract_rpk.mjs wrote every entity file's siblings with a
    // hardcoded-lowercase extension) - a plain fetch either 404s outright
    // or, on Vite's dev server, silently 200s with the SPA's own
    // index.html instead of a real error (see fetchChefAssetCaseInsensitive's
    // own doc comment).
    const normalized = clientPath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const dirUrl = chefPathToUrl(normalized.slice(0, lastSlash));
    const filename = normalized.slice(lastSlash + 1);
    cached = fetchChefAssetCaseInsensitive(dirUrl, filename)
      .then((buffer) => buildGeometry(parseR3E(buffer)))
      .catch((err: unknown) => {
        console.warn(`Failed to load particle entity mesh "${clientPath}":`, err);
        return null;
      });
    r3eGeometryCache.set(clientPath, cached);
  }
  return cached;
}

function buildGeometry(mesh: R3EMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.vertices, 3));
  geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

const templateCache = new Map<string, Promise<ParticleTemplate | null>>();

function loadParticleTemplate(sptPath: string): Promise<ParticleTemplate | null> {
  let cached = templateCache.get(sptPath);
  if (!cached) {
    // Case-insensitive for the same reason loadR3EGeometry just below is -
    // Chef/'s real on-disk casing doesn't always match whatever casing a
    // referencing file (here, Particle.ini) happens to use.
    const normalized = sptPath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const dirUrl = chefPathToUrl(normalized.slice(0, lastSlash));
    const filename = normalized.slice(lastSlash + 1);
    cached = fetchChefAssetCaseInsensitive(dirUrl, filename)
      .then((buffer) => parseParticleTemplate(new TextDecoder('latin1').decode(buffer)))
      .catch((err: unknown) => {
        console.warn(`Failed to load particle template "${sptPath}":`, err);
        return null;
      });
    templateCache.set(sptPath, cached);
  }
  return cached;
}

/** A single particle's own resolved (rand()-rolled once, not re-rolled every frame) keyframe curve - see the module doc comment on why this is per-template (shared by every instance of one ParticleTemplateBatch), not per-instance. */
interface ResolvedKeyframe {
  time: number;
  alpha: number;
  zrot: number;
  xrot: number;
  yrot: number;
  scale: number;
  color: Color;
  /** This keyframe's own drift velocity (`power`/`start_power`) - unlike every other field here, not read directly: it's integrated over time to get a position offset (see powerDisplacementAtStart and sampleKeyframes's own doc comment), since a velocity's effect accumulates rather than just holding/interpolating in place like alpha/scale/color do. */
  power: Vector3;
  /** Precomputed (once per resolveKeyframes call, not per frame) total displacement contributed by `power` from time 0 up through this keyframe's own time - see resolveKeyframes's second pass and sampleKeyframes's own doc comment for the closed-form trapezoidal integration this comes from. */
  powerDisplacementAtStart: Vector3;
}

/** RF's particle colors are plain 0-255 display-referred RGB bytes, same as any other color this project reads off disk - explicit SRGBColorSpace here matches texture.ts's own convention, rather than three.js's default of treating raw Color() components as already-linear (which visibly shifts the result - verified against a real file while building this). */
function colorFromRgb255(r: number, g: number, b: number): Color {
  return new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
}

/** Resolves a NumberOrRange triple into a real drift-velocity Vector3, going through the same 3ds-Max-to-three.js axis conversion (coords.ts's convertVec3) every other spatial value this project reads from Chef/'s binary formats (.msh/.bn/.ani) already goes through - .spt is plain text, not one of those, but it's authored by the same original toolchain for the same 3ds-Max-space scene, so the same conversion applies (confirmed: skipping it left a real weapon's own particle spawning ~28 raw units away from the weapon's own mesh entirely - see docs/rf-format-notes.md). */
function resolvePower(range: [NumberOrRange, NumberOrRange, NumberOrRange]): Vector3 {
  return convertVec3(resolveParticleNumber(range[0]), resolveParticleNumber(range[1]), resolveParticleNumber(range[2]));
}

function fixedNumberOrRange(n: number): NumberOrRange {
  return { min: n, max: n };
}

/** Debug-only live-editable subset of ParticleTemplate - see ParticleEffect.setLiveValues. Plain numbers, not the template's own NumberOrRange - editing away any rand() a field originally had, same simplification gradeEffect.ts's GradeLiveValues already makes for .mst values. */
export interface ParticleLiveValues {
  num: number;
  posBox: [number, number, number];
  gravity: [number, number, number];
  startPower: [number, number, number];
  startScale: number;
  startAlpha: number;
  startZRot: number;
  liveTime: number;
  timeSpeed: number;
}

function applyLiveValuePatch(template: ParticleTemplate, patch: Partial<ParticleLiveValues>): void {
  if (patch.num !== undefined) template.num = Math.max(0, Math.round(patch.num));
  if (patch.posBox) template.posBox = patch.posBox;
  if (patch.gravity) template.gravity = patch.gravity;
  if (patch.startPower) {
    template.startPower = [fixedNumberOrRange(patch.startPower[0]), fixedNumberOrRange(patch.startPower[1]), fixedNumberOrRange(patch.startPower[2])];
  }
  if (patch.startScale !== undefined) template.startScale = fixedNumberOrRange(patch.startScale);
  if (patch.startAlpha !== undefined) template.startAlpha = fixedNumberOrRange(patch.startAlpha);
  if (patch.startZRot !== undefined) template.startZRot = fixedNumberOrRange(patch.startZRot);
  if (patch.liveTime !== undefined) template.liveTime = patch.liveTime;
  if (patch.timeSpeed !== undefined) template.timeSpeed = patch.timeSpeed;
}

function resolveKeyframes(template: ParticleTemplate): ResolvedKeyframe[] {
  const start: ResolvedKeyframe = {
    time: 0,
    alpha: resolveParticleNumber(template.startAlpha),
    zrot: resolveParticleNumber(template.startZRot),
    xrot: resolveParticleNumber(template.startXRot),
    yrot: resolveParticleNumber(template.startYRot),
    scale: resolveParticleNumber(template.startScale),
    color: colorFromRgb255(...template.startColor),
    power: resolvePower(template.startPower),
    powerDisplacementAtStart: new Vector3(),
  };

  // A keyframe that omits an attribute means "hold whatever the previous
  // keyframe left it at" (see particleTemplate.ts's key reference) - a
  // single forward pass carrying the last-known value along does that
  // directly, starting from `start` for the first real keyframe.
  const resolved: ResolvedKeyframe[] = [start];
  let prev = start;
  for (const kf of template.keyframes) {
    const next: ResolvedKeyframe = {
      time: kf.time,
      alpha: kf.alpha ? resolveParticleNumber(kf.alpha) : prev.alpha,
      zrot: kf.zrot ? resolveParticleNumber(kf.zrot) : prev.zrot,
      xrot: kf.xrot ? resolveParticleNumber(kf.xrot) : prev.xrot,
      yrot: kf.yrot ? resolveParticleNumber(kf.yrot) : prev.yrot,
      scale: kf.scale ? resolveParticleNumber(kf.scale) : prev.scale,
      color: kf.color ? colorFromRgb255(...kf.color) : prev.color.clone(),
      power: kf.power ? resolvePower(kf.power) : prev.power.clone(),
      powerDisplacementAtStart: new Vector3(), // filled in below, once every keyframe's own `power` is known
    };
    resolved.push(next);
    prev = next;
  }

  // Second pass: `power` is a velocity, not a directly-held value, so its
  // effect on position accumulates over time rather than just holding in
  // place - see sampleKeyframes's own doc comment for the closed-form
  // math this implements (trapezoidal integration of a piecewise-linear
  // velocity curve).
  let cumulative = new Vector3();
  for (let i = 1; i < resolved.length; i++) {
    const prevKf = resolved[i - 1];
    const currKf = resolved[i];
    const dt = currKf.time - prevKf.time;
    const avgPower = prevKf.power.clone().add(currKf.power).multiplyScalar(0.5);
    cumulative = cumulative.clone().addScaledVector(avgPower, dt);
    currKf.powerDisplacementAtStart.copy(cumulative);
  }

  return resolved;
}

/** Conservative local-space bounds radius for one template's whole particle field, derived from its resolved keyframe curve (max scale/power reached over the curve) plus its (always fixed, never randomized - see particleTemplate.ts's posBox typing) spawn point. Shared by every member of a ParticleTemplateBatch using this template, since it depends only on template data, never on which socket an individual member is attached to. */
function computeLocalBoundsRadius(template: ParticleTemplate, geometry: BufferGeometry, keyframes: ResolvedKeyframe[]): number {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const shapeRadius = geometry.boundingSphere?.radius ?? 0;
  const liveTime = Math.max(template.liveTime, 1e-6);
  const gravity = convertVec3(template.gravity[0], template.gravity[1], template.gravity[2]);
  const spawnPos = convertVec3(template.posBox[0], template.posBox[1], template.posBox[2]);

  let maxScale = 0;
  let maxPowerSpeed = 0;
  for (const keyframe of keyframes) {
    maxScale = Math.max(maxScale, Math.abs(keyframe.scale));
    maxPowerSpeed = Math.max(maxPowerSpeed, keyframe.power.length());
  }

  // A particle can travel under both the constant gravity term and any
  // keyframed power velocity. Treating power as its maximum speed over
  // the full lifetime intentionally overestimates the bound, which is
  // exactly the safe direction for frustum culling.
  return spawnPos.length() + (gravity.length() + maxPowerSpeed) * liveTime + shapeRadius * maxScale;
}

/**
 * TSL (WebGPU/node-material) replacement for the old raw-GLSL `ShaderMaterial`
 * this project used under `WebGLRenderer` - `onBeforeCompile`/hand-written
 * GLSL strings don't run under `WebGPURenderer`'s node-based pipeline (see
 * this project's own WebGPU migration notes), so the whole per-template
 * keyframe generator had to be rebuilt as a node graph instead of a GLSL
 * string. One instance is still built per unique template (same reasoning
 * as before: identical templates produce an identical node graph and can
 * share a compiled program across every effect/bot using it), and the
 * keyframe constants are still baked in as literal nodes, not uniforms -
 * same "compact shader per template" shape as before, just node objects
 * instead of interpolated GLSL source.
 *
 * `setupPositionView` is overridden (same pattern three.js's own
 * `SpriteNodeMaterial` uses for its billboard case) because this vertex
 * pipeline is fundamentally custom, not a "displace the standard geometry
 * position" case `positionNode` alone could express: the base spawn/
 * gravity/power-drift position replaces `position` entirely, the instance
 * transform is applied explicitly (constructing the same buffer-backed
 * mat4 node three.js's own automatic InstancedMesh wiring would - see
 * `Instance.js`'s `createInstanceMatrixNode`, not exported publicly, so
 * reconstructed here for the common (non-huge-instance-count) case), and
 * the billboard offset is added in view space *after* that transform,
 * exactly mirroring the old GLSL's `mvPosition.xyz += particleVertex`.
 */
// TSL's node types are precise template-literal generics ("vec3", "float",
// ...) that don't compose cleanly through a shared generic helper (the
// `select()`/`mix()` chain below needs to work uniformly across float and
// vec3 fields) - three.js's own internal node-material source (e.g.
// SpriteNodeMaterial.js) is plain untyped JS for exactly this reason, not
// type-checked against these .d.ts files at all. Matching that reality
// here rather than fighting the generics: node composition below is typed
// as `AnyNode`, same runtime objects/API either way.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/**
 * Builds a right-to-left `select()` chain reproducing the old GLSL's
 * `if (age<t1) {...} else if (age<t2) {...} else {...}` age-branching -
 * starts from the last keyframe's flat value (the "else" case) and wraps
 * one more segment test around it per iteration, so the first matching
 * `age < keyframe.time` test (scanned in time order, same as the original
 * if/else-if chain) wins. `select()` evaluates both sides (it's a GPU
 * select, not a branch), which is fine here - every segment's own formula
 * is already O(1) thanks to `powerDisplacementAtStart` being precomputed
 * once on the CPU (see resolveKeyframes), so this chain is no more
 * expensive than the old GLSL's incremental version. `age` is an explicit
 * parameter (not closed over) so the same function can be called with a
 * vertex-stage `age` (position-related fields) or a separately-recomputed
 * fragment-stage `age` (color/alpha - see RfParticleNodeMaterial's own
 * colorNode doc comment for why those live in the fragment stage now).
 */
function sampleKeyframeField(age: AnyNode, keyframes: ResolvedKeyframe[], pick: (kf: ResolvedKeyframe) => AnyNode): AnyNode {
  let result = pick(keyframes[keyframes.length - 1]);
  for (let i = keyframes.length - 1; i >= 1; i--) {
    const prev = keyframes[i - 1];
    const curr = keyframes[i];
    const span = Math.max(curr.time - prev.time, 1e-6);
    const t = age.sub(prev.time).div(span);
    const segmentValue = mix(pick(prev), pick(curr), t);
    result = select(age.lessThan(curr.time), segmentValue, result);
  }
  return result;
}

class RfParticleNodeMaterial extends MeshBasicNodeMaterial {
  /** Stable holder for advanceClock to mutate every frame - same reasoning as glowEffect.ts's attachGlowInjection returning a `{value}` holder instead of a raw uniform, so callers never need to know this is a TSL uniform node specifically. */
  readonly particleTime: { value: number };

  private readonly billboard: boolean;
  private readonly particlePositionLocal: AnyNode;
  private readonly particleVertex: AnyNode;
  private keyframeAlpha: AnyNode;
  private keyframeColor: AnyNode;

  constructor(template: ParticleTemplate, texture: Texture | null, keyframes: ResolvedKeyframe[]) {
    super();
    this.transparent = true;
    this.blending = AdditiveBlending;
    this.depthWrite = false;
    // MeshBasicNodeMaterial's own constructor sets `this.lights = true` -
    // "although the basic material is by definition unlit, we use a
    // lighting model to compute the outgoing light" (its own doc comment) -
    // meaning colorNode's output otherwise gets shaded by the scene's real
    // lights (SceneController's DirectionalLight) against these billboard
    // quads' own (never explicitly set, effectively undefined-orientation)
    // normals - confirmed as a real, visible bug: irregular, direction-
    // dependent dark patches, not simple rectangles, tracking the light
    // rather than the quad shape. Force back to true passthrough (colorNode
    // *is* the final color, no lighting model) - the actual unlit behavior
    // this particle material has always wanted.
    this.lights = false;
    this.side = DoubleSide;
    this.toneMapped = false;
    this.billboard = template.billboard;

    const particleTimeUniform = uniform(0);
    this.particleTime = particleTimeUniform;

    const particlePhase: AnyNode = attribute('particlePhase', 'float');
    const liveTime = Math.max(template.liveTime, 1e-6);
    const age: AnyNode = particleTimeUniform.add(particlePhase).mod(liveTime);

    const xrot = sampleKeyframeField(age, keyframes, (kf) => float(kf.xrot));
    const yrot = sampleKeyframeField(age, keyframes, (kf) => float(kf.yrot));
    const zrot = sampleKeyframeField(age, keyframes, (kf) => float(kf.zrot));
    const scale = sampleKeyframeField(age, keyframes, (kf) => float(kf.scale));
    // Vertex-stage color/alpha (real per-vertex `age`, relying on TSL's
    // automatic vertex->fragment promotion when referenced from colorNode
    // below) - this exact shape (not the fragment-stage-recompute version
    // that used to live here) is independently confirmed working on its
    // own for the untextured case; see RfParticleNodeMaterial's own
    // colorNode doc comment for the full story on why textured particles
    // can't currently use it too.
    // Stashed on `this` (not just a local) so colorNode's own construction
    // further down can reference them - named to avoid colliding with the
    // real `Material.color` (a plain THREE.Color, not a node) this class
    // inherits.
    this.keyframeAlpha = sampleKeyframeField(age, keyframes, (kf) => float(kf.alpha));
    this.keyframeColor = sampleKeyframeField(age, keyframes, (kf) => vec3(kf.color.r, kf.color.g, kf.color.b));
    const power = (kf: ResolvedKeyframe): AnyNode => vec3(kf.power.x, kf.power.y, kf.power.z);
    const displacementAtStart = (kf: ResolvedKeyframe): AnyNode =>
      vec3(kf.powerDisplacementAtStart.x, kf.powerDisplacementAtStart.y, kf.powerDisplacementAtStart.z);

    // powerDisplacement: same closed-form trapezoidal-integral shape as
    // sampleField above, but each segment's own formula (not a simple mix)
    // - see resolveKeyframes' doc comment for the math this reproduces.
    let powerDisplacement = displacementAtStart(keyframes[keyframes.length - 1]);
    for (let i = keyframes.length - 1; i >= 1; i--) {
      const prev = keyframes[i - 1];
      const curr = keyframes[i];
      const span = Math.max(curr.time - prev.time, 1e-6);
      const t = age.sub(prev.time).div(span);
      const powerAtAge = mix(power(prev), power(curr), t);
      const elapsed = age.sub(prev.time);
      const segmentDisplacement = displacementAtStart(prev).add(power(prev).add(powerAtAge).mul(0.5).mul(elapsed));
      powerDisplacement = select(age.lessThan(curr.time), segmentDisplacement, powerDisplacement);
    }

    const spawn = convertVec3(template.posBox[0], template.posBox[1], template.posBox[2]);
    const gravity = convertVec3(template.gravity[0], template.gravity[1], template.gravity[2]);
    this.particlePositionLocal = vec3(spawn.x, spawn.y, spawn.z)
      .add(vec3(gravity.x, gravity.y, gravity.z).mul(age))
      .add(powerDisplacement);

    // rotateParticle(position*scale, radians(xrot), radians(yrot), radians(zrot)) - same X-then-Y-then-Z Euler order as the old GLSL helper, written out per-axis since TSL has no matching built-in 3-axis Euler rotator (rotate() is 2D-only, used by e.g. SpriteNodeMaterial).
    const xr = radians(xrot);
    const yr = radians(yrot);
    const zr = radians(zrot);
    const v0: AnyNode = positionGeometry.mul(scale);
    const afterX = vec3(v0.x, v0.y.mul(cos(xr)).sub(v0.z.mul(sin(xr))), v0.y.mul(sin(xr)).add(v0.z.mul(cos(xr))));
    const afterY = vec3(afterX.x.mul(cos(yr)).add(afterX.z.mul(sin(yr))), afterX.y, afterX.x.negate().mul(sin(yr)).add(afterX.z.mul(cos(yr))));
    this.particleVertex = vec3(afterY.x.mul(cos(zr)).sub(afterY.y.mul(sin(zr))), afterY.x.mul(sin(zr)).add(afterY.y.mul(cos(zr))), afterY.z);

    // Textured particles are tinted by the template's own per-keyframe
    // color/alpha, same as the untextured case below - this was previously
    // believed to be broken ("multiplying anything onto a texture sample
    // causes TSL artifacts"), across two separate wrong diagnoses (first
    // blamed on THREE.CompressedTexture - see texture.ts's own doc comment
    // - then, when that didn't fix it, blamed on TSL/WebGPU itself and
    // reverted here). Root-caused instead to SceneManager's renderer: it
    // was constructed without `alpha: false`, so the canvas' own
    // framebuffer was transparent and got composited by the *browser* over
    // this page's own dark background - and AdditiveBlending's alpha
    // output isn't attenuated by its blend factors the way its RGB is (see
    // SceneManager's own doc comment for the full mechanism), so a
    // fully-opaque-alpha texture (most real weapon-glow assets - they rely
    // entirely on a true-black background + additive blending for
    // "transparency", never on their own alpha channel) pushed the canvas'
    // *alpha* near 1 across a whole particle quad even where its RGB
    // correctly stayed near black, and the browser then composited that
    // (near-black, near-opaque) canvas region as solid black over the page
    // - a browser-compositing artifact, not anything three.js/TSL was
    // doing wrong with this multiply. Fixed at the renderer, not here.
    const tint = vec4(this.keyframeColor, this.keyframeAlpha.div(255));
    this.colorNode = texture ? sampleTexture(texture, uv()).mul(tint) : tint;
  }

  setupPositionView(builder: NodeBuilder): AnyNode {
    const object = builder.object as unknown as WebGpuInstancedMesh;
    const instanceMatrix = object.instanceMatrix;
    const instanceMatrixNode: AnyNode = (buffer(instanceMatrix.array, 'mat4', Math.max(instanceMatrix.count, 1)) as AnyNode).element(instanceIndex);

    const instancedPoint = instanceMatrixNode.mul(vec4(this.particlePositionLocal, 1));
    const mvPosition: AnyNode = modelViewMatrix.mul(instancedPoint);

    if (this.billboard) {
      // A hidden row (unused batch capacity, or a culled/LOD-reduced member
      // - see ParticleTemplateBatch's ZERO_SCALE_MATRIX/updateMember) has
      // its *position* collapsed to the origin by a zero-scale instance
      // matrix, but that alone doesn't hide a billboard particle: its own
      // screen-space size (particleVertex, below) is computed independently
      // of the instance transform entirely - that's what makes it
      // camera-facing rather than following the socket's own rotation. Left
      // alone, every hidden row across the whole batch still rendered a
      // full-size quad, just relocated to the same point (the scene origin,
      // near wherever the character itself stands) - confirmed visually as
      // a cluster of solid, oversized squares. Scaling the billboard offset
      // by the instance's own scale magnitude (extracted the same way
      // SpriteNodeMaterial reads a world matrix's scale, via one column's
      // length - 1 for any real, visible instance, 0 for a zero-scale
      // hidden one) collapses the quad's own size right along with its
      // position, matching a real Mesh's own "invisible when scaled to
      // zero" behavior instead of only hiding position.
      const instanceScale = instanceMatrixNode[0].xyz.length();
      // mvPosition.xyz += particleVertex - camera-facing offset added post-transform, in view space, ignoring the instance's own rotation (see rebuildMesh's doc comment on why - this mesh spans many unrelated socket orientations).
      return vec4(mvPosition.xyz.add(this.particleVertex.mul(instanceScale)), mvPosition.w);
    }

    // Non-billboard: the vertex offset goes through the instance transform
    // too (as a direction - w=0, no translation), unlike the billboard
    // branch above - so a hidden row's zero-scale matrix already correctly
    // collapses this offset to zero right along with its position, no
    // separate fix needed here.
    return mvPosition.add(modelViewMatrix.mul(instanceMatrixNode.mul(vec4(this.particleVertex, 0))));
  }
}

/** Builds one compact node-material per RF template - see RfParticleNodeMaterial's own doc comment for why this is a full TSL node graph now (WebGPURenderer migration) instead of a GLSL string. Returns the material alongside a stable `{value}` holder for `advanceClock` to mutate every frame - same shape glowEffect.ts's attachGlowInjection already uses for its own per-frame-mutated uniform. */
function buildGpuParticleMaterial(
  template: ParticleTemplate,
  texture: Texture | null,
  keyframes: ResolvedKeyframe[],
): { material: RfParticleNodeMaterial; particleTime: { value: number } } {
  const material = new RfParticleNodeMaterial(template, texture, keyframes);
  return { material, particleTime: material.particleTime };
}

/** Instance-row capacity a ParticleTemplateBatch grows by whenever a new member doesn't fit, so it isn't rebuilt on every single equip/spawn event - see ParticleTemplateBatch.rebuildMesh. */
const PARTICLE_BATCH_CAPACITY_CHUNK = 64;
/** Shared "hide this row" matrix (scale 0 on every axis) - reused by every batch for both culled members and unused capacity slack, never mutated in place, safe to share since InstancedMesh.setMatrixAt only reads it. */
const ZERO_SCALE_MATRIX = new Matrix4().makeScale(0, 0, 0);

let particleBatchSceneRoot: Object3D | null = null;

/** Wires the shared per-template batches into the real scene - call once, before any ParticleEffect.load() (ViewerScene does this from its constructor). Every batch's InstancedMesh is added directly here, at the scene root, rather than under any one character's socket - see ParticleTemplateBatch's own doc comment for why. */
export function initParticleBatching(sceneRoot: Object3D): void {
  particleBatchSceneRoot = sceneRoot;
}

/** One socket's worth of rows within a shared ParticleTemplateBatch. Not exported - ParticleEffect (below) is the public handle wrapping this. */
class BatchMember {
  baseRow = -1;
  rowCount = 0;
  culled = false;
  activeInstanceCount = 0;
  readonly worldBounds = new Sphere();
  readonly worldScale = new Vector3();
  readonly group: Object3D;
  localBoundsRadius: number;

  constructor(group: Object3D, localBoundsRadius: number) {
    this.group = group;
    this.localBoundsRadius = localBoundsRadius;
  }
}

/**
 * Every `ParticleEffect` resolving to the same `.spt` template (across
 * *every* character - player and every bot alike) shares one of these:
 * one `InstancedMesh`/`ShaderMaterial`/draw call for however many sockets
 * are currently using that template, instead of one InstancedMesh per
 * socket. This is what actually fixed the reported "20 bots, 252 effects,
 * ~27fps" case - each effect was already cheap to *simulate* (GPU-driven,
 * see buildGpuParticleMaterial's own doc comment), but 252 separate draw
 * calls was the real remaining cost, and per-effect instance-count LOD
 * (setParticleEffectCountForBudget) can't reduce draw-call count at all.
 *
 * The batch's own InstancedMesh sits at the scene root with an identity
 * transform (added via initParticleBatching's sceneRoot, never parented
 * to any one socket) - each member's own socket-space positioning comes
 * instead from a per-row `instanceMatrix` (three's built-in per-instance
 * transform, auto-wired into any material on an InstancedMesh - see
 * buildGpuParticleMaterial), written every frame from that member's own
 * `group.matrixWorld`. A member beyond its own culled/LOD-reduced active
 * count is hidden via ZERO_SCALE_MATRIX rather than shrinking the shared
 * mesh's instance count, since different members can be culled
 * independently of each other within one draw call.
 */
class ParticleTemplateBatch {
  material: RfParticleNodeMaterial;
  rowsPerMember: number;
  localBoundsRadius: number;

  private instancedMesh: InstancedMesh | null = null;
  private instanceGeometry: BufferGeometry | null = null;
  private capacity = 0;
  private readonly members: BatchMember[] = [];
  private simTime = 0;
  private geometry: BufferGeometry;
  private template: ParticleTemplate;
  private texture: Texture | null;
  /** The material's own particleTime uniform holder - see buildGpuParticleMaterial's return shape. Held separately (not re-read off `material` each time) since a TSL node material doesn't expose a plain `.uniforms` map the way the old ShaderMaterial did. */
  private particleTime: { value: number };

  constructor(geometry: BufferGeometry, template: ParticleTemplate, texture: Texture | null) {
    this.geometry = geometry;
    this.template = template;
    this.texture = texture;
    const keyframes = resolveKeyframes(template);
    const built = buildGpuParticleMaterial(template, texture, keyframes);
    this.material = built.material;
    this.particleTime = built.particleTime;
    this.rowsPerMember = Math.max(0, Math.round(template.num));
    this.localBoundsRadius = computeLocalBoundsRadius(template, geometry, keyframes);
  }

  get memberCount(): number {
    return this.members.length;
  }

  /** Advances this batch's one shared animation clock - called once per batch per frame (see advanceParticleBatchClocks), not once per member. Every member already differentiates purely via its own particlePhase row data (Van der Corput + createTimeEpsilon jitter, assigned in reassignRows), so a shared clock across every socket using this template is visually indistinguishable from each effect owning its own clock, just cheaper. */
  advanceClock(delta: number): void {
    this.simTime += delta * this.template.timeSpeed;
    this.particleTime.value = this.simTime;
  }

  addMember(group: Object3D): BatchMember {
    const member = new BatchMember(group, this.localBoundsRadius);
    this.members.push(member);
    this.reassignRows();
    return member;
  }

  removeMember(member: BatchMember): void {
    const index = this.members.indexOf(member);
    if (index === -1) return;
    this.members.splice(index, 1);
    if (this.members.length === 0) {
      this.disposeMesh();
      return;
    }
    this.reassignRows();
  }

  /** Rebuilds this batch's shared material/bounds after its template was mutated in place (a %efedit live-value edit on a private forked batch, or a %particlerandom randomness-mode toggle) - always safe to call, including redundantly (every member sharing a batch calls this on a randomness toggle; the last call wins, harmless since the result is identical each time). */
  rebuildFromTemplate(): void {
    const keyframes = resolveKeyframes(this.template);
    this.material.dispose();
    const built = buildGpuParticleMaterial(this.template, this.texture, keyframes);
    this.material = built.material;
    this.particleTime = built.particleTime;
    if (this.instancedMesh) this.instancedMesh.material = this.material;
    this.rowsPerMember = Math.max(0, Math.round(this.template.num));
    this.localBoundsRadius = computeLocalBoundsRadius(this.template, this.geometry, keyframes);
    for (const member of this.members) member.localBoundsRadius = this.localBoundsRadius;
    this.reassignRows();
  }

  /** Rebuilds row assignment (and grows the InstancedMesh if needed) whenever membership or rowsPerMember changes - infrequent (equip/spawn/despawn/live-edit events), never a per-frame cost. Every row (including unused capacity slack) is reset to ZERO_SCALE_MATRIX first so a freshly grown or reassigned row never briefly shows a stale previous member's transform. */
  private reassignRows(): void {
    const needed = this.members.length * this.rowsPerMember;
    if (!this.instancedMesh || needed > this.capacity) this.rebuildMesh(needed);
    const instancedMesh = this.instancedMesh;
    const instanceGeometry = this.instanceGeometry;
    if (!instancedMesh || !instanceGeometry) return;

    for (let i = 0; i < this.capacity; i++) instancedMesh.setMatrixAt(i, ZERO_SCALE_MATRIX);

    const phaseAttr = instanceGeometry.getAttribute('particlePhase') as InstancedBufferAttribute;
    const liveTime = Math.max(this.template.liveTime, 1e-6);
    let row = 0;
    for (const member of this.members) {
      member.baseRow = row;
      member.rowCount = this.rowsPerMember;
      for (let i = 0; i < this.rowsPerMember; i++) {
        // Van der Corput ordering means every leading LOD subset still spans
        // the whole loop, rather than bunching at the start of its lifetime.
        let bits = i;
        let fraction = 0;
        let place = 0.5;
        while (bits > 0) { fraction += (bits & 1) * place; bits >>>= 1; place *= 0.5; }
        phaseAttr.setX(row + i, fraction * liveTime + Math.random() * this.template.createTimeEpsilon);
      }
      row += this.rowsPerMember;
    }
    phaseAttr.needsUpdate = true;
    instancedMesh.instanceMatrix.needsUpdate = true;
  }

  private rebuildMesh(minCapacity: number): void {
    const newCapacity = Math.max(PARTICLE_BATCH_CAPACITY_CHUNK, Math.ceil(minCapacity / PARTICLE_BATCH_CAPACITY_CHUNK) * PARTICLE_BATCH_CAPACITY_CHUNK);
    this.instancedMesh?.parent?.remove(this.instancedMesh);
    this.instancedMesh?.dispose();
    this.instanceGeometry?.dispose();

    // Each batch owns its geometry wrapper because phase data is per row;
    // clone keeps the cached R3E source geometry untouched.
    const instanceGeometry = this.geometry.clone();
    instanceGeometry.setAttribute('particlePhase', new InstancedBufferAttribute(new Float32Array(newCapacity), 1));
    const instancedMesh = new InstancedMesh(instanceGeometry, this.material, newCapacity);
    // Real particles drift well outside the one quad's own local bounds and
    // move every frame, and this mesh now spans many unrelated socket
    // positions across the whole scene besides - a real bounding volume
    // would be both expensive to keep correct and meaningless. Off-screen
    // instances still don't cost fill-rate; the GPU clips them at the
    // viewport regardless of frustumCulled. Per-member visibility is
    // handled explicitly instead (see updateMember's zero-scale rows).
    instancedMesh.frustumCulled = false;
    instancedMesh.count = newCapacity;
    particleBatchSceneRoot?.add(instancedMesh);

    this.instancedMesh = instancedMesh;
    this.instanceGeometry = instanceGeometry;
    this.capacity = newCapacity;
  }

  private disposeMesh(): void {
    this.instancedMesh?.parent?.remove(this.instancedMesh);
    this.instancedMesh?.dispose();
    this.instancedMesh = null;
    this.instanceGeometry?.dispose();
    this.instanceGeometry = null;
    this.capacity = 0;
  }

  /** Per-frame cull test + instanceMatrix upload for one member - called from ParticleEffect.update(), once per socket per frame (the batch's own animation clock is advanced separately, once per batch - see advanceClock). */
  updateMember(member: BatchMember, frustum: Frustum | null, cameraPosition: Vector3 | null): void {
    if (!this.instancedMesh || member.rowCount <= 0) return;

    // InstancedMesh's built-in bounds only cover its source geometry, not
    // its moving per-member instance matrices - test the conservative
    // per-member sphere instead, after the socket hierarchy has received
    // this frame's animation transforms. Time still advances while hidden
    // (see advanceClock), so an effect resumes at the correct point in its
    // loop when it re-enters view.
    member.group.updateWorldMatrix(true, false);

    let distance = 0;
    if (frustum || cameraPosition) {
      member.group.getWorldPosition(member.worldBounds.center);
      member.group.getWorldScale(member.worldScale);
      member.worldBounds.radius = member.localBoundsRadius * Math.max(Math.abs(member.worldScale.x), Math.abs(member.worldScale.y), Math.abs(member.worldScale.z));
      distance = cameraPosition ? cameraPosition.distanceTo(member.worldBounds.center) : 0;
      member.culled = (frustum ? !frustum.intersectsSphere(member.worldBounds) : false) || distance > PARTICLE_RENDER_DISTANCE;
    } else {
      member.culled = false;
    }

    const instancedMesh = this.instancedMesh;
    if (member.culled) {
      member.activeInstanceCount = 0;
      for (let i = 0; i < member.rowCount; i++) instancedMesh.setMatrixAt(member.baseRow + i, ZERO_SCALE_MATRIX);
      instancedMesh.instanceMatrix.needsUpdate = true;
      return;
    }

    // Keep a phase-distributed subset as an effect recedes. Selecting
    // evenly-spaced source rows retains the emitter's full lifetime
    // coverage; truncating to the first N would visibly bunch the stream.
    const lodT = Math.min(1, Math.max(0, (distance - PARTICLE_LOD_FULL_DISTANCE) / (PARTICLE_LOD_MIN_DISTANCE - PARTICLE_LOD_FULL_DISTANCE)));
    const cappedCount = Math.min(member.rowCount, particleVisibleInstanceCap);
    const minCount = Math.min(cappedCount, PARTICLE_LOD_MIN_INSTANCES);
    const activeCount = Math.max(minCount, Math.round(cappedCount + (minCount - cappedCount) * lodT));
    member.activeInstanceCount = activeCount;

    for (let i = 0; i < activeCount; i++) instancedMesh.setMatrixAt(member.baseRow + i, member.group.matrixWorld);
    for (let i = activeCount; i < member.rowCount; i++) instancedMesh.setMatrixAt(member.baseRow + i, ZERO_SCALE_MATRIX);
    instancedMesh.instanceMatrix.needsUpdate = true;
  }
}

const templateBatches = new Map<string, ParticleTemplateBatch>();
let nextPrivateBatchId = 0;

/** Advances every active batch's shared animation clock exactly once per rendered frame - call once from ViewerScene.update(), separately from the many individual ParticleEffect.update() calls (one per socket, across every character) that only handle per-member culling/positioning. Keeping the clock advance here is what lets many effects share one batch's `particleTime` uniform without over-advancing it once per member instead of once per frame. */
export function advanceParticleBatchClocks(delta: number): void {
  for (const batch of templateBatches.values()) batch.advanceClock(delta);
}

/** How many distinct ParticleTemplateBatch draw calls currently exist scene-wide (player + every bot combined) - debug-only, for StatsPanel to show alongside the raw effect count so "did batching actually merge these" is a direct read instead of an inference from total render calls (which are dominated by character meshes and vary run-to-run on their own). */
export function getParticleBatchCount(): number {
  return templateBatches.size;
}

/**
 * A running instance of one `.spt` template, attached to one socket (a
 * weapon bone, a socket dummy, ...) - `.group` is parented there exactly
 * as before; call `load()` once, then `update()` once a frame. Rendering
 * itself is delegated to a shared `ParticleTemplateBatch` (see its own
 * doc comment) keyed by `.spt` path, so this class no longer owns an
 * `InstancedMesh`/material of its own in the common case - only a live-
 * tuned effect (see setLiveValues) ever gets a private one-member batch.
 */
export class ParticleEffect {
  readonly group = new Object3D();

  private template: ParticleTemplate | null = null;
  private geometry: BufferGeometry | null = null;
  private texture: Texture | null = null;
  private sptPath: string | null = null;
  private batch: ParticleTemplateBatch | null = null;
  private batchKey: string | null = null;
  private member: BatchMember | null = null;
  private disposed = false;
  /** Set once this effect has been live-edited via %efedit - from then on it owns a private, never-shared batch (a fresh key, never `.spt`-path-keyed again) so tuning one socket never bleeds into every other effect currently using the same template. See setLiveValues. */
  private forkedForLiveEdit = false;

  /** Resolves the template + its entity mesh and joins (or creates) the shared batch for this `.spt` path. Safe to call once; the effect renders nothing until this resolves. */
  async load(sptPath: string): Promise<void> {
    const template = await loadParticleTemplate(sptPath);
    if (this.disposed || !template || !template.entityFile) return;

    const geometry = await loadR3EGeometry(template.entityFile);
    if (this.disposed || !geometry) return;

    // Best-effort: a real texture makes this look like the actual game
    // effect instead of a flat colored silhouette, but its absence isn't
    // an error (see loadR3EMaterialTexture's own doc comment) - every
    // instance still renders, just untextured, same as before this existed.
    const texture = await loadR3EMaterialTextureCached(template.entityFile, 0);
    if (this.disposed) return;

    this.template = template;
    this.geometry = geometry;
    this.texture = texture;
    this.sptPath = sptPath;
    this.joinBatch(sptPath);
  }

  private joinBatch(key: string): void {
    this.leaveBatch();
    if (!this.template || !this.geometry || this.template.num <= 0) return;

    let batch = templateBatches.get(key);
    if (!batch) {
      batch = new ParticleTemplateBatch(this.geometry, this.template, this.texture);
      templateBatches.set(key, batch);
    }
    this.batch = batch;
    this.batchKey = key;
    this.member = batch.addMember(this.group);
  }

  private leaveBatch(): void {
    if (this.batch && this.member) {
      this.batch.removeMember(this.member);
      if (this.batch.memberCount === 0 && this.batchKey) templateBatches.delete(this.batchKey);
    }
    this.batch = null;
    this.member = null;
  }

  /** Per-effect values consumed by CharacterController's debug stats. Kept as scalar getters so gathering them doesn't create one object per effect per frame. */
  getInstanceCount(): number {
    return this.member?.rowCount ?? 0;
  }

  getActiveInstanceCount(): number {
    return this.member?.activeInstanceCount ?? 0;
  }

  isCulled(): boolean {
    return this.member?.culled ?? false;
  }

  /** Debug-only, read-only snapshot of the real `.spt` values currently driving this effect - for `%efedit`'s live inspector/tuner (see setLiveValues). Null before load() resolves. */
  getLiveTemplate(): ParticleTemplate | null {
    return this.template;
  }

  /** Rebuilds this effect's batch after the debug randomness mode changes. If this effect shares a batch with other members, every one of them calls this too (each rebuild is redundant but harmless - the result is identical each time), same simplification `rebuildFromTemplate` itself documents. */
  rebuildForRandomnessChange(): void {
    this.batch?.rebuildFromTemplate();
  }

  /**
   * Debug-only (`%efedit`'s per-socket inspector panel): overwrites one or
   * more of this effect's own template values in place and rebuilds its
   * batch from the result - for empirically dialing in "the exact
   * formula" against the real game's own look, the same live-tune-and-
   * observe workflow WeaponEditPanel's grade values already offer.
   *
   * `this.template` starts out as the same cached object every other
   * effect resolving this `.spt` path shares (see loadParticleTemplate's
   * module-level cache) - mutating it in place would silently retune
   * every other socket currently using this template, including bots. The
   * first edit clones it into a private copy and moves this effect into
   * its own private, never-shared batch (a fresh key, not this `.spt`
   * path) before applying anything, so a live edit stays scoped to just
   * the one socket `%efedit` is pointed at, exactly like before batching
   * existed. Every edit after the first reuses that same private batch
   * (cheap in-place rebuild, not a fresh join) since a live-tune panel can
   * fire on every keystroke.
   */
  setLiveValues(patch: Partial<ParticleLiveValues>): void {
    const template = this.template;
    if (!template || !this.geometry) return;

    if (!this.forkedForLiveEdit) {
      const forked = { ...template };
      this.template = forked;
      this.forkedForLiveEdit = true;
      applyLiveValuePatch(forked, patch);
      this.joinBatch(`${this.sptPath ?? 'unknown'}#private-${nextPrivateBatchId++}`);
      return;
    }

    applyLiveValuePatch(template, patch);
    this.batch?.rebuildFromTemplate();
  }

  update(delta: number, camera: Camera | null, frustum: Frustum | null, cameraPosition: Vector3 | null): void {
    void delta; // clock advance is batch-level now, see advanceParticleBatchClocks
    void camera; // billboarding is baked into the shader at build time, not read at runtime - matches the old per-effect behavior
    if (!this.batch || !this.member) return;
    this.batch.updateMember(this.member, frustum, cameraPosition);
  }

  dispose(): void {
    this.disposed = true;
    this.leaveBatch();
  }
}
