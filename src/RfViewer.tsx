import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight,
  Box3,
  CameraHelper,
  DirectionalLight,
  DoubleSide,
  Euler,
  GridHelper,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SkeletonHelper,
  Timer,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AnimationAction, Bone } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ANI_FPS } from './rf/animation';
import { ANIMATION_FILES, loadCharacter } from './rf/character';
import type { RfCharacter } from './rf/character';
import './RfViewer.css';

const CLICK_DRAG_TOLERANCE_PX = 12;
const ARRIVE_FRACTION_OF_RADIUS = 0.04;
const WALK_SPEED_RADIUS_PER_SEC = 0.9;
const TURN_SPEED_RAD_PER_SEC = Math.PI * 2.2;
// The model's authored "forward" faces the opposite way from three.js's
// lookAt convention (-Z), so the computed facing needs a 180 degree
// correction around the character's up axis.
const FACING_CORRECTION = new Quaternion(0, 1, 0, 0);
/** How quickly the orbit target catches up to the character, per second (exponential smoothing rate). */
const FOLLOW_SMOOTHING_RATE = 4;
const STEP_SECONDS = 1 / ANI_FPS;
/** A bone rotating more than this in a single frame is almost certainly a pop, not real motion. */
const SUSPICIOUS_ANGLE_RAD = Math.PI / 2;
const CROSSFADE_SECONDS = 0.25;
const HIPS_BONE_NAME = 'Bip01 Pelvis';
const HEAD_BONE_NAME = 'Bip01 Head';
const LOOK_SENSITIVITY = 0.0035;
const MAX_LOOK_PITCH = Math.PI / 2 - 0.05;
const DEBUG_CAM_DISTANCE_RADIUS_FACTOR = 2.2;
const DEBUG_CAM_HEIGHT_RADIUS_FACTOR = 1.4;
// The head bone's origin sits inside the skull, not out at the eyes - push
// the eye point forward along the view direction so it clears the face mesh.
const EYE_FORWARD_RADIUS_FACTOR = 0.18;
/** How quickly the 3rd-person orbit re-aligns to directly behind the character while it moves. */
const CAMERA_BEHIND_ROTATE_RATE = 4;
const UP_AXIS = new Vector3(0, 1, 0);

type CamMode = 'third' | 'first' | 'debug';

export default function RfViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const characterRef = useRef<RfCharacter | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [clipName, setClipName] = useState<string>('stand');
  // The render loop reads this every frame to decide whether to start a
  // transition - not React state, so there's no gap between "user asked for
  // this clip" and "the mixer actually starts blending toward it" (a
  // useEffect only fires after React commits, which isn't synced to the
  // rAF loop and can lag it by a frame or more).
  const desiredClipRef = useRef('stand');
  const currentClipKeyRef = useRef<string | null>(null);
  const [showBones, setShowBones] = useState(false);
  const skeletonHelperRef = useRef<SkeletonHelper | null>(null);
  const [camMode, setCamMode] = useState<CamMode>('third');
  const camModeRef = useRef<CamMode>('third');
  const camModeChangedRef = useRef(true);
  const followHeightRef = useRef(0);
  const hipsBoneRef = useRef<Bone | null>(null);
  const headBoneRef = useRef<Bone | null>(null);
  const firstPersonYawRef = useRef(0);
  const firstPersonPitchRef = useRef(0);
  /** True while the right mouse button is held - user is manually orbiting, so the auto-behind-follow yields. */
  const rightDraggingRef = useRef(false);
  const sceneCenterRef = useRef(new Vector3());
  const sceneRadiusRef = useRef(1);
  const controlsRef = useRef<OrbitControls | null>(null);

  // Frame-stepping debug tool, for pinning down the exact frame of the reported flicker.
  const [debugPaused, setDebugPaused] = useState(false);
  const debugPausedRef = useRef(false);
  const activeActionRef = useRef<AnimationAction | null>(null);
  const [frameLabel, setFrameLabel] = useState('');

  // Click-to-move state, kept out of React state since it's driven every animation frame.
  const moveTargetRef = useRef<Vector3 | null>(null);
  const walkSpeedRef = useRef(1);
  const arriveThresholdRef = useRef(0.05);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 1000);
    camera.position.set(1.4, 1.6, 2.4);

    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false; // panning would fight the follow-cam target updates
    // Left button is reserved for click-to-move; orbiting is right-drag only.
    // Zoom (scroll wheel) stays on - only the middle-button dolly drag is disabled.
    controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: MOUSE.ROTATE };
    controls.update();
    controlsRef.current = controls;

    // Debug-cam gizmo: a literal camera object placed at the character's
    // head, oriented the same way the first-person view would look. Only
    // visible in debug mode, where the real render camera is locked in
    // place so this can be inspected from an outside vantage.
    const cameraGizmoCam = new PerspectiveCamera(50, 1, 0.05, 2);
    const cameraGizmoHelper = new CameraHelper(cameraGizmoCam);
    cameraGizmoHelper.visible = false;
    scene.add(cameraGizmoCam);
    scene.add(cameraGizmoHelper);

    scene.add(new AmbientLight(0xffffff, 0.6));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 3, 2);
    scene.add(sun);

    const grid = new GridHelper(4, 32, 0x555555, 0x333333);
    scene.add(grid);

    const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
    const raycaster = new Raycaster();
    const pointerNdc = new Vector2();

    const targetMarker = new Mesh(
      new RingGeometry(0.4, 0.55, 32),
      new MeshBasicMaterial({ color: 0x4a7dff, side: DoubleSide, transparent: true, opacity: 0.8 }),
    );
    targetMarker.rotation.x = -Math.PI / 2;
    targetMarker.visible = false;
    scene.add(targetMarker);

    const lookMatrix = new Matrix4();
    const lookTargetQuat = new Quaternion();
    const followPoint = new Vector3();
    const prevOrbitTarget = new Vector3();
    const orbitTargetDelta = new Vector3();
    const lookEuler = new Euler(0, 0, 0, 'YXZ');
    const eyeForward = new Vector3();
    const behindDir = new Vector3();
    const orbitOffset = new Vector3();

    // Runs once whenever camMode changes (detected via camModeChangedRef in
    // the render loop, since this effect has no access to the camera/scene
    // refs a React effect keyed on camMode would need).
    const applyCamMode = (mode: CamMode) => {
      controls.enabled = mode === 'third';
      cameraGizmoHelper.visible = mode === 'debug';

      const character = characterRef.current;
      if (mode === 'first' && character) {
        lookEuler.setFromQuaternion(character.group.quaternion, 'YXZ');
        firstPersonYawRef.current = lookEuler.y;
        firstPersonPitchRef.current = 0;
      }

      if (mode === 'debug') {
        const center = sceneCenterRef.current;
        const radius = sceneRadiusRef.current;
        camera.position.set(
          center.x + radius * DEBUG_CAM_DISTANCE_RADIUS_FACTOR,
          center.y + radius * DEBUG_CAM_HEIGHT_RADIUS_FACTOR,
          center.z + radius * DEBUG_CAM_DISTANCE_RADIUS_FACTOR,
        );
        camera.lookAt(center);
      }

      if (mode === 'third') controls.update();
    };

    // Always-on watchdog: flags a NaN or a suspiciously large single-frame
    // rotation jump the instant it happens, without needing to catch it by
    // eye or manually pause in time.
    const lastQuatByBone = new Map<string, Quaternion>();
    const checkForPoseAnomalies = (character: RfCharacter) => {
      const action = activeActionRef.current;
      const time = action ? action.time : NaN;
      character.group.traverse((obj) => {
        if (!(obj as { isBone?: boolean }).isBone) return;
        const q = obj.quaternion;
        const isNaNQuat = Number.isNaN(q.x) || Number.isNaN(q.y) || Number.isNaN(q.z) || Number.isNaN(q.w);
        if (isNaNQuat) {
          console.warn(`[anim-debug] NaN quaternion on "${obj.name}" at clip time ${time.toFixed(4)}s`);
          return;
        }
        let prev = lastQuatByBone.get(obj.name);
        if (prev) {
          const angle = prev.angleTo(q);
          if (angle > SUSPICIOUS_ANGLE_RAD) {
            console.warn(
              `[anim-debug] "${obj.name}" jumped ${((angle * 180) / Math.PI).toFixed(1)}deg in one frame at clip time ${time.toFixed(4)}s`,
              { prev: prev.toArray(), next: q.toArray() },
            );
          }
        } else {
          prev = new Quaternion();
          lastQuatByBone.set(obj.name, prev);
        }
        prev.copy(q);
      });
    };

    const timer = new Timer();
    let animationFrame: number;

    const render = () => {
      animationFrame = requestAnimationFrame(render);
      timer.update();
      const delta = timer.getDelta();

      const character = characterRef.current;
      const target = moveTargetRef.current;
      if (character && target) {
        const toTarget = new Vector3(target.x - character.group.position.x, 0, target.z - character.group.position.z);
        const distance = toTarget.length();

        if (distance <= arriveThresholdRef.current) {
          moveTargetRef.current = null;
          targetMarker.visible = false;
          console.log('[anim-debug] arrived at click-to-move target, switching to "stand"');
          desiredClipRef.current = 'stand';
          setClipName('stand');
        } else {
          toTarget.normalize();
          const step = Math.min(distance, walkSpeedRef.current * delta);
          character.group.position.addScaledVector(toTarget, step);
          character.group.position.y = target.y;

          const facePoint = character.group.position.clone().add(toTarget);
          lookMatrix.lookAt(facePoint, character.group.position, character.group.up);
          lookTargetQuat.setFromRotationMatrix(lookMatrix).multiply(FACING_CORRECTION);
          character.group.quaternion.rotateTowards(lookTargetQuat, TURN_SPEED_RAD_PER_SEC * delta);
        }
      }

      if (camModeChangedRef.current) {
        camModeChangedRef.current = false;
        applyCamMode(camModeRef.current);
      }

      if (character && camModeRef.current === 'third') {
        const hips = hipsBoneRef.current;
        if (hips) {
          hips.getWorldPosition(followPoint);
        } else {
          followPoint.set(character.group.position.x, 0, character.group.position.z);
        }
        // Walk/run animate the hips bone up and down as part of the gait -
        // real motion for the mesh, but not something the camera should
        // chase. Take X/Z from the hips (so it stays centered as the
        // character sways) but Y from the stable root + a fixed height.
        followPoint.y = character.group.position.y + followHeightRef.current;
        const t = 1 - Math.exp(-FOLLOW_SMOOTHING_RATE * delta);
        // OrbitControls.update() re-derives its orbit offset from
        // (camera.position - target) on every call, then adds that same
        // offset back onto the *new* target - so moving target alone is a
        // no-op for camera.position, it only re-aims via the final lookAt().
        // Carrying the camera by the same delta keeps the orbit offset (and
        // so the zoom distance) fixed while actually translating with the
        // character.
        prevOrbitTarget.copy(controls.target);
        controls.target.lerp(followPoint, t);
        orbitTargetDelta.copy(controls.target).sub(prevOrbitTarget);
        camera.position.add(orbitTargetDelta);

        // While actually walking somewhere, ease the orbit around to
        // directly behind the character's facing - unless the user is
        // right-dragging, which takes full manual control of the angle
        // until released.
        if (moveTargetRef.current && !rightDraggingRef.current) {
          behindDir.set(0, 0, 1).applyQuaternion(character.group.quaternion);
          behindDir.y = 0;
          if (behindDir.lengthSq() > 1e-8) {
            const desiredTheta = Math.atan2(behindDir.x, behindDir.z);
            const currentTheta = controls.getAzimuthalAngle();
            let diff = desiredTheta - currentTheta;
            diff = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
            const rotT = 1 - Math.exp(-CAMERA_BEHIND_ROTATE_RATE * delta);
            orbitOffset.copy(camera.position).sub(controls.target);
            orbitOffset.applyAxisAngle(UP_AXIS, diff * rotT);
            camera.position.copy(controls.target).add(orbitOffset);
          }
        }
      } else if (character && camModeRef.current === 'first') {
        const head = headBoneRef.current;
        lookEuler.set(firstPersonPitchRef.current, firstPersonYawRef.current, 0, 'YXZ');
        camera.quaternion.setFromEuler(lookEuler);
        if (head) {
          head.getWorldPosition(camera.position);
          eyeForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
          camera.position.addScaledVector(eyeForward, sceneRadiusRef.current * EYE_FORWARD_RADIUS_FACTOR);
        }
      }

      if (character && camModeRef.current === 'debug') {
        const head = headBoneRef.current;
        if (head) {
          head.getWorldPosition(cameraGizmoCam.position);
          cameraGizmoCam.quaternion.copy(character.group.quaternion);
        }
        cameraGizmoHelper.update();
      }

      // Driven every frame off a ref, not a useEffect keyed on React state -
      // switching purely through state+effect lags the rAF loop by at least
      // one commit, which (combined with the old hard stopAllAction()/play()
      // cut) was a real source of visible pops between clips.
      if (character && desiredClipRef.current !== currentClipKeyRef.current) {
        const nextName = desiredClipRef.current;
        const nextClip = character.clips[nextName];
        if (nextClip) {
          console.log(`[anim-debug] clip switched to "${nextName}"`);
          const prevAction = activeActionRef.current;
          const nextAction = character.mixer.clipAction(nextClip);

          if (prevAction && prevAction !== nextAction && !debugPausedRef.current) {
            prevAction.fadeOut(CROSSFADE_SECONDS);
            nextAction.reset().fadeIn(CROSSFADE_SECONDS).play();
          } else {
            character.mixer.stopAllAction();
            nextAction.reset().play();
          }
          nextAction.paused = debugPausedRef.current;

          activeActionRef.current = nextAction;
          setFrameLabel(`t=${nextAction.time.toFixed(4)}s / ${nextClip.duration.toFixed(4)}s`);
        }
        currentClipKeyRef.current = nextName;
      }

      character?.mixer.update(delta);
      if (character) checkForPoseAnomalies(character);
      if (camModeRef.current === 'third') controls.update();
      renderer.render(scene, camera);
    };
    render();

    const pointerDownPos = { current: null as { x: number; y: number } | null };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        rightDraggingRef.current = true;
        return;
      }
      if (event.button !== 0) return;
      pointerDownPos.current = { x: event.clientX, y: event.clientY };
    };

    // Tracked on window, not the canvas, so releasing the button after the
    // cursor has dragged off-canvas still clears the flag.
    const handleWindowPointerUp = (event: PointerEvent) => {
      if (event.button === 2) rightDraggingRef.current = false;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (camModeRef.current !== 'first' || !pointerDownPos.current) return;
      firstPersonYawRef.current -= event.movementX * LOOK_SENSITIVITY;
      firstPersonPitchRef.current = MathUtils.clamp(
        firstPersonPitchRef.current - event.movementY * LOOK_SENSITIVITY,
        -MAX_LOOK_PITCH,
        MAX_LOOK_PITCH,
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      const down = pointerDownPos.current;
      pointerDownPos.current = null;
      if (!down) return;
      const movedPx = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (movedPx > CLICK_DRAG_TOLERANCE_PX) return; // was a camera drag, not a click
      if (camModeRef.current !== 'third') return; // click-to-move only makes sense in 3rd person

      const character = characterRef.current;
      if (!character) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointerNdc, camera);
      const hit = new Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, hit)) {
        console.log('[anim-debug] click-to-move triggered', {
          from: character.group.position.toArray().map((n) => +n.toFixed(3)),
          to: hit.toArray().map((n) => +n.toFixed(3)),
          previousClip: desiredClipRef.current,
        });
        moveTargetRef.current = hit;
        targetMarker.position.set(hit.x, hit.y + 0.01, hit.z);
        targetMarker.visible = true;
        desiredClipRef.current = 'walk';
        setClipName('walk');
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);

    loadCharacter()
      .then((character) => {
        if (disposed) return;
        characterRef.current = character;
        scene.add(character.group);

        // The toggle button only renders once status is 'ready' (below), so
        // there's no toggle to race with here - start hidden by default.
        const skeletonHelper = new SkeletonHelper(character.group);
        skeletonHelper.visible = false;
        scene.add(skeletonHelper);
        skeletonHelperRef.current = skeletonHelper;

        const hipsIndex = character.builtSkeleton.nameToIndex.get(HIPS_BONE_NAME);
        hipsBoneRef.current = hipsIndex !== undefined ? character.builtSkeleton.bones[hipsIndex] : null;
        const headIndex = character.builtSkeleton.nameToIndex.get(HEAD_BONE_NAME);
        headBoneRef.current = headIndex !== undefined ? character.builtSkeleton.bones[headIndex] : null;

        // Frame the camera around the loaded model - its actual units/scale
        // aren't known ahead of time, so fit to its real bounding box.
        const box = new Box3().setFromObject(character.group, true);
        const size = box.getSize(new Vector3());
        const center = box.getCenter(new Vector3());
        const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

        grid.position.y = box.min.y;
        grid.scale.setScalar(radius * 5);
        groundPlane.constant = -box.min.y;
        walkSpeedRef.current = radius * WALK_SPEED_RADIUS_PER_SEC;
        arriveThresholdRef.current = radius * ARRIVE_FRACTION_OF_RADIUS;
        targetMarker.scale.setScalar(radius * 0.25);
        followHeightRef.current = center.y - box.min.y; // look roughly at torso height, not the feet
        sceneCenterRef.current.copy(center);
        sceneRadiusRef.current = radius;

        controls.target.copy(center);
        camera.position.set(center.x + radius * 1.4, center.y + radius * 0.6, center.z + radius * 1.4);
        camera.near = radius / 100;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        controls.update();

        cameraGizmoCam.near = radius / 100;
        cameraGizmoCam.far = radius * 2;
        cameraGizmoCam.updateProjectionMatrix();

        setStatus('ready');
      })
      .catch((err: unknown) => {
        console.error('Failed to load character:', err);
        if (disposed) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      cancelAnimationFrame(animationFrame);
      controlsRef.current = null;
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    if (skeletonHelperRef.current) skeletonHelperRef.current.visible = showBones;
  }, [showBones, status]);

  useEffect(() => {
    camModeRef.current = camMode;
    camModeChangedRef.current = true;
  }, [camMode]);

  useEffect(() => {
    debugPausedRef.current = debugPaused;
    const character = characterRef.current;
    const active = activeActionRef.current;
    if (!active) return;

    if (debugPaused && character) {
      // Pausing freezes the mixer's global clock - but that clock is also
      // what drives an in-progress crossfade's blend weight, so pausing
      // mid-fade would otherwise lock in a permanent blend of two different
      // clips instead of one clean pose. Snap straight to the target clip.
      for (const clip of Object.values(character.clips)) {
        const action = character.mixer.existingAction(clip);
        if (action && action !== active) action.stop();
      }
      active.enabled = true;
      active.setEffectiveWeight(1);
    }

    active.paused = debugPaused;
  }, [debugPaused]);

  const logFrameState = (action: AnimationAction) => {
    const character = characterRef.current;
    if (!character) return;
    const rows: Record<string, { x: number; y: number; z: number; w: number; nan: boolean }> = {};
    character.group.traverse((obj) => {
      if (!(obj as { isBone?: boolean }).isBone) return;
      const q = obj.quaternion;
      rows[obj.name] = {
        x: +q.x.toFixed(4),
        y: +q.y.toFixed(4),
        z: +q.z.toFixed(4),
        w: +q.w.toFixed(4),
        nan: Number.isNaN(q.x) || Number.isNaN(q.y) || Number.isNaN(q.z) || Number.isNaN(q.w),
      };
    });
    console.log(`[anim-debug] clip="${clipName}" time=${action.time.toFixed(4)}s / ${action.getClip().duration.toFixed(4)}s`);
    console.table(rows);
  };

  const stepFrame = (deltaFrames: number) => {
    const action = activeActionRef.current;
    if (!action) return;
    const duration = action.getClip().duration;
    action.time = ((action.time + deltaFrames * STEP_SECONDS) % duration + duration) % duration;
    characterRef.current?.mixer.update(0);
    setFrameLabel(`t=${action.time.toFixed(4)}s / ${duration.toFixed(4)}s`);
    logFrameState(action);
  };

  const handleManualClip = (name: string) => {
    moveTargetRef.current = null;
    desiredClipRef.current = name;
    setClipName(name);
  };

  return (
    <div className="rf-viewer">
      <div className="rf-viewer-canvas" ref={containerRef} />
      {status === 'loading' && <div className="rf-viewer-overlay">Loading BelFemale…</div>}
      {status === 'error' && (
        <div className="rf-viewer-overlay rf-viewer-overlay-error">
          Failed to load assets: {errorMessage}
          <br />
          Make sure the files described in public/game-assets/README.md are in place.
        </div>
      )}
      {status === 'ready' && (
        <>
          <div className="rf-viewer-hint">Click the ground to walk there</div>
          <div className="rf-viewer-controls">
            {Object.keys(ANIMATION_FILES).map((name) => (
              <button
                key={name}
                className={name === clipName ? 'active' : ''}
                onClick={() => handleManualClip(name)}
              >
                {name}
              </button>
            ))}
            <button className={showBones ? 'active' : ''} onClick={() => setShowBones((v) => !v)}>
              bones
            </button>
            <select
              className="rf-viewer-cam-select"
              value={camMode}
              onChange={(e) => setCamMode(e.target.value as CamMode)}
            >
              <option value="third">3rd person cam</option>
              <option value="first">1st person cam</option>
              <option value="debug">debug cam</option>
            </select>
          </div>
          <div className="rf-viewer-controls rf-viewer-controls-debug">
            <button className={debugPaused ? 'active' : ''} onClick={() => setDebugPaused((v) => !v)}>
              {debugPaused ? 'resume' : 'pause'}
            </button>
            <button disabled={!debugPaused} onClick={() => stepFrame(-1)}>
              « step
            </button>
            <button disabled={!debugPaused} onClick={() => stepFrame(1)}>
              step »
            </button>
            <button
              onClick={() => {
                const action = activeActionRef.current;
                if (action) logFrameState(action);
              }}
            >
              log now
            </button>
            {frameLabel && <span className="rf-viewer-frame-label">{frameLabel}</span>}
          </div>
        </>
      )}
    </div>
  );
}
