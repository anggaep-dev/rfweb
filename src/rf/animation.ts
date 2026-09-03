import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import { BinaryReader } from './BinaryReader';
import { convertScale } from './coords';

const FRAME_SCALE = 160;
/** No fps is encoded in the file; this is the assumed source playback rate. */
export const ANI_FPS = 30;

interface RfAnimatedObject {
  name: string;
  rotationFrames: { time: number; quat: Quaternion }[];
  positionFrames: { time: number; pos: Vector3 }[];
  scaleFrames: { time: number; scale: Vector3 }[];
}

export interface RfAnimation {
  objects: RfAnimatedObject[];
  durationSeconds: number;
}

/** Parses a .ani animation file into per-bone/object keyframe channels. */
export function parseAnimation(buffer: ArrayBuffer): RfAnimation {
  const r = new BinaryReader(buffer);
  const animatedObjectCount = r.u16();
  const objects: RfAnimatedObject[] = [];
  let maxFrame = 0;

  for (let i = 0; i < animatedObjectCount; i++) {
    const name = r.fixedString(100, 'euc-kr');
    // The declared frame amount can exceed the last real keyframe (a hold
    // before the clip loops); when it does, it - not the keyframe data -
    // defines where the loop point actually is.
    const declaredFrameAmount = r.u16();
    maxFrame = Math.max(maxFrame, declaredFrameAmount / FRAME_SCALE / ANI_FPS);
    r.u16(); // frame count - unused
    r.seek(36);

    const rotationFrames: RfAnimatedObject['rotationFrames'] = [];
    const rotationKeyframeCount = r.u16();
    for (let k = 0; k < rotationKeyframeCount; k++) {
      const q = r.quat();
      q.conjugate(); // file stores the inverse of the true local rotation
      const scaledFrame = r.u32();
      const time = scaledFrame / FRAME_SCALE / ANI_FPS;
      maxFrame = Math.max(maxFrame, time);
      rotationFrames.push({ time, quat: q });
    }

    const positionFrames: RfAnimatedObject['positionFrames'] = [];
    const positionKeyframeCount = r.u16();
    for (let k = 0; k < positionKeyframeCount; k++) {
      const pos = r.vec3();
      const scaledFrame = r.u32();
      const time = scaledFrame / FRAME_SCALE / ANI_FPS;
      maxFrame = Math.max(maxFrame, time);
      positionFrames.push({ time, pos });
    }

    const scaleFrames: RfAnimatedObject['scaleFrames'] = [];
    const scaleKeyframeCount = r.u16();
    for (let k = 0; k < scaleKeyframeCount; k++) {
      const raw = r.vec3Raw();
      const scale = convertScale(raw.x, raw.y, raw.z);
      const scaledFrame = r.u32();
      const time = scaledFrame / FRAME_SCALE / ANI_FPS;
      maxFrame = Math.max(maxFrame, time);
      scaleFrames.push({ time, scale });
    }

    const unknownKeyframeCount = r.u16();
    r.seek(unknownKeyframeCount * 8); // float + u32, unused channel

    objects.push({ name, rotationFrames, positionFrames, scaleFrames });
  }

  return { objects, durationSeconds: maxFrame };
}

export interface BindPose {
  position: Vector3;
  rotation: Quaternion;
  scale: Vector3;
}

const DUPLICATE_TIME_EPSILON = 1e-6;

/**
 * Drops keyframes whose time is a (near-)duplicate of the previous one.
 *
 * The source files end each channel with a keyframe pinned to the exact
 * loop-back time, duplicating the real last keyframe's timestamp (values
 * match to within float noise - it's an explicit loop anchor, not new
 * data). Left in, two keyframes at the same time give three.js's linear
 * interpolant a zero-length interval: alpha = (t - t0) / (t1 - t0) is 0/0,
 * so at that exact instant every track evaluates to NaN and the whole pose
 * corrupts for a frame - which read as a "flicker back to T-pose" right at
 * the loop point.
 */
function dedupeFrames<T extends { time: number }>(frames: T[]): T[] {
  if (frames.length < 2) return frames;
  const result: T[] = [frames[0]];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].time - result[result.length - 1].time > DUPLICATE_TIME_EPSILON) {
      result.push(frames[i]);
    }
  }
  return result;
}

/**
 * Drops the file's frame-0 "anchor" keyframe, when there's real data after it.
 *
 * Every channel's first recorded keyframe is always time=0, and its value
 * is a fixed reference pose, not real per-clip animation: for a given bone
 * that value is byte-identical across every different clip file (e.g.
 * "Bip01 Neck"'s frame 0 is the exact same quaternion in stand/walk/run/sit
 * alike, and for most bones it's also exactly that bone's bind rotation).
 * Left in, playback - and every loop restart - interpolates from this
 * static anchor toward the real first frame, which is what was showing up
 * as a brief "flicker to T-pose" at the start of every clip and every loop.
 */
function dropAnchorFrame<T>(frames: T[]): T[] {
  return frames.length > 1 ? frames.slice(1) : frames;
}

/**
 * Builds a THREE.AnimationClip driving bones by name.
 *
 * A clip only lists channels for bones whose pose it actually changes - a
 * bone missing from a clip (or present with 0 keyframes on some channel) is
 * meant to stay at its bind pose while that clip plays. AnimationMixer
 * doesn't know that: it only writes what a track tells it to, so any bone a
 * clip doesn't cover keeps whatever value a *previously played* clip left it
 * at. Switching from a dramatically different clip could then leave a limb
 * frozen mid-pose - which is what was showing up as a "reset to T-pose".
 * To fix that at the mixer level, every clip is made self-contained here:
 * every skeleton bone gets an explicit track, falling back to a single
 * held keyframe at that bone's bind pose when the source data doesn't
 * animate it.
 */
export function buildAnimationClip(
  name: string,
  animation: RfAnimation,
  bindPoseByBone: Map<string, BindPose>,
): AnimationClip {
  const tracks = [];
  const objectsByName = new Map(animation.objects.map((obj) => [obj.name, obj]));

  for (const [boneName, bind] of bindPoseByBone) {
    const obj = objectsByName.get(boneName);

    if (obj && obj.rotationFrames.length > 0) {
      const frames = dedupeFrames(dropAnchorFrame(obj.rotationFrames));
      const times = frames.map((f) => f.time);
      const values: number[] = [];
      for (const f of frames) values.push(f.quat.x, f.quat.y, f.quat.z, f.quat.w);
      tracks.push(new QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
    } else {
      const q = bind.rotation;
      tracks.push(new QuaternionKeyframeTrack(`${boneName}.quaternion`, [0], [q.x, q.y, q.z, q.w]));
    }

    if (obj && obj.positionFrames.length > 0) {
      const frames = dedupeFrames(dropAnchorFrame(obj.positionFrames));
      const times = frames.map((f) => f.time);
      const values: number[] = [];
      for (const f of frames) values.push(f.pos.x, f.pos.y, f.pos.z);
      tracks.push(new VectorKeyframeTrack(`${boneName}.position`, times, values));
    } else {
      const p = bind.position;
      tracks.push(new VectorKeyframeTrack(`${boneName}.position`, [0], [p.x, p.y, p.z]));
    }

    if (obj && obj.scaleFrames.length > 0) {
      const frames = dedupeFrames(dropAnchorFrame(obj.scaleFrames));
      const times = frames.map((f) => f.time);
      const values: number[] = [];
      for (const f of frames) values.push(f.scale.x, f.scale.y, f.scale.z);
      tracks.push(new VectorKeyframeTrack(`${boneName}.scale`, times, values));
    } else {
      const s = bind.scale;
      tracks.push(new VectorKeyframeTrack(`${boneName}.scale`, [0], [s.x, s.y, s.z]));
    }
  }

  return new AnimationClip(name, animation.durationSeconds, tracks);
}
