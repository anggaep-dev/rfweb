import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * RF Online's client formats (.msh/.bn/.ani) store transforms in 3ds Max's
 * coordinate space (Z-up). Three.js is Y-up. Both are right-handed, and the
 * conversion below is a fixed proper-rotation change of basis (verified
 * against the reference Blender addon's 3dsMax->Blender step composed with
 * the standard Blender->three.js Z-up-to-Y-up step), so a quaternion's
 * (x, y, z) part transforms exactly like a vector while w is unchanged.
 */
export function convertVec3(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(-x, z, y);
}

export function convertQuat(x: number, y: number, z: number, w: number, out = new Quaternion()): Quaternion {
  return out.set(-x, z, y, w);
}

/**
 * Scale is stored axis-permuted but not sign-flipped in the source files
 * (matching the reference addon, which reuses Blender's decomposed scale
 * unconverted). Only the axis permutation is applied here.
 */
export function convertScale(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, z, y);
}

const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();

/**
 * Converts a raw 3ds Max-space affine matrix (as read directly from a file)
 * into three.js space, following the same rule the reference addon uses:
 * position and rotation go through the coordinate conversion, scale is
 * reused as decomposed (unconverted).
 */
export function convertMatrix(raw: Matrix4, out = new Matrix4()): Matrix4 {
  raw.decompose(tmpPos, tmpQuat, tmpScale);
  const pos = convertVec3(tmpPos.x, tmpPos.y, tmpPos.z);
  const quat = convertQuat(tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w);
  return out.compose(pos, quat, tmpScale);
}
