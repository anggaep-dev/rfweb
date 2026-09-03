/**
 * Parses `.spt` particle templates - plain text, not binary (see
 * docs/rf-format-notes.md's "`.spt` particle template" section for the
 * original key reference this was researched from). Verified against real
 * files under `Chef/` rather than only the tutorial's own worked example,
 * which turned out to differ in a few real ways:
 *
 * - Most keys are underscored in real files (`entity_file`, `live_time`,
 *   `time_speed`, ...), not space-separated like the tutorial's one
 *   example showed - `pos box` is the sole confirmed real exception, still
 *   two tokens. Both spellings are accepted defensively.
 * - `;` starts a line comment - real files comment out disabled keys
 *   in-place (e.g. `;start_time_range 0.1`) rather than deleting them.
 * - Almost any numeric field can be `rand(min,max)` instead of a plain
 *   number, not just `start_zrot`/`zrot` - seen on `start_scale` and
 *   `scale` too in real files.
 * - Two boolean flag keywords not in the original key reference:
 *   `no_billboard` (particles face the camera like a sprite by default;
 *   this opts out, keeping the entity mesh's own authored orientation -
 *   makes sense for e.g. a flat "aura.R3E" quad wanting to always face
 *   the viewer vs. a real 3D shape like `shield_ntt.R3E` that shouldn't)
 *   and `free` (seen only commented-out in every real file so far -
 *   parsed and exposed, but its effect is unconfirmed).
 */

export interface NumberOrRange {
  min: number;
  max: number;
}

function fixedValue(n: number): NumberOrRange {
  return { min: n, max: n };
}

/** Picks a concrete value from a NumberOrRange - the same number every time for a fixed value, a fresh random draw each call otherwise. */
export function resolveNumberOrRange(range: NumberOrRange): number {
  if (range.min === range.max) return range.min;
  return range.min + Math.random() * (range.max - range.min);
}

export interface ParticleKeyframe {
  time: number;
  alpha?: NumberOrRange;
  zrot?: NumberOrRange;
  color?: [number, number, number];
  scale?: NumberOrRange;
}

export interface ParticleTemplate {
  /** Client-relative path (backslashes, ".\Chef\...") to the .R3E entity mesh this template spawns copies of - see resource.ts-style path conversion at the call site. */
  entityFile: string;
  /** How many instances to spawn. */
  num: number;
  posBox: [number, number, number];
  /** Loop duration in seconds, before `timeSpeed` scaling - see resolveNumberOrRange's caller for how this combines with timeSpeed. */
  liveTime: number;
  timeSpeed: number;
  /** Constant per-second position drift applied over a particle's life (see the format doc - there's no separate initial-velocity field, so this is the only source of motion). */
  gravity: [number, number, number];
  startScale: NumberOrRange;
  startColor: [number, number, number];
  startAlpha: NumberOrRange;
  startZRot: NumberOrRange;
  alphaType: number;
  zFront: number;
  /** True unless `no_billboard` is present - see the module doc comment. */
  billboard: boolean;
  free: boolean;
  /** Sorted by time ascending. */
  keyframes: ParticleKeyframe[];
}

const RAND_PATTERN = /^rand\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i;

function parseNumberOrRange(token: string | undefined): NumberOrRange | undefined {
  if (token === undefined) return undefined;
  const randMatch = RAND_PATTERN.exec(token);
  if (randMatch) return { min: Number.parseFloat(randMatch[1]), max: Number.parseFloat(randMatch[2]) };
  const n = Number.parseFloat(token);
  return Number.isFinite(n) ? fixedValue(n) : undefined;
}

function parseColor(tokens: string[]): [number, number, number] | undefined {
  if (tokens.length < 3) return undefined;
  const [r, g, b] = tokens.map(Number.parseFloat);
  if (![r, g, b].every(Number.isFinite)) return undefined;
  return [r, g, b];
}

function parseVec3(tokens: string[]): [number, number, number] | undefined {
  return parseColor(tokens);
}

/** Strips a `;` line comment (real files use it to disable keys in-place) and surrounding whitespace. */
function stripComment(line: string): string {
  const commentIndex = line.indexOf(';');
  return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trim();
}

export function parseParticleTemplate(text: string): ParticleTemplate {
  const template: ParticleTemplate = {
    entityFile: '',
    num: 0,
    posBox: [0, 0, 0],
    liveTime: 1,
    timeSpeed: 1,
    gravity: [0, 0, 0],
    startScale: fixedValue(1),
    startColor: [255, 255, 255],
    startAlpha: fixedValue(255),
    startZRot: fixedValue(0),
    alphaType: 0,
    zFront: 0,
    billboard: true,
    free: false,
    keyframes: [],
  };

  let currentKeyframe: ParticleKeyframe | null = null;
  const commitKeyframe = () => {
    if (currentKeyframe) template.keyframes.push(currentKeyframe);
    currentKeyframe = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line || line.startsWith('[')) continue;

    const tokens = line.split(/\s+/);
    const key = tokens[0].toLowerCase();
    const rest = tokens.slice(1);

    // "pos box x y z" is the one confirmed real two-token key name; "entity
    // file <path>" (space) is only in the tutorial's own example, never
    // seen in a real file (which all use "entity_file" instead), but
    // handled the same defensive way just in case.
    if (key === 'pos' && rest[0]?.toLowerCase() === 'box') {
      const v = parseVec3(rest.slice(1));
      if (v) template.posBox = v;
      continue;
    }
    if (key === 'entity' && rest[0]?.toLowerCase() === 'file') {
      template.entityFile = rest.slice(1).join(' ');
      continue;
    }

    switch (key) {
      case 'entity_file':
        template.entityFile = rest.join(' ');
        continue;
      case 'num':
        template.num = Number.parseInt(rest[0], 10) || 0;
        continue;
      case 'live_time':
      case 'live':
        template.liveTime = Number.parseFloat(rest[0]) || template.liveTime;
        continue;
      case 'time_speed':
        template.timeSpeed = Number.parseFloat(rest[0]) || template.timeSpeed;
        continue;
      case 'gravity': {
        const v = parseVec3(rest);
        if (v) template.gravity = v;
        continue;
      }
      case 'start_scale': {
        const v = parseNumberOrRange(rest[0]);
        if (v) template.startScale = v;
        continue;
      }
      case 'start_color': {
        const v = parseColor(rest);
        if (v) template.startColor = v;
        continue;
      }
      case 'start_alpha': {
        const v = parseNumberOrRange(rest[0]);
        if (v) template.startAlpha = v;
        continue;
      }
      case 'start_zrot': {
        const v = parseNumberOrRange(rest[0]);
        if (v) template.startZRot = v;
        continue;
      }
      case 'alpha_type':
        template.alphaType = Number.parseInt(rest[0], 10) || 0;
        continue;
      case 'z_front':
        template.zFront = Number.parseFloat(rest[0]) || 0;
        continue;
      case 'no_billboard':
        template.billboard = false;
        continue;
      case 'free':
        template.free = true;
        continue;
      case 'time': {
        commitKeyframe();
        const t = Number.parseFloat(rest[0]);
        if (Number.isFinite(t)) currentKeyframe = { time: t };
        continue;
      }
      case 'alpha': {
        const v = parseNumberOrRange(rest[0]);
        if (v && currentKeyframe) currentKeyframe.alpha = v;
        continue;
      }
      case 'zrot': {
        const v = parseNumberOrRange(rest[0]);
        if (v && currentKeyframe) currentKeyframe.zrot = v;
        continue;
      }
      case 'scale': {
        const v = parseNumberOrRange(rest[0]);
        if (v && currentKeyframe) currentKeyframe.scale = v;
        continue;
      }
      case 'color': {
        const v = parseColor(rest);
        if (v && currentKeyframe) currentKeyframe.color = v;
        continue;
      }
      case 'end':
        commitKeyframe();
        continue;
      default:
        // Unknown/not-yet-modeled key (e.g. start_time_range) - ignore rather than fail the whole parse.
        continue;
    }
  }
  commitKeyframe();
  template.keyframes.sort((a, b) => a.time - b.time);

  return template;
}
