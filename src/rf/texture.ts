import {
  CompressedTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
} from 'three';
import type { CompressedPixelFormat } from 'three';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';

/**
 * RF Online's .RFT files are DDS textures whose 128-byte header is XORed
 * with a fixed password (the same "unlock_dds" scheme the client used for
 * .r3t material atlases). Pixel data after the header is untouched.
 */
const RFT_PASSWORD_BYTES = new Uint8Array([
  0x2e, 0x80, 0x4d, 0x76, 0x2e, 0xf8, 0xd1, 0xf0, 0xbd, 0x3f, 0x86, 0x81, 0x58, 0x2c, 0x3f, 0x3f, 0x2e, 0x2e, 0x67,
  0x6f, 0x3f, 0x40, 0x3f, 0x78, 0x3c, 0x3f, 0xf1, 0xc0, 0xa5, 0xf6, 0x3b, 0x9f, 0xc1, 0x20, 0x3f, 0xd7, 0xc8, 0xc1,
  0xe9, 0x85, 0x86, 0xbd, 0xef, 0x56, 0x3f, 0xa1, 0xfb, 0x2e, 0x87, 0x86, 0x61, 0x4c, 0x21, 0x3b, 0x4e, 0xb4, 0x78,
  0x57, 0xae, 0x97, 0x3f, 0x2e, 0x4a, 0x2e, 0x3f, 0x4c, 0x2e, 0x44, 0xcd, 0xc5, 0x5f, 0xe8, 0xe9, 0xec, 0xeb, 0xbd,
  0xbe, 0xbb, 0xf7, 0x6c, 0x2e, 0xf2, 0xe4, 0x2e, 0x3f, 0x3f, 0x97, 0x9f, 0x9d, 0xb3, 0x21, 0xb9, 0x76, 0x65, 0x54,
  0x3f, 0xe6, 0xf6, 0xc6, 0xf0, 0x79, 0xdb, 0xe2, 0xb2, 0x4b, 0x2e, 0x2e, 0xeb, 0xd3, 0xd3, 0xca, 0xab, 0xea, 0xc7,
  0xed, 0x9c, 0xc7, 0xd9, 0xd0, 0x65, 0x48, 0xb4, 0xfa, 0x35, 0x2e, 0x2e, 0x6a, 0x9b,
]);

const DDS_MAGIC = 0x20534444; // 'DDS ' little-endian

// three.js CompressedPixelFormat constants for the two DXT variants RF's
// asset archives actually contain (verified by decoding every .RFT entry
// across the base race archives: DXT1 and DXT5 only, no DXT3).
const RGBA_S3TC_DXT1_FORMAT = 33776;
const RGBA_S3TC_DXT5_FORMAT = 33778;

function decodeRft(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) === DDS_MAGIC) {
    return buffer;
  }
  const decoded = bytes.slice();
  for (let i = 0; i < 128; i++) {
    decoded[i] ^= RFT_PASSWORD_BYTES[i];
  }
  return decoded.buffer;
}

let s3tcSupported: boolean | null = null;

/**
 * Most mobile GPUs (iOS Safari in particular) don't expose the
 * WEBGL_compressed_texture_s3tc extension, so uploading a CompressedTexture
 * silently fails there - the mesh renders but with no map, falling back to
 * the flat gray material color. Probed once via a throwaway canvas/context
 * and cached; nothing here is tied to the renderer actually used later.
 */
function isS3TCSupported(): boolean {
  if (s3tcSupported !== null) return s3tcSupported;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) {
      s3tcSupported = false;
      return s3tcSupported;
    }
    const ext =
      gl.getExtension('WEBGL_compressed_texture_s3tc') ||
      gl.getExtension('WEBKIT_WEBGL_compressed_texture_s3tc');
    s3tcSupported = !!ext;
  } catch {
    s3tcSupported = false;
  }
  return s3tcSupported;
}

function rgb565ToRgb888(c: number): [number, number, number] {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function writeTexel(out: Uint8ClampedArray, outW: number, outH: number, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x >= outW || y >= outH) return;
  const o = (y * outW + x) * 4;
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  out[o + 3] = a;
}

/** Decodes one 8-byte BC1/DXT1 block into `out` at pixel origin (bx, by). */
function decodeDXT1Block(data: Uint8Array, offset: number, out: Uint8ClampedArray, outW: number, outH: number, bx: number, by: number) {
  const color0 = data[offset] | (data[offset + 1] << 8);
  const color1 = data[offset + 2] | (data[offset + 3] << 8);
  const [r0, g0, b0] = rgb565ToRgb888(color0);
  const [r1, g1, b1] = rgb565ToRgb888(color1);

  let colors: [number, number, number, number][];
  if (color0 > color1) {
    colors = [
      [r0, g0, b0, 255],
      [r1, g1, b1, 255],
      [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255],
      [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255],
    ];
  } else {
    colors = [
      [r0, g0, b0, 255],
      [r1, g1, b1, 255],
      [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255],
      [0, 0, 0, 0],
    ];
  }

  const indexBits =
    (data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24)) >>> 0;
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const pixelIdx = py * 4 + px;
      const idx = (indexBits >>> (2 * pixelIdx)) & 0x3;
      const [r, g, b, a] = colors[idx];
      writeTexel(out, outW, outH, bx + px, by + py, r, g, b, a);
    }
  }
}

/** Decodes one 16-byte BC3/DXT5 block into `out` at pixel origin (bx, by). */
function decodeDXT5Block(data: Uint8Array, offset: number, out: Uint8ClampedArray, outW: number, outH: number, bx: number, by: number) {
  const alpha0 = data[offset];
  const alpha1 = data[offset + 1];
  const av = new Uint8Array(8);
  av[0] = alpha0;
  av[1] = alpha1;
  if (alpha0 > alpha1) {
    av[2] = Math.round((6 * alpha0 + 1 * alpha1) / 7);
    av[3] = Math.round((5 * alpha0 + 2 * alpha1) / 7);
    av[4] = Math.round((4 * alpha0 + 3 * alpha1) / 7);
    av[5] = Math.round((3 * alpha0 + 4 * alpha1) / 7);
    av[6] = Math.round((2 * alpha0 + 5 * alpha1) / 7);
    av[7] = Math.round((1 * alpha0 + 6 * alpha1) / 7);
  } else {
    av[2] = Math.round((4 * alpha0 + 1 * alpha1) / 5);
    av[3] = Math.round((3 * alpha0 + 2 * alpha1) / 5);
    av[4] = Math.round((2 * alpha0 + 3 * alpha1) / 5);
    av[5] = Math.round((1 * alpha0 + 4 * alpha1) / 5);
    av[6] = 0;
    av[7] = 255;
  }

  // 48 bits of 3-bit-per-pixel alpha indices, split into two 24-bit halves
  // (pixels 0-7, then 8-15) to stay in safe integer / bitwise range.
  const aLow = data[offset + 2] | (data[offset + 3] << 8) | (data[offset + 4] << 16);
  const aHigh = data[offset + 5] | (data[offset + 6] << 8) | (data[offset + 7] << 16);
  const alphaIndices = new Uint8Array(16);
  for (let i = 0; i < 8; i++) alphaIndices[i] = (aLow >> (3 * i)) & 0x7;
  for (let i = 0; i < 8; i++) alphaIndices[8 + i] = (aHigh >> (3 * i)) & 0x7;

  const colorOffset = offset + 8;
  const color0 = data[colorOffset] | (data[colorOffset + 1] << 8);
  const color1 = data[colorOffset + 2] | (data[colorOffset + 3] << 8);
  const [r0, g0, b0] = rgb565ToRgb888(color0);
  const [r1, g1, b1] = rgb565ToRgb888(color1);
  // DXT5's color block always uses 4-way interpolation (no punch-through
  // alpha, since alpha is carried separately above).
  const colors: [number, number, number][] = [
    [r0, g0, b0],
    [r1, g1, b1],
    [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3],
    [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3],
  ];
  const indexBits =
    (data[colorOffset + 4] | (data[colorOffset + 5] << 8) | (data[colorOffset + 6] << 16) | (data[colorOffset + 7] << 24)) >>>
    0;

  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const pixelIdx = py * 4 + px;
      const cIdx = (indexBits >>> (2 * pixelIdx)) & 0x3;
      const [r, g, b] = colors[cIdx];
      const a = av[alphaIndices[pixelIdx]];
      writeTexel(out, outW, outH, bx + px, by + py, r, g, b, a);
    }
  }
}

/**
 * CPU-decompresses a single BC1/BC3 mip level into a plain RGBA buffer, for
 * devices that can't upload S3TC-compressed textures directly. Only the
 * base level is decoded - the resulting DataTexture is uploaded uncompressed
 * and asked to generate its own mip chain on the GPU instead.
 */
function decompressBlockTexture(data: Uint8Array, width: number, height: number, format: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const blockSize = format === RGBA_S3TC_DXT1_FORMAT ? 8 : 16;
  const blocksWide = Math.ceil(width / 4);
  const blocksHigh = Math.ceil(height / 4);
  let offset = 0;
  for (let by = 0; by < blocksHigh; by++) {
    for (let bx = 0; bx < blocksWide; bx++) {
      if (format === RGBA_S3TC_DXT1_FORMAT) {
        decodeDXT1Block(data, offset, out, width, height, bx * 4, by * 4);
      } else {
        decodeDXT5Block(data, offset, out, width, height, bx * 4, by * 4);
      }
      offset += blockSize;
    }
  }
  return out;
}

/** Decodes an already-in-memory .RFT buffer (e.g. sliced out of a parsed .RFS archive). */
export function decodeRftTexture(rawBuffer: ArrayBuffer): Texture {
  const ddsBuffer = decodeRft(rawBuffer);

  const loader = new DDSLoader();
  const ddsData = loader.parse(ddsBuffer, true);
  const format = ddsData.format as number;

  if (!isS3TCSupported() && (format === RGBA_S3TC_DXT1_FORMAT || format === RGBA_S3TC_DXT5_FORMAT)) {
    const base = ddsData.mipmaps[0];
    const rgba = decompressBlockTexture(new Uint8Array(base.data.buffer, base.data.byteOffset, base.data.byteLength), base.width, base.height, format);
    const texture = new DataTexture(rgba, base.width, base.height, RGBAFormat);
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  const texture = new CompressedTexture(
    ddsData.mipmaps,
    ddsData.width,
    ddsData.height,
    format as CompressedPixelFormat,
  );
  texture.minFilter = ddsData.mipmapCount > 1 ? LinearMipmapLinearFilter : LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export async function loadRftTexture(url: string): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch texture at ${url}: ${response.status}`);
  const rawBuffer = await response.arrayBuffer();
  return decodeRftTexture(rawBuffer);
}
