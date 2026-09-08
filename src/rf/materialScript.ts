/**
 * Parses `.mst` "material script" files - plain text (Korean comments,
 * EUC-KR encoded - decode with `new TextDecoder('euc-kr')`, not utf-8/ascii,
 * or the leading `;` comment line garbles and can confuse a naive line
 * scanner), found throughout `Chef/` wherever a `.R3E` particle/effect mesh
 * needs a real material rather than just a plain texture: every
 * `Chef/<effect>/<subfolder>/MainMaterial.mst` is a small index
 * (`*MATERIAL_NUM <n>` then `{ <name> <slotId> ... }`, one line per named
 * `.mst` sibling file - see parseMaterialIndex) mapping a material slot id
 * (an `.R3E` MatGroup's own `materialId` - see r3e.ts) to another `.mst`
 * file in the same folder that actually describes one or more numbered
 * `layer { }` blocks.
 *
 * `Chef/GradeEffect/{A,B,C,D}grade.mst` (see docs/rf-format-notes.md's
 * weapon-grade-overlay section) are the simplest real case: no
 * `light_map`/`layer_num` header and no `MainMaterial.mst` indirection at
 * all, just a single bare `layer 0 { ... }` block - this module handles
 * that shape the same way as a fully-headered file (the header lines are
 * simply absent, not malformed).
 *
 * Format notes (confirmed against real Grade/weapon/mob effect files, not
 * just one example):
 * - `layer <N> { ... }` - N is redundant with array order (every real file
 *   checked numbers its layers 0, 1, 2... in order) and not otherwise used.
 * - `map_name <path>` lines often carry trailing `;`-commented alternate
 *   filenames the original artist tried (e.g. `;env5.bmp ;aurad5.DDS`) -
 *   stripped by the same comment handling as `particleTemplate.ts`'s
 *   `.spt` parser, so `mapName` only ever gets the live, uncommented path.
 * - Almost every other numeric field defaults to a sensible value if
 *   absent (a layer with none of the `uv_*`/`ani_*` keys is just a static
 *   textured overlay) - `null` on this module's `MaterialLayer` means
 *   "not present in the source file", not "explicitly zero".
 */

export interface MaterialLayer {
  /** Blend/material type selector (enum, values not enumerated by any reference found - every real layer checked so far uses 0 or 3). */
  type: number;
  /** Client-relative texture path (e.g. ".\Chef\GradeEffect\Agrade.dds") or bare filename (e.g. "aa.dds") - which form a given file uses isn't consistent, both seen. Null if this layer has no map_name line at all. */
  mapName: string | null;
  /** 0-255, same scale as color below - not a 0-100 percentage despite some real files using round numbers like 100. */
  alpha: number;
  /** 0-255 per channel. */
  color: [number, number, number];
  /** Sphere/environment-mapped UV mode (a cheap fake-reflection look, conceptually similar to applySurfaceShine's matcap technique) - seen alongside a flicker-only layer (Agrade.mst) with no scroll/scale animation at all. Not yet rendered as true env-mapping by this project (see gradeEffect.ts). */
  uvEnv: boolean;
  uvScale: number | null;
  uvScaleEnd: number | null;
  uvScaleSpeed: number | null;
  /** UV-units/second, already a plain real-world rate - unlike .eff's exponential "speed byte" encoding (see glowEffect.ts), no decoding needed. */
  uvScrollU: number | null;
  uvScrollV: number | null;
  uvRotate: number | null;
  /** Frame count for a texture-sheet flipbook animation (seen alongside ani_tex_speed on B/C/D grade overlays) - not yet rendered as an animated sheet by this project (see gradeEffect.ts). */
  aniTexFrame: number | null;
  aniTexSpeed: number | null;
  /** Flicker mode/speed selector - meaning not confirmed beyond "this layer's alpha oscillates" (real files pair it with start/end below). */
  aniAlphaFlicker: number | null;
  aniAlphaFlickerStart: number | null;
  aniAlphaFlickerEnd: number | null;
}

export interface MaterialScript {
  lightMap: boolean;
  /** In source-file layer-number order (see MaterialLayer.type's doc comment on why the "layer N" number itself isn't separately tracked). */
  layers: MaterialLayer[];
}

function emptyLayer(): MaterialLayer {
  return {
    type: 0,
    mapName: null,
    alpha: 255,
    color: [255, 255, 255],
    uvEnv: false,
    uvScale: null,
    uvScaleEnd: null,
    uvScaleSpeed: null,
    uvScrollU: null,
    uvScrollV: null,
    uvRotate: null,
    aniTexFrame: null,
    aniTexSpeed: null,
    aniAlphaFlicker: null,
    aniAlphaFlickerStart: null,
    aniAlphaFlickerEnd: null,
  };
}

/** Strips a `;` line comment (real files use it both for genuine remarks and to disable/list-alongside keys in-place) and surrounding whitespace - same convention as particleTemplate.ts's `.spt` parser. */
function stripComment(line: string): string {
  const commentIndex = line.indexOf(';');
  return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trim();
}

function parseColor(tokens: string[]): [number, number, number] | undefined {
  if (tokens.length < 3) return undefined;
  const [r, g, b] = tokens.map(Number.parseFloat);
  if (![r, g, b].every(Number.isFinite)) return undefined;
  return [r, g, b];
}

export function parseMaterialScript(text: string): MaterialScript {
  const script: MaterialScript = { lightMap: false, layers: [] };
  let current: MaterialLayer | null = null;

  const commitLayer = () => {
    if (current) script.layers.push(current);
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const tokens = line.split(/\s+/);
    const key = tokens[0].toLowerCase();
    const rest = tokens.slice(1);

    if (key === '{') {
      current = emptyLayer();
      continue;
    }
    if (key === '}') {
      commitLayer();
      continue;
    }
    // "layer N" marker line - the following "{" is what actually opens the
    // block; N itself is redundant with array order (see MaterialScript's
    // own doc comment).
    if (key === 'layer') continue;
    if (key === 'light_map') {
      script.lightMap = /^true$/i.test(rest[0] ?? '');
      continue;
    }
    if (key === 'layer_num') continue; // redundant with script.layers.length once parsing finishes

    if (!current) continue; // a header-region key this module doesn't model (or a malformed line) - ignore rather than fail the whole parse

    switch (key) {
      case 'type':
        current.type = Number.parseInt(rest[0], 10) || 0;
        continue;
      case 'map_name':
        current.mapName = rest[0] ?? null;
        continue;
      case 'alpha': {
        const v = Number.parseFloat(rest[0]);
        if (Number.isFinite(v)) current.alpha = v;
        continue;
      }
      case 'color': {
        const v = parseColor(rest);
        if (v) current.color = v;
        continue;
      }
      case 'uv_env':
        current.uvEnv = rest[0] === '1';
        continue;
      case 'uv_scale':
        current.uvScale = Number.parseFloat(rest[0]);
        continue;
      case 'uv_scale_end':
        current.uvScaleEnd = Number.parseFloat(rest[0]);
        continue;
      case 'uv_scale_speed':
        current.uvScaleSpeed = Number.parseFloat(rest[0]);
        continue;
      case 'uv_scroll_u':
        current.uvScrollU = Number.parseFloat(rest[0]);
        continue;
      case 'uv_scroll_v':
        current.uvScrollV = Number.parseFloat(rest[0]);
        continue;
      case 'uv_rotate':
        current.uvRotate = Number.parseFloat(rest[0]);
        continue;
      case 'ani_tex_frame':
        current.aniTexFrame = Number.parseInt(rest[0], 10);
        continue;
      case 'ani_tex_speed':
        current.aniTexSpeed = Number.parseFloat(rest[0]);
        continue;
      case 'ani_alpha_flicker':
        current.aniAlphaFlicker = Number.parseFloat(rest[0]);
        continue;
      case 'ani_alpha_flicker_start':
        current.aniAlphaFlickerStart = Number.parseFloat(rest[0]);
        continue;
      case 'ani_alpha_flicker_end':
        current.aniAlphaFlickerEnd = Number.parseFloat(rest[0]);
        continue;
      default:
        // Unknown/not-yet-modeled key - ignore rather than fail the whole parse.
        continue;
    }
  }
  commitLayer();

  return script;
}

export interface MaterialIndexEntry {
  /** The sibling `.mst` file's own base name (no `.mst` extension) - fetch `<name>.mst` in the same folder and parseMaterialScript it for the actual layer data. */
  name: string;
  /** Matches an `.R3E` MatGroup's `materialId` (see r3e.ts). */
  slot: number;
}

/**
 * Parses a `MainMaterial.mst` index file - `*MATERIAL_NUM <n>` (informational
 * only, not needed to parse the rest - every real line inside `{ }` is read
 * regardless of what this says) then `{ <name> <slot>` pairs, one per line,
 * `}`. Confirmed real shape (`Chef/Unick_up/C_W_TSWORD/400p/MainMaterial.mst`):
 * ```
 * *MATERIAL_NUM 1
 * {
 * 1_-_Default_0	0
 * }
 * ```
 */
export function parseMaterialIndex(text: string): MaterialIndexEntry[] {
  const entries: MaterialIndexEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line || line.startsWith('*') || line === '{' || line === '}') continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const slot = Number.parseInt(tokens[1], 10);
    if (Number.isFinite(slot)) entries.push({ name: tokens[0], slot });
  }
  return entries;
}
