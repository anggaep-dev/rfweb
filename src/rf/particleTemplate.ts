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
 * - Two more real keys, confirmed on a genuine weapon-aura template
 *   (`Chef/Unick_up/C_W_TSWORD/400p.spt`, found while investigating why
 *   this project's own flat billboard glow didn't match the real client's
 *   look - see ParticleEffect.load): `start_power` (an initial per-axis
 *   launch velocity, `rand()`-able like any other field - see
 *   ParticleTemplate.startPower's own doc comment on how this project
 *   models it) and `creat_time_epsilon` (a per-instance spawn-time
 *   stagger in seconds, so a multi-instance template reads as a
 *   continuous stream rather than every copy pulsing in lockstep).
 * - `create_time_epsilon` (correctly spelled) is a real, common alternate
 *   spelling of `creat_time_epsilon` above - confirmed on 25 real files
 *   that use it instead. Both are accepted as the same key; missing this
 *   silently dropped those 25 files' spawn-stagger entirely (each
 *   instance pulsed in lockstep instead of streaming).
 * - `power x y z`, `xrot <n>`, `yrot <n>` are real per-keyframe fields
 *   (inside a `time <t> { ... }` block, alongside the already-modeled
 *   `alpha`/`zrot`/`scale`/`color`) - confirmed on real files (`Chef/
 *   55LV_SHIELD/BC_A_LSHIELD_169/fire.spt` has both `start_power`/
 *   `start_zrot` at the template level *and* `power`/`yrot` changing at
 *   each keyframe). `power` is `start_power`'s per-keyframe counterpart -
 *   the drift velocity used for that portion of the particle's life, not
 *   a one-time launch value (see particleSystem.ts's ResolvedKeyframe/
 *   sampleKeyframes for how this project integrates a value that changes
 *   over time rather than just interpolating it directly like alpha/
 *   scale/color). `xrot`/`yrot` are `zrot`'s counterparts on the other
 *   two axes - `start_yrot` is confirmed real at the template level too
 *   (`Chef/50LV_WEAPON/791p.spt`); no real file uses `start_xrot`, but
 *   it's accepted defensively the same way `start_yrot` is.
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
  xrot?: NumberOrRange;
  yrot?: NumberOrRange;
  color?: [number, number, number];
  scale?: NumberOrRange;
  /** `power x y z` - this keyframe's own drift velocity, replacing whichever value (startPower, or an earlier keyframe's own power) was in effect before it - see the module doc comment and particleSystem.ts's ResolvedKeyframe for how this differs from the other (directly-interpolated) keyframe fields. */
  power?: [NumberOrRange, NumberOrRange, NumberOrRange];
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
  /** Constant per-second position drift applied over a particle's life (see the format doc). */
  gravity: [number, number, number];
  /** A second, independent constant per-second position drift, added alongside gravity (see the format doc's own note on why this project doesn't distinguish "initial velocity" from "ongoing force" - both are the same simple linear-in-age model here) - confirmed real on a real weapon aura template (`Chef/Unick_up/C_W_TSWORD/400p.spt`'s "start_power 2 0 0"), each axis independently rand()-able same as any other field. Defaults to zero for the common case of a template that doesn't set it. */
  startPower: [NumberOrRange, NumberOrRange, NumberOrRange];
  startScale: NumberOrRange;
  startColor: [number, number, number];
  startAlpha: NumberOrRange;
  startZRot: NumberOrRange;
  /** `start_yrot` - confirmed real (`Chef/50LV_WEAPON/791p.spt`), same shape as startZRot. Defaults to zero. */
  startYRot: NumberOrRange;
  /** `start_xrot` - never seen set in a real file, but accepted defensively the same way startYRot is (see the module doc comment). Defaults to zero. */
  startXRot: NumberOrRange;
  alphaType: number;
  zFront: number;
  /** True unless `no_billboard` is present - see the module doc comment. */
  billboard: boolean;
  free: boolean;
  /** Per-instance random spawn-time *jitter*, in seconds (`creat_time_epsilon`) - each instance rolls its own `rand(0, createTimeEpsilon)` offset once at spawn, added on top of an even `i/num * liveTime` baseline stagger every multi-instance template gets regardless of this value (see particleSystem.ts's ParticleEffect) - together these keep a multi-instance template reading as a continuous staggered stream instead of every copy pulsing through the exact same keyframe curve in lockstep and visibly snapping back together at the end of each loop. The baseline alone already fixes that for a template with no epsilon at all (confirmed real and common: `Chef/PVP_Item/COM_WEAPON_TSPEAR_117/773p.spt`, `num 24`, no `creat_time_epsilon` key - reported as moving/pulsing as one synchronized blob instead of looking like continuous fire, exactly what zero stagger of any kind would produce). 0 (the default) means no *extra* jitter on top of the baseline, not "no staggering at all" - a template that does set a real epsilon (`400p.spt`'s own `creat_time_epsilon 5`, confirmed correct) simply gets both sources layered together. */
  createTimeEpsilon: number;
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

/** Same shape as parseVec3, but each axis independently accepts `rand(min,max)` - needed for `power`/`start_power`, confirmed real on a mixed-axis line ("power 0.2 rand(-2,2) -5" - see the module doc comment). */
function parseVec3OrRange(tokens: string[]): [NumberOrRange, NumberOrRange, NumberOrRange] | undefined {
  if (tokens.length < 3) return undefined;
  const x = parseNumberOrRange(tokens[0]);
  const y = parseNumberOrRange(tokens[1]);
  const z = parseNumberOrRange(tokens[2]);
  if (!x || !y || !z) return undefined;
  return [x, y, z];
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
    startPower: [fixedValue(0), fixedValue(0), fixedValue(0)],
    startScale: fixedValue(1),
    startColor: [255, 255, 255],
    startAlpha: fixedValue(255),
    startZRot: fixedValue(0),
    startYRot: fixedValue(0),
    startXRot: fixedValue(0),
    alphaType: 0,
    zFront: 0,
    billboard: true,
    free: false,
    createTimeEpsilon: 0,
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
      case 'start_power': {
        const v = parseVec3OrRange(rest);
        if (v) template.startPower = v;
        continue;
      }
      case 'creat_time_epsilon':
      case 'create_time_epsilon': {
        const v = Number.parseFloat(rest[0]);
        if (Number.isFinite(v)) template.createTimeEpsilon = v;
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
      case 'start_yrot': {
        const v = parseNumberOrRange(rest[0]);
        if (v) template.startYRot = v;
        continue;
      }
      case 'start_xrot': {
        const v = parseNumberOrRange(rest[0]);
        if (v) template.startXRot = v;
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
      case 'xrot': {
        const v = parseNumberOrRange(rest[0]);
        if (v && currentKeyframe) currentKeyframe.xrot = v;
        continue;
      }
      case 'yrot': {
        const v = parseNumberOrRange(rest[0]);
        if (v && currentKeyframe) currentKeyframe.yrot = v;
        continue;
      }
      case 'power': {
        const v = parseVec3OrRange(rest);
        if (v && currentKeyframe) currentKeyframe.power = v;
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
