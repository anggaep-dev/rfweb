import { Matrix4, Quaternion, Vector3 } from 'three';
import { convertQuat, convertVec3 } from './coords';

const eucKrDecoder = new TextDecoder('euc-kr');
const asciiDecoder = new TextDecoder('ascii');

/** Little-endian cursor reader for RF Online's client binary formats. */
export class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get byteLength() {
    return this.view.byteLength;
  }

  seek(relativeBytes: number) {
    this.offset += relativeBytes;
  }

  u8() {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8() {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16() {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i16() {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i32() {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32() {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  /** Fixed-length, possibly null-terminated string. */
  fixedString(lengthInBytes: number, encoding: 'ascii' | 'euc-kr' = 'ascii') {
    const raw = this.bytes.subarray(this.offset, this.offset + lengthInBytes);
    this.offset += lengthInBytes;
    let end = raw.indexOf(0);
    if (end < 0) end = raw.length;
    const decoder = encoding === 'ascii' ? asciiDecoder : eucKrDecoder;
    return decoder.decode(raw.subarray(0, end));
  }

  /** Raw vector, no coordinate conversion. */
  vec3Raw(out = new Vector3()): Vector3 {
    const x = this.f32();
    const y = this.f32();
    const z = this.f32();
    return out.set(x, y, z);
  }

  /** Vector converted from 3ds Max space to three.js space. */
  vec3(out = new Vector3()): Vector3 {
    const x = this.f32();
    const y = this.f32();
    const z = this.f32();
    return convertVec3(x, y, z, out);
  }

  /** Quaternion (stored XYZW) converted from 3ds Max space to three.js space. */
  quat(out = new Quaternion()): Quaternion {
    const x = this.f32();
    const y = this.f32();
    const z = this.f32();
    const w = this.f32();
    return convertQuat(x, y, z, w, out);
  }

  /**
   * Raw 4x4 matrix. The file stores 16 floats in column-major order, which
   * matches THREE.Matrix4's own internal element layout, so no reshaping is
   * needed beyond a direct load.
   */
  matrix4Raw(out = new Matrix4()): Matrix4 {
    const arr = new Array<number>(16);
    for (let i = 0; i < 16; i++) arr[i] = this.f32();
    return out.fromArray(arr);
  }
}
