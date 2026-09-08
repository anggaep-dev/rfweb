/**
 * Parses `.r3m` "material" files - the material system a real `.R3E`
 * particle/effect entity uses when it comes from a `Chef/ChefEntityN.rpk`
 * archive (see scripts/extract_rpk.mjs), as opposed to the separate
 * `.mst`/`MainMaterial.mst` convention used by originally-loose entities
 * (see materialScript.ts). Not reverse-engineered from scratch - ported
 * from the vendored reference addon's own working reader
 * (`RFShared.get_materials_from_r3m_filestream` in `extra/
 * cbb-rf-online-addon-main/cbb_rf_online_addon/rf_shared.py`) and verified
 * byte-exact against a real file that happens to have both material
 * systems side by side (`Chef/Unick_up/C_W_TSWORD/400p/aura.r3m`): its
 * parsed material name ("1_-_Default_0") matches that same folder's own
 * loose `1_-_Default_0.mst` filename exactly, and parsing consumes every
 * byte of the file with nothing left over.
 *
 * Binary, little-endian:
 * ```
 * f32  version                 (1.1 in the one real file checked)
 * u32  materialAmount
 * materialAmount × {
 *   u32  layerNum
 *   u32  flag                  (not modeled - no real use for it yet)
 *   i32  detailSurface         (not modeled)
 *   f32  detailScale           (not modeled)
 *   fixedString(128, euc-kr) name
 *   layerNum × 46-byte TextureLayer record (see readTextureLayer) - only
 *     `textureId` (a 1-based index into a real .r3t's own texture
 *     dictionary, see r3t.ts) is modeled; every other field the reference
 *     addon reads (UV scroll/rotate/scale, alpha flicker, animated-texture
 *     frame/speed, gradient alpha - the same *kind* of per-layer animation
 *     data materialScript.ts's `.mst` layers already carry) has no
 *     consumer here yet.
 * }
 * ```
 */

export interface R3MTextureLayer {
  /** 1-based index into a real .r3t file's own texture dictionary (see r3t.ts) - 0 or negative means "no texture" (not seen in a real file yet, but the reference addon's own field is signed, so treated as possible). */
  textureId: number;
}

export interface R3MMaterial {
  name: string;
  textureLayers: R3MTextureLayer[];
}

const TEXTURE_LAYER_SIZE = 46;
const NAME_FIELD_SIZE = 128;

function readFixedString(view: DataView, offset: number, length: number, encoding: string): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  let end = 0;
  while (end < length && bytes[end] !== 0) end++;
  return new TextDecoder(encoding).decode(bytes.subarray(0, end));
}

function readTextureLayer(view: DataView, offset: number): R3MTextureLayer {
  // Byte layout confirmed against the reference addon's own unpack format
  // ("h i I I I h h h h h h h h h h H h h h", 46 bytes) - only the second
  // field (textureId, a signed i32 at relative offset 2) is modeled here.
  const textureId = view.getInt32(offset + 2, true);
  return { textureId };
}

export function parseR3M(buffer: ArrayBuffer): R3MMaterial[] {
  const view = new DataView(buffer);
  let offset = 4; // version - not enforced, see this module's own doc comment
  const materialAmount = view.getUint32(offset, true);
  offset += 4;

  const materials: R3MMaterial[] = [];
  for (let i = 0; i < materialAmount; i++) {
    const layerNum = view.getUint32(offset, true);
    offset += 4 + 4 + 4 + 4; // layerNum already read; flag, detailSurface, detailScale - not modeled
    const name = readFixedString(view, offset, NAME_FIELD_SIZE, 'euc-kr');
    offset += NAME_FIELD_SIZE;

    const textureLayers: R3MTextureLayer[] = [];
    for (let l = 0; l < layerNum; l++) {
      textureLayers.push(readTextureLayer(view, offset));
      offset += TEXTURE_LAYER_SIZE;
    }
    materials.push({ name, textureLayers });
  }

  return materials;
}
