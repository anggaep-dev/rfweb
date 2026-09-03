import { useEffect, useRef, useState } from 'react';
import { Raycaster, Timer, Vector2, Vector3 } from 'three';
import { AssetController } from './controllers/AssetController';
import { CameraController } from './controllers/CameraController';
import type { CamMode } from './controllers/CameraController';
import { CharacterController } from './controllers/CharacterController';
import { SceneController } from './controllers/SceneController';
import { CLIP_NAMES, RaceGender } from './rf/character';
import './RfViewer.css';

const RACE_OPTIONS: { value: RaceGender; label: string }[] = [
  { value: RaceGender.Bell_Male, label: 'Bell Male' },
  { value: RaceGender.Bell_Female, label: 'Bell Female' },
  { value: RaceGender.Cora_Male, label: 'Cora Male' },
  { value: RaceGender.Cora_Female, label: 'Cora Female' },
  { value: RaceGender.Accretia, label: 'Accretia' },
];

const CLICK_DRAG_TOLERANCE_PX = 12;
/** How often the FPS/memory readout refreshes - every frame would be unreadable and wasteful to re-render for. */
const STATS_UPDATE_INTERVAL_SEC = 0.5;
const BYTES_PER_MB = 1024 * 1024;

/** Chrome-only, non-standard - not in the DOM lib types. Absent on other engines. */
interface PerformanceMemoryInfo {
  usedJSHeapSize: number;
}

export default function RfViewer() {
  const containerRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<'preloading' | 'loading' | 'ready' | 'error'>('preloading');
  const [errorMessage, setErrorMessage] = useState('');
  const [preloadProgress, setPreloadProgress] = useState({ loaded: 0, total: 1 });
  const [clipName, setClipName] = useState<string>('stand');
  const [showBones, setShowBones] = useState(false);
  const [camMode, setCamMode] = useState<CamMode>('third');
  const [debugPaused, setDebugPaused] = useState(false);
  const [frameLabel, setFrameLabel] = useState('');
  const [debugStats, setDebugStats] = useState({ fps: 0, heapMB: null as number | null, geometries: 0, textures: 0 });

  const [raceGender, setRaceGender] = useState<RaceGender>(RaceGender.Bell_Female);
  const raceGenderRef = useRef<RaceGender>(RaceGender.Bell_Female);
  const isFirstRaceEffectRef = useRef(true);

  // Assigned by the mount effect below, so the smaller effects further down
  // (keyed on showBones/camMode/debugPaused/raceGender) can reach the
  // controllers without needing them in their own dependency arrays.
  const cameraControllerRef = useRef<CameraController | null>(null);
  const characterControllerRef = useRef<CharacterController | null>(null);
  const loadRaceRef = useRef<((race: RaceGender) => void) | null>(null);

  const statsFrameCountRef = useRef(0);
  const statsElapsedRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    const sceneController = new SceneController(container);
    const cameraController = new CameraController(
      sceneController.renderer.domElement,
      container.clientWidth / container.clientHeight,
      sceneController.scene,
    );
    const characterController = new CharacterController(sceneController.scene, {
      onClipChange: (name) => {
        if (!disposed) setClipName(name);
      },
      onFrameLabelChange: (label) => {
        if (!disposed) setFrameLabel(label);
      },
    });
    const assetController = new AssetController();

    cameraControllerRef.current = cameraController;
    characterControllerRef.current = characterController;

    const loadRace = (race: RaceGender) => {
      setStatus('loading');
      setErrorMessage('');
      assetController
        .loadRace(race)
        .then((character) => {
          if (disposed || !character) return; // null means a newer loadRace() superseded this one

          const bounds = characterController.mount(character);
          sceneController.frameGround(bounds.box, bounds.radius);
          cameraController.frameOnCharacter(bounds);
          setStatus('ready');
        })
        .catch((err: unknown) => {
          if (disposed) return;
          console.error('Failed to load character:', err);
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus('error');
        });
    };
    loadRaceRef.current = loadRace;

    const timer = new Timer();
    let animationFrame: number;

    const render = () => {
      animationFrame = requestAnimationFrame(render);
      timer.update();
      const delta = timer.getDelta();

      const { arrived } = characterController.update(delta);
      if (arrived) sceneController.hideTargetMarker();

      const character = characterController.getCharacter();
      cameraController.update(delta, {
        hipsBone: characterController.getHipsBone(),
        headBone: characterController.getHeadBone(),
        characterGroupQuaternion: character ? character.group.quaternion : null,
        characterPosition: character ? character.group.position : null,
        isMoving: characterController.isMoving(),
      });

      sceneController.render(cameraController.camera);

      statsFrameCountRef.current += 1;
      statsElapsedRef.current += delta;
      if (statsElapsedRef.current >= STATS_UPDATE_INTERVAL_SEC) {
        const perfMemory = (performance as Performance & { memory?: PerformanceMemoryInfo }).memory;
        setDebugStats({
          fps: Math.round(statsFrameCountRef.current / statsElapsedRef.current),
          heapMB: perfMemory ? Math.round(perfMemory.usedJSHeapSize / BYTES_PER_MB) : null,
          geometries: sceneController.renderer.info.memory.geometries,
          textures: sceneController.renderer.info.memory.textures,
        });
        statsFrameCountRef.current = 0;
        statsElapsedRef.current = 0;
      }
    };
    render();

    // Click-to-move: left-button only (right button is camera orbit, owned
    // by CameraController). Kept here rather than in either controller since
    // it inherently needs camera (for the raycast) + scene (the ground
    // plane + marker) + character (the move command) together.
    const raycaster = new Raycaster();
    const pointerNdc = new Vector2();
    const pointerDownPos = { current: null as { x: number; y: number } | null };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerDownPos.current = { x: event.clientX, y: event.clientY };
    };

    const handlePointerUp = (event: PointerEvent) => {
      const down = pointerDownPos.current;
      pointerDownPos.current = null;
      if (!down) return;
      const movedPx = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (movedPx > CLICK_DRAG_TOLERANCE_PX) return; // was a camera drag, not a click
      if (cameraController.getMode() !== 'third') return; // click-to-move only makes sense in 3rd person
      if (!characterController.getCharacter()) return;

      const rect = sceneController.renderer.domElement.getBoundingClientRect();
      pointerNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointerNdc, cameraController.camera);
      const hit = new Vector3();
      if (raycaster.ray.intersectPlane(sceneController.groundPlane, hit)) {
        characterController.moveTo(hit);
        sceneController.showTargetMarker(hit);
      }
    };

    sceneController.renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    sceneController.renderer.domElement.addEventListener('pointerup', handlePointerUp);

    // Blocks the character load screen until every race's assets are cached,
    // so switching races afterward is instant rather than hitting the network.
    assetController
      .preload((loaded, total) => {
        if (disposed) return;
        setPreloadProgress({ loaded, total });
      })
      .then(() => {
        if (disposed) return;
        loadRace(raceGenderRef.current);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        console.error('Failed to preload race assets:', err);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });

    const handleResize = () => {
      if (!container) return;
      cameraController.setAspect(container.clientWidth / container.clientHeight);
      sceneController.resize();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      sceneController.renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      sceneController.renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      cancelAnimationFrame(animationFrame);
      cameraControllerRef.current = null;
      characterControllerRef.current = null;
      loadRaceRef.current = null;
      assetController.cancelPending();
      cameraController.dispose();
      characterController.dispose();
      sceneController.dispose();
    };
  }, []);

  useEffect(() => {
    characterControllerRef.current?.setShowBones(showBones);
  }, [showBones]);

  useEffect(() => {
    cameraControllerRef.current?.setMode(camMode);
  }, [camMode]);

  useEffect(() => {
    characterControllerRef.current?.setDebugPaused(debugPaused);
  }, [debugPaused]);

  useEffect(() => {
    raceGenderRef.current = raceGender;
    // The initial load is already kicked off by the mount effect above -
    // this effect only needs to react to actual switches after that.
    if (isFirstRaceEffectRef.current) {
      isFirstRaceEffectRef.current = false;
      return;
    }
    loadRaceRef.current?.(raceGender);
  }, [raceGender]);

  const logFrameState = () => {
    const result = characterControllerRef.current?.getFrameStateRows();
    if (!result) return;
    const { rows, action } = result;
    console.log(`[anim-debug] clip="${clipName}" time=${action.time.toFixed(4)}s / ${action.getClip().duration.toFixed(4)}s`);
    console.table(rows);
  };

  const stepFrame = (deltaFrames: number) => {
    characterControllerRef.current?.stepFrame(deltaFrames);
    logFrameState();
  };

  const handleManualClip = (name: string) => {
    characterControllerRef.current?.setClip(name);
  };

  return (
    <div className="rf-viewer">
      <div className="rf-viewer-canvas" ref={containerRef} />
      <div className="rf-viewer-race-select">
        <select
          value={raceGender}
          disabled={status === 'preloading'}
          onChange={(e) => setRaceGender(Number(e.target.value) as RaceGender)}
        >
          {RACE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {status === 'ready' && (
        <div className="rf-viewer-stats">
          {debugStats.fps} FPS
          {debugStats.heapMB !== null && <> · {debugStats.heapMB} MB</>}
          {' · '}
          {debugStats.geometries} geo · {debugStats.textures} tex
        </div>
      )}
      {status === 'preloading' && (
        <div className="rf-viewer-overlay">
          Preloading all races… {preloadProgress.loaded}/{preloadProgress.total}
        </div>
      )}
      {status === 'loading' && <div className="rf-viewer-overlay">Loading character…</div>}
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
            {CLIP_NAMES.map((name) => (
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
            <button onClick={() => logFrameState()}>log now</button>
            {frameLabel && <span className="rf-viewer-frame-label">{frameLabel}</span>}
          </div>
        </>
      )}
    </div>
  );
}
