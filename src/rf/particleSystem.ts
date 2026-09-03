import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial, Object3D, SRGBColorSpace, Vector3 } from 'three';
import type { Camera } from 'three';
import { parseR3E } from './r3e';
import type { R3EMesh } from './r3e';
import { parseParticleTemplate, resolveNumberOrRange } from './particleTemplate';
import type { ParticleTemplate } from './particleTemplate';

const CHEF_BASE = '/game-assets/Chef';

function chefPathToUrl(clientPath: string): string {
  const normalized = clientPath.replace(/\\/g, '/').replace(/^\.?\/?Chef\/?/i, '');
  return `${CHEF_BASE}/${normalized}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

const r3eGeometryCache = new Map<string, Promise<BufferGeometry | null>>();

function loadR3EGeometry(clientPath: string): Promise<BufferGeometry | null> {
  let cached = r3eGeometryCache.get(clientPath);
  if (!cached) {
    const url = chefPathToUrl(clientPath);
    cached = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
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
    const url = chefPathToUrl(sptPath);
    cached = fetchText(url)
      .then(parseParticleTemplate)
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
  scale: number;
  color: Color;
}

interface ParticleInstance {
  mesh: Mesh;
  material: MeshBasicMaterial;
  spawnPos: Vector3;
  keyframes: ResolvedKeyframe[];
}

/** RF's particle colors are plain 0-255 display-referred RGB bytes, same as any other color this project reads off disk - explicit SRGBColorSpace here matches texture.ts's own convention, rather than three.js's default of treating raw Color() components as already-linear (which visibly shifts the result - verified against a real file while building this). */
function colorFromRgb255(r: number, g: number, b: number): Color {
  return new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
}

function resolveKeyframes(template: ParticleTemplate): ResolvedKeyframe[] {
  const start: ResolvedKeyframe = {
    time: 0,
    alpha: resolveNumberOrRange(template.startAlpha),
    zrot: resolveNumberOrRange(template.startZRot),
    scale: resolveNumberOrRange(template.startScale),
    color: colorFromRgb255(...template.startColor),
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
      scale: kf.scale ? resolveNumberOrRange(kf.scale) : prev.scale,
      color: kf.color ? colorFromRgb255(...kf.color) : prev.color.clone(),
    };
    resolved.push(next);
    prev = next;
  }

  return resolved;
}

/** Piecewise-linear interpolation across a particle's own resolved keyframe curve. Holds the first/last value outside the curve's own time range. */
function sampleKeyframes(keyframes: ResolvedKeyframe[], age: number): { alpha: number; zrot: number; scale: number; color: Color } {
  if (age <= keyframes[0].time) return keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (age >= last.time) return last;

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
  return {
    alpha: prev.alpha + (curr.alpha - prev.alpha) * t,
    zrot: prev.zrot + (curr.zrot - prev.zrot) * t,
    scale: prev.scale + (curr.scale - prev.scale) * t,
    color: prev.color.clone().lerp(curr.color, t),
  };
}

/**
 * A running instance of one `.spt` template: `num` copies of its `.R3E`
 * entity mesh, looping through the same keyframed alpha/color/scale/zrot
 * curve (each instance rolling its own `rand()` values once at creation,
 * not shared - see resolveKeyframes) while drifting under `gravity`.
 * Attach `.group` under whatever the effect should follow (a weapon bone,
 * a socket dummy, ...) and call `update()` once a frame.
 */
export class ParticleEffect {
  readonly group = new Object3D();

  private template: ParticleTemplate | null = null;
  private instances: ParticleInstance[] = [];
  private simTime = 0;
  private disposed = false;
  private readonly gravity = new Vector3();

  /** Resolves the template + its entity mesh and spawns all instances. Safe to call once; the effect renders nothing until this resolves. */
  async load(sptPath: string): Promise<void> {
    const template = await loadParticleTemplate(sptPath);
    if (this.disposed || !template || !template.entityFile) return;

    const geometry = await loadR3EGeometry(template.entityFile);
    if (this.disposed || !geometry) return;

    this.template = template;
    for (let i = 0; i < template.num; i++) {
      const material = new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      this.group.add(mesh);
      this.instances.push({
        mesh,
        material,
        spawnPos: new Vector3(...template.posBox),
        keyframes: resolveKeyframes(template),
      });
    }
  }

  /**
   * Advances the shared loop clock and every instance's position/scale/
   * color/alpha. `camera` is only used for billboarded templates (the
   * common case - see particleTemplate.ts) to face each particle toward
   * it; non-billboard templates ignore it and keep the entity mesh's own
   * authored orientation, only spinning it around Z by the resolved zrot.
   */
  update(delta: number, camera: Camera | null): void {
    const template = this.template;
    if (!template) return;

    this.simTime += delta * template.timeSpeed;
    const age = this.simTime % Math.max(template.liveTime, 1e-6);
    this.gravity.set(...template.gravity);

    for (const instance of this.instances) {
      const sample = sampleKeyframes(instance.keyframes, age);
      instance.material.opacity = sample.alpha / 255;
      instance.material.color.copy(sample.color);
      instance.mesh.scale.setScalar(sample.scale);
      instance.mesh.position.copy(instance.spawnPos).addScaledVector(this.gravity, age);

      if (template.billboard && camera) {
        instance.mesh.quaternion.copy(camera.quaternion);
        instance.mesh.rotateZ((sample.zrot * Math.PI) / 180);
      } else {
        instance.mesh.rotation.set(0, 0, (sample.zrot * Math.PI) / 180);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const instance of this.instances) {
      instance.mesh.parent?.remove(instance.mesh);
      instance.material.dispose();
    }
    this.instances = [];
  }
}
