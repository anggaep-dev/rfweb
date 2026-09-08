/**
 * Parses `.r3t` "texture container" files - the sibling of `.r3m` (see
 * r3m.ts's own doc comment for why this exists and where it's used).
 * Ported from the vendored reference addon's own working reader
 * (`RFShared.get_color_texture_dictionary_from_r3t_filestream` in
 * `extra/cbb-rf-online-addon-main/cbb_rf_online_addon/rf_shared.py`).
 *
 * Binary, little-endian:
 * ```
 * f32  version                 (1.2 in every real file checked)
 * u32  textureAmount
 * textureAmount × fixedString(128, euc-kr) name  (a full client path, e.g.
 *   ".\Unick_up\C_W_TSWORD\400p\aa.dds" - not needed for lookup (texture
 *   id is what a real .r3m's own TextureLayer.textureId references, see
 *   r3m.ts), kept only for debug display)
 * textureAmount × {
 *   u32   size                 (128-byte header + raw DDS body)
 *   byte[size]  ddsData        (a complete, ready-to-decode DDS file -
 *     the 128-byte header is individually XOR-"encrypted" with the exact
 *     same 128-byte password this project's own .RFT character textures
 *     use, whenever it doesn't already start with the literal "DDS "
 *     magic - reuses decodeRftTexture directly for this, no separate
 *     crypto code needed; the remaining size-128 bytes are already plain)
 * }
 * ```
 * `textureId` in a real `.r3m`'s TextureLayer is 1-based, matching this
 * array's own natural iteration order (texture 1 = the first entry) -
 * verified byte-exact against a real file with both material systems
 * side by side (`Chef/Unick_up/C_W_TSWORD/400p/aura.r3t`): its lone
 * texture's declared name ends in "aa.dds" (that same folder's own loose
 * texture), decrypting its embedded 128-byte header produces the exact
 * same bytes as that loose `aa.dds`'s own real header, and parsing
 * consumes every byte of the file with nothing left over.
 */

const NAME_FIELD_SIZE = 128;

function readFixedString(view: DataView, offset: number, length: number, encoding: string): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  let end = 0;
  while (end < length && bytes[end] !== 0) end++;
  return new TextDecoder(encoding).decode(bytes.subarray(0, end));
}

export interface R3TEntry {
  name: string;
  /** Raw, still-encrypted-if-applicable DDS bytes (header + body) - pass to decodeRftTexture (texture.ts), which already handles both the encrypted and plain cases transparently. */
  data: ArrayBuffer;
}

/** 1-based texture id -> its entry, matching a real .r3m TextureLayer.textureId's own indexing. */
export function parseR3T(buffer: ArrayBuffer): Map<number, R3TEntry> {
  const view = new DataView(buffer);
  let offset = 4; // version - not enforced, see this module's own doc comment
  const textureAmount = view.getUint32(offset, true);
  offset += 4;

  const names: string[] = [];
  for (let i = 0; i < textureAmount; i++) {
    names.push(readFixedString(view, offset, NAME_FIELD_SIZE, 'euc-kr'));
    offset += NAME_FIELD_SIZE;
  }

  const result = new Map<number, R3TEntry>();
  for (let i = 0; i < textureAmount; i++) {
    const size = view.getUint32(offset, true);
    offset += 4;
    const data = buffer.slice(offset, offset + size);
    offset += size;
    result.set(i + 1, { name: names[i], data });
  }

  return result;
}
