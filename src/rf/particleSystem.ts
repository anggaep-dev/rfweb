import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Camera, Texture } from 'three';
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
  if (!entry) return null;

  const materialBuffer = await fetchChefAssetCaseInsensitive(dirUrl, `${entry.name}.mst`);
  const script = parseMaterialScript(new TextDecoder('euc-kr').decode(materialBuffer));
  const mapName = script.layers[0]?.mapName;
  if (!mapName) return null;

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

/** A single particle's own resolved (rand()-rolled once, not re-rolled every frame) keyframe curve - see the module doc comment on why this is per-particle rather than shared. */
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

/**
 * One instance's own "recipe" - no per-instance Mesh/Material of its own
 * (see the class doc comment on why: hundreds of those across many
 * equipped weapons is what was actually causing the reported FPS drop).
 * Its index in ParticleEffect.instances *is* its InstancedMesh instance
 * index - update() writes this instance's own current transform/color
 * into that one shared InstancedMesh via setMatrixAt/setColorAt every
 * frame instead of touching a real scene-graph Object3D at all.
 */
interface ParticleInstance {
  spawnPos: Vector3;
  /** This instance's own rand(0, createTimeEpsilon) roll - see ParticleTemplate.createTimeEpsilon. */
  phaseOffset: number;
  keyframes: ResolvedKeyframe[];
}

/** RF's particle colors are plain 0-255 display-referred RGB bytes, same as any other color this project reads off disk - explicit SRGBColorSpace here matches texture.ts's own convention, rather than three.js's default of treating raw Color() components as already-linear (which visibly shifts the result - verified against a real file while building this). */
function colorFromRgb255(r: number, g: number, b: number): Color {
  return new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
}

/** Resolves a NumberOrRange triple into a real drift-velocity Vector3, going through the same 3ds-Max-to-three.js axis conversion (coords.ts's convertVec3) every other spatial value this project reads from Chef/'s binary formats (.msh/.bn/.ani) already goes through - .spt is plain text, not one of those, but it's authored by the same original toolchain for the same 3ds-Max-space scene, so the same conversion applies (confirmed: skipping it left a real weapon's own particle spawning ~28 raw units away from the weapon's own mesh entirely - see docs/rf-format-notes.md). */
function resolvePower(range: [NumberOrRange, NumberOrRange, NumberOrRange]): Vector3 {
  return convertVec3(resolveNumberOrRange(range[0]), resolveNumberOrRange(range[1]), resolveNumberOrRange(range[2]));
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

function resolveKeyframes(template: ParticleTemplate): ResolvedKeyframe[] {
  const start: ResolvedKeyframe = {
    time: 0,
    alpha: resolveNumberOrRange(template.startAlpha),
    zrot: resolveNumberOrRange(template.startZRot),
    xrot: resolveNumberOrRange(template.startXRot),
    yrot: resolveNumberOrRange(template.startYRot),
    scale: resolveNumberOrRange(template.startScale),
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
      alpha: kf.alpha ? resolveNumberOrRange(kf.alpha) : prev.alpha,
      zrot: kf.zrot ? resolveNumberOrRange(kf.zrot) : prev.zrot,
      xrot: kf.xrot ? resolveNumberOrRange(kf.xrot) : prev.xrot,
      yrot: kf.yrot ? resolveNumberOrRange(kf.yrot) : prev.yrot,
      scale: kf.scale ? resolveNumberOrRange(kf.scale) : prev.scale,
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

/**
 * Piecewise-linear interpolation across a particle's own resolved
 * keyframe curve. Holds the first/last value outside the curve's own
 * time range - including `powerDisplacement`, which simply stops
 * accumulating once `age` passes the last keyframe (the particle keeps
 * whatever position offset `power` had already given it, same "hold at
 * the end" behavior as every other field here).
 *
 * `powerDisplacement` (unlike every other field returned here) isn't a
 * direct interpolation of `power` itself - `power` is a *velocity*, so
 * its effect on position is the *integral* of that velocity over time,
 * not its instantaneous value. Within the current segment [prev, curr],
 * `power` is assumed to vary linearly from `prev.power` to `curr.power`
 * (matching how every other field here is itself linearly interpolated),
 * so the displacement contributed between `prev.time` and `age` is the
 * exact trapezoidal-rule integral of that line: the average of the
 * velocity at the start and end of the elapsed portion, times the
 * elapsed time - added to `prev.powerDisplacementAtStart`, the
 * already-accumulated total from every earlier segment (see
 * resolveKeyframes's own second pass).
 */
function sampleKeyframes(
  keyframes: ResolvedKeyframe[],
  age: number,
): { alpha: number; zrot: number; xrot: number; yrot: number; scale: number; color: Color; powerDisplacement: Vector3 } {
  if (age <= keyframes[0].time) return { ...keyframes[0], powerDisplacement: keyframes[0].powerDisplacementAtStart };
  const last = keyframes[keyframes.length - 1];
  if (age >= last.time) return { ...last, powerDisplacement: last.powerDisplacementAtStart };

  let next = keyframes.length - 1;
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i].time >= age) {
      next = i;
      break;
    }
  }
  const prev = keyframes[next - 1];
  const curr = keyframes[next];
  const span = curr.time - prev.time;
  const t = span > 0 ? (age - prev.time) / span : 0;
  const elapsed = age - prev.time;
  const powerAtAge = prev.power.clone().lerp(curr.power, t);
  const powerDisplacement = prev.powerDisplacementAtStart
    .clone()
    .addScaledVector(prev.power.clone().add(powerAtAge).multiplyScalar(0.5), elapsed);
  return {
    alpha: prev.alpha + (curr.alpha - prev.alpha) * t,
    zrot: prev.zrot + (curr.zrot - prev.zrot) * t,
    xrot: prev.xrot + (curr.xrot - prev.xrot) * t,
    yrot: prev.yrot + (curr.yrot - prev.yrot) * t,
    scale: prev.scale + (curr.scale - prev.scale) * t,
    color: prev.color.clone().lerp(curr.color, t),
    powerDisplacement,
  };
}

const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/**
 * A running instance of one `.spt` template: `num` copies of its `.R3E`
 * entity mesh, looping through the same keyframed alpha/color/scale/zrot
 * curve (each instance rolling its own `rand()` values once at creation,
 * not shared - see resolveKeyframes) while drifting under `gravity`.
 * Attach `.group` under whatever the effect should follow (a weapon bone,
 * a socket dummy, ...) and call `update()` once a frame.
 *
 * Renders every instance through one shared `InstancedMesh` (one draw
 * call, one material, for the whole template regardless of `num`) rather
 * than a real `Mesh`+`MeshBasicMaterial` per instance - the latter is
 * what this class originally did, and it's what actually caused a real,
 * reported "FPS drops from 60 to 30 with many bots" problem: a single
 * high-upgrade-level weapon's own `.eff` can carry several particle-
 * bearing sections (see glowEffect.ts's resolveWeaponParticles), each
 * with its own `num`-sized template - measured at 344 separate meshes
 * (and 344 separate WebGLProgram-relevant material instances) for just 3
 * bots. Per-instance color/alpha is carried via `InstancedMesh.
 * setColorAt` (three's own built-in per-instance color, RGB only, no
 * custom shader needed) with alpha baked directly into the color's own
 * magnitude rather than the material's opacity - safe *specifically*
 * because every real template here uses `AdditiveBlending`, where
 * scaling a fragment's RGB by `k` and scaling its alpha by `k` produce
 * the exact same additive contribution (`dst + rgb*k*1 == dst +
 * rgb*1*k`), so there's no need for true per-instance alpha at all, just
 * a color whose brightness already has the desired alpha folded in.
 */
export class ParticleEffect {
  readonly group = new Object3D();

  private template: ParticleTemplate | null = null;
  private geometry: BufferGeometry | null = null;
  private texture: Texture | null = null;
  /** Owned by this effect (unlike geometry/texture, which are shared/cached across every effect using the same entity - see loadR3EGeometry/loadR3EMaterialTextureCached) - one material for every instance this effect ever spawns, disposed and rebuilt alongside the InstancedMesh itself in spawnInstances(). */
  private material: MeshBasicMaterial | null = null;
  private instancedMesh: InstancedMesh | null = null;
  private instances: ParticleInstance[] = [];
  private simTime = 0;
  private disposed = false;
  private readonly gravity = new Vector3();
  /** Reused every frame rather than allocated fresh - see update()'s billboard math. Computed once per frame (not once per instance, unlike the pre-InstancedMesh version of this class - every instance shares the exact same parent, so recomputing this per instance was always redundant work, not just per-instance-mesh overhead). */
  private readonly parentWorldQuat = new Quaternion();
  private readonly billboardBaseQuat = new Quaternion();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchSpinQuat = new Quaternion();
  private readonly scratchPosition = new Vector3();
  private readonly scratchScale = new Vector3(1, 1, 1);
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchColor = new Color();

  /** Resolves the template + its entity mesh and spawns all instances. Safe to call once; the effect renders nothing until this resolves. */
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
    this.spawnInstances();
  }

  /** (Re)builds the shared InstancedMesh + every ParticleInstance "recipe" from `this.template`'s current values - shared by load() and setLiveValues() (which mutates the template then calls this again, same "just rebuild" pattern CharacterController's own setDebugWeaponUpgradeLevel uses for a similar live-tuning case). Tears down any previous InstancedMesh/material first (a fresh one is needed either way - `num` itself can change, and InstancedMesh's own instance count is fixed at construction), but never re-fetches geometry/texture - those don't change just because a live value did. */
  private spawnInstances(): void {
    const template = this.template;
    if (!template || !this.geometry) return;

    this.instancedMesh?.parent?.remove(this.instancedMesh);
    this.instancedMesh?.dispose();
    this.material?.dispose();
    this.instances = [];
    this.simTime = 0;

    if (template.num <= 0) {
      this.instancedMesh = null;
      this.material = null;
      return;
    }

    this.material = new MeshBasicMaterial({
      color: 0xffffff,
      map: this.texture,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    const instancedMesh = new InstancedMesh(this.geometry, this.material, template.num);
    instancedMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Real particles drift well outside the one quad's own local bounds
    // (that's the whole point - see docs/rf-format-notes.md's coordinate-
    // conversion section) and move every frame, so a real per-instance
    // bounding volume would need recomputing constantly to stay correct -
    // not worth it for what's already a small, localized effect near one
    // weapon; simplest correct answer is to never cull this mesh at all
    // (off-screen instances still don't cost fill-rate, the GPU clips
    // them at the viewport regardless of frustumCulled).
    instancedMesh.frustumCulled = false;
    this.group.add(instancedMesh);
    this.instancedMesh = instancedMesh;

    for (let i = 0; i < template.num; i++) {
      this.instances.push({
        // convertVec3, not a plain Vector3(...posBox) - see resolvePower's
        // own doc comment on why a .spt's raw XYZ needs the same axis
        // conversion every other Chef/ spatial value already gets.
        spawnPos: convertVec3(template.posBox[0], template.posBox[1], template.posBox[2]),
        // Evenly spread across the loop by instance index as a baseline
        // (i/num * liveTime), with createTimeEpsilon's own random jitter
        // layered on top - not createTimeEpsilon alone. A `num`>1
        // template with no createTimeEpsilon at all is common (confirmed
        // real: `Chef/PVP_Item/COM_WEAPON_TSPEAR_117/773p.spt`, num=24,
        // no creat_time_epsilon key) - reported as "moves/pulses as one
        // blob then snaps back" instead of "looks like continuous fire",
        // which is exactly what perfectly-synchronized instances (every
        // one sharing phaseOffset=0, the old behavior) would look like.
        // The even-spacing baseline fixes that case without changing
        // anything for a template that already sets a real epsilon (see
        // `400p.spt`'s own `creat_time_epsilon 5`, already confirmed to
        // look correct) - it just adds a second, complementary source of
        // stagger on top of the jitter that was already there.
        phaseOffset: (i / template.num) * template.liveTime + Math.random() * template.createTimeEpsilon,
        keyframes: resolveKeyframes(template),
      });
    }
  }

  /** Debug-only, read-only snapshot of the real `.spt` values currently driving this effect - for `%efedit`'s live inspector/tuner (see setLiveValues). Null before load() resolves. */
  getLiveTemplate(): ParticleTemplate | null {
    return this.template;
  }

  /**
   * Debug-only (`%efedit`'s per-socket inspector panel): overwrites one or
   * more of this effect's own template values in place and rebuilds every
   * instance from the result - for empirically dialing in "the exact
   * formula" against the real game's own look, the same live-tune-and-
   * observe workflow WeaponEditPanel's grade values already offer. A full
   * rebuild (not a partial in-place patch) is used even for a single
   * field change: several fields here (`startPower`/`startScale`/
   * `startAlpha`/`startZRot`/`posBox`) are only ever read once, at spawn
   * time, into each instance's own resolved keyframe curve - patching
   * them without rebuilding wouldn't visibly do anything. `gravity`/
   * `liveTime`/`timeSpeed` ARE re-read fresh every frame in update() and
   * would technically update live without a rebuild, but going through
   * the same rebuild path for every field keeps this method's behavior
   * uniform and simple rather than field-dependent. Values here are
   * plain numbers, not the template's own `NumberOrRange` - editing away
   * any `rand()` a field originally had, same simplification
   * GradeLiveValues already makes for `.mst` values.
   */
  setLiveValues(patch: Partial<ParticleLiveValues>): void {
    const template = this.template;
    if (!template) return;

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

    this.spawnInstances();
  }

  /**
   * Advances the shared loop clock and every instance's position/scale/
   * color/alpha/rotation, writing each one straight into the shared
   * InstancedMesh's own instance matrix/color buffers (setMatrixAt/
   * setColorAt) instead of touching a real per-instance Object3D - see
   * the class doc comment on why. `camera` is only used for billboarded
   * templates (the common case - see particleTemplate.ts) to face each
   * particle toward it; non-billboard templates ignore it and keep the
   * entity mesh's own authored orientation, only spinning it by the
   * resolved xrot/yrot/zrot. Each instance samples its keyframe curve and
   * drifts using its *own* age (`simTime` plus that instance's own
   * `phaseOffset` - see createTimeEpsilon), not one shared age for every
   * instance - otherwise every copy would pulse through the exact same
   * point in the curve at the exact same moment, reading as one
   * overlapping blob instead of a staggered stream (the real, and
   * intended, effect of a nonzero createTimeEpsilon).
   *
   * Position drift is `gravity` (constant for the whole template) plus
   * `sample.powerDisplacement` (the integrated effect of `power`/
   * `start_power`, which - unlike gravity - can change value at each
   * keyframe; see sampleKeyframes's own doc comment for why this is an
   * integral rather than a direct per-frame add).
   */
  update(delta: number, camera: Camera | null): void {
    const template = this.template;
    const instancedMesh = this.instancedMesh;
    if (!template || !instancedMesh) return;

    this.simTime += delta * template.timeSpeed;
    const liveTime = Math.max(template.liveTime, 1e-6);
    // convertVec3, not a plain .set(...gravity) - see resolvePower's own
    // doc comment on why a .spt's raw XYZ needs the same axis conversion
    // every other Chef/ spatial value already gets.
    convertVec3(template.gravity[0], template.gravity[1], template.gravity[2], this.gravity);

    // Every instance shares the exact same parent (this.group) - compute
    // the camera-facing base orientation once per frame, not once per
    // instance (the pre-InstancedMesh version of this class recomputed
    // the identical value on every single instance, every frame).
    const useBillboard = template.billboard && camera !== null;
    if (useBillboard) {
      if (this.group.parent) {
        this.group.parent.getWorldQuaternion(this.parentWorldQuat);
        this.billboardBaseQuat.copy(this.parentWorldQuat).invert().multiply(camera.quaternion);
      } else {
        this.billboardBaseQuat.copy(camera.quaternion);
      }
    }

    for (let i = 0; i < this.instances.length; i++) {
      const instance = this.instances[i];
      const age = (this.simTime + instance.phaseOffset) % liveTime;
      const sample = sampleKeyframes(instance.keyframes, age);

      this.scratchPosition
        .copy(instance.spawnPos)
        .addScaledVector(this.gravity, age)
        .add(sample.powerDisplacement);
      this.scratchScale.setScalar(sample.scale);

      const xrotRad = (sample.xrot * Math.PI) / 180;
      const yrotRad = (sample.yrot * Math.PI) / 180;
      const zrotRad = (sample.zrot * Math.PI) / 180;

      if (useBillboard) {
        // Applied on top of the camera-facing orientation (post-multiplied
        // local rotations), same as zrot always has been - xrot/yrot tilt
        // the billboarded quad relative to its own camera-facing plane
        // rather than trying to resolve against it globally. Matches
        // Object3D.rotateX/Y/Z's own convention (successive post-
        // multiplies), replicated by hand here since there's no real
        // Object3D per instance to call those methods on any more.
        this.scratchQuat
          .copy(this.billboardBaseQuat)
          .multiply(this.scratchSpinQuat.setFromAxisAngle(X_AXIS, xrotRad))
          .multiply(this.scratchSpinQuat.setFromAxisAngle(Y_AXIS, yrotRad))
          .multiply(this.scratchSpinQuat.setFromAxisAngle(Z_AXIS, zrotRad));
      } else {
        // Matches Object3D.rotation.set(x, y, z)'s own default 'XYZ' Euler
        // order - composed as successive intrinsic rotations, same as
        // three's own Quaternion.setFromEuler does for that order.
        this.scratchQuat
          .setFromAxisAngle(X_AXIS, xrotRad)
          .multiply(this.scratchSpinQuat.setFromAxisAngle(Y_AXIS, yrotRad))
          .multiply(this.scratchSpinQuat.setFromAxisAngle(Z_AXIS, zrotRad));
      }

      this.scratchMatrix.compose(this.scratchPosition, this.scratchQuat, this.scratchScale);
      instancedMesh.setMatrixAt(i, this.scratchMatrix);

      // Per-instance alpha is baked into the color's own magnitude, not
      // tracked as real per-instance alpha - see the class doc comment on
      // why that's exactly equivalent for AdditiveBlending.
      this.scratchColor.copy(sample.color).multiplyScalar(sample.alpha / 255);
      instancedMesh.setColorAt(i, this.scratchColor);
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.instancedMesh?.parent?.remove(this.instancedMesh);
    this.instancedMesh?.dispose();
    this.instancedMesh = null;
    this.material?.dispose();
    this.material = null;
    this.instances = [];
  }
}
