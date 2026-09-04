import { useCallback, useEffect, useRef, useState } from 'react';
import CommandConsole from '../debug/CommandConsole';
import DebugPanel from '../debug/DebugPanel';
import EquipPanel from '../debug/EquipPanel';
import MobileControls from '../hud/MobileControls';
import StatsPanel from '../debug/StatsPanel';
import type { CamMode } from '../../controllers/CameraController';
import type { BattleMode, MoveMode } from '../../controllers/CharacterController';
import { RaceGender } from '../../rf/character';
import { ALL_EQUIP_SLOTS, SLOT_LABELS, loadUsableSlotItems } from '../../rf/items';
import type { ModelType, ItemDefinition } from '../../rf/items';
import type { SceneManager } from '../../scenes/SceneManager';
import type { ViewerDebugStats } from '../../scenes/ViewerScene';
import { ViewerScene } from '../../scenes/ViewerScene';
import './RfViewer.css';

export interface RfViewerProps {
  sceneManager: SceneManager;
  initialRaceGender: RaceGender;
  /** Optional "back to character select" action, shown as a button when provided. */
  onExit?: () => void;
}

export default function RfViewer({ sceneManager, initialRaceGender, onExit }: RfViewerProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [clipName, setClipName] = useState<string>('stand');
  const [showBones, setShowBones] = useState(false);
  const [camMode, setCamMode] = useState<CamMode>('third');
  const [debugPaused, setDebugPaused] = useState(false);
  const [frameLabel, setFrameLabel] = useState('');
  const [debugStats, setDebugStats] = useState<ViewerDebugStats>({ fps: 0, heapMB: null, geometries: 0, textures: 0 });

  // The original client's Peace/War battle toggle - War shows the wielded
  // weapon and switches walk/run to their combat variant, Peace hides it
  // and always plays the unarmed clips. See CharacterController.setBattleMode.
  const [battleMode, setBattleMode] = useState<BattleMode>('peace');

  // Walk/run toggle for click-to-move - independent of battleMode, which
  // only decides whether the combat variant of whichever clip this picks
  // plays. See CharacterController.setMoveMode.
  const [moveMode, setMoveMode] = useState<MoveMode>('walk');

  // The debug/dev-tooling panel (race switcher, clip buttons, camera-mode
  // select, frame-stepping) - hidden by default and revealed only via the
  // GM console's "%debug 1"/"%debug 0" (see handleCommandSubmit below), not
  // a UI button, so it stays out of the way until someone actually wants it.
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  // StatsPanel/EquipPanel spawn independently of showDebugPanel (and of each
  // other) via the GM console's "%stats 1"/"%eq 1" (see handleCommandSubmit)
  // - same "hidden until summoned" pattern as showDebugPanel. The "Debug UI"
  // button is a shortcut that flips both together.
  const [showStats, setShowStats] = useState(false);
  const [showEquip, setShowEquip] = useState(false);

  const [raceGender, setRaceGender] = useState<RaceGender>(initialRaceGender);
  const raceGenderRef = useRef<RaceGender>(initialRaceGender);
  const isFirstRaceEffectRef = useRef(true);

  // Equip-slot selection: which item id (if any) is picked per ModelType
  // slot, and the race-filtered item list each slot's dropdown offers.
  // Selecting an item here does not yet change the rendered mesh - see the
  // note in the equip panel below.
  const [equippedItemId, setEquippedItemId] = useState<Partial<Record<ModelType, string>>>({});
  const [slotItems, setSlotItems] = useState<Partial<Record<ModelType, ItemDefinition[]>>>({});

  // GM command console (e.g. "%addbot 5").
  const [commandInput, setCommandInput] = useState('');
  const [commandFeedback, setCommandFeedback] = useState('');

  // Assigned by the mount effect below, so the smaller effects further down
  // (keyed on showBones/camMode/debugPaused/raceGender) and the JSX
  // handlers can reach the scene without needing it in their own dependency
  // arrays.
  const viewerSceneRef = useRef<ViewerScene | null>(null);

  useEffect(() => {
    let disposed = false;

    const viewerScene = new ViewerScene(sceneManager.renderer, raceGenderRef.current, {
      onClipChange: (name) => {
        if (!disposed) setClipName(name);
      },
      onFrameLabelChange: (label) => {
        if (!disposed) setFrameLabel(label);
      },
      onStatusChange: (nextStatus, message) => {
        if (disposed) return;
        setStatus(nextStatus);
        setErrorMessage(message ?? '');
      },
      onStatsUpdate: (stats) => {
        if (!disposed) setDebugStats(stats);
      },
    });
    viewerSceneRef.current = viewerScene;
    // Resource disposal is SceneManager's job once this scene is superseded
    // (or on full app unmount) - not this cleanup's, since the replacement
    // screen's own mount effect is what calls setScene() next, and until
    // that happens this scene should keep rendering/updating undisturbed.
    void sceneManager.setScene(viewerScene);

    return () => {
      disposed = true;
      viewerSceneRef.current = null;
    };
  }, [sceneManager]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setShowBones(showBones);
  }, [showBones]);

  useEffect(() => {
    viewerSceneRef.current?.cameraController.setMode(camMode);
  }, [camMode]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setDebugPaused(debugPaused);
  }, [debugPaused]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setBattleMode(battleMode);
  }, [battleMode]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setMoveMode(moveMode);
  }, [moveMode]);

  useEffect(() => {
    raceGenderRef.current = raceGender;
    // The initial load is already kicked off by the mount effect above -
    // this effect only needs to react to actual switches after that.
    if (isFirstRaceEffectRef.current) {
      isFirstRaceEffectRef.current = false;
      return;
    }
    viewerSceneRef.current?.loadRace(raceGender);
  }, [raceGender]);

  // An item valid for one race's body may not be for another's, so previous
  // selections are cleared on a race switch - and CharacterController.mount()
  // resets battleMode back to 'peace' internally for the same "fresh
  // character" reason, so the toggle button needs to follow suit. Done
  // during render by comparing against a state-held "previous value" -
  // React's documented pattern for resetting state when a value changes (a
  // ref can't be used here: reading/writing ref.current during render
  // isn't allowed).
  const [prevRaceGenderForEquip, setPrevRaceGenderForEquip] = useState(raceGender);
  if (prevRaceGenderForEquip !== raceGender) {
    setPrevRaceGenderForEquip(raceGender);
    setEquippedItemId({});
    setBattleMode('peace');
    setMoveMode('walk');
  }

  // Loads each slot's race-eligible item list whenever the character is
  // ready or the race changes. Item JSON files are cached per slot in
  // rf/items.ts, so a race switch only re-filters already-fetched data
  // rather than re-downloading it.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    for (const modelType of ALL_EQUIP_SLOTS) {
      loadUsableSlotItems(modelType, raceGender)
        .then((items) => {
          if (cancelled) return;
          setSlotItems((prev) => ({ ...prev, [modelType]: items }));
        })
        .catch((err: unknown) => {
          console.warn(`Failed to load items for slot ${SLOT_LABELS[modelType]}:`, err);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [status, raceGender]);

  const logFrameState = () => {
    const result = viewerSceneRef.current?.characterController.getFrameStateRows();
    if (!result) return;
    const { rows, action } = result;
    console.log(`[anim-debug] clip="${clipName}" time=${action.time.toFixed(4)}s / ${action.getClip().duration.toFixed(4)}s`);
    console.table(rows);
  };

  const stepFrame = (deltaFrames: number) => {
    viewerSceneRef.current?.characterController.stepFrame(deltaFrames);
    logFrameState();
  };

  const handleManualClip = (name: string) => {
    viewerSceneRef.current?.characterController.setClip(name);
  };

  // Memoized (stable identity) - MobileControls' unmount-cleanup effect used
  // to depend on this prop, so a fresh function reference on every RfViewer
  // re-render (which happens constantly while walking - see onStatsUpdate/
  // onClipChange above) fired that cleanup spuriously, repeatedly zeroing
  // the joystick input mid-hold. Fixed on both ends (see MobileControls'
  // onMoveRef), but keeping this stable is still the right call regardless.
  const handleJoystickMove = useCallback((input: { x: number; y: number } | null) => {
    viewerSceneRef.current?.setJoystickInput(input);
  }, []);

  const handleEquipClose = useCallback(() => setShowEquip(false), []);

  // Depends only on slotItems (needed to resolve the picked id back to an
  // ItemDefinition) - that only changes on an actual item-load/race-switch
  // event, not on every render, so this still doesn't defeat EquipPanel's memo().
  const handleEquipChange = useCallback(
    (modelType: ModelType, itemId: string) => {
      const item = itemId === '' ? null : (slotItems[modelType]?.find((i) => i.id === itemId) ?? null);

      setEquippedItemId((prev) => {
        if (itemId === '') {
          const next = { ...prev };
          delete next[modelType];
          return next;
        }
        return { ...prev, [modelType]: itemId };
      });

      // equipItem() resolves the item's mesh via playerResource.json - most
      // real (non-"Default ...") items aren't in that table yet, so
      // 'unavailable' is common; the selection is kept either way, it just
      // won't visually change the model until resource data covers it.
      viewerSceneRef.current?.characterController
        .equipItem(modelType, item)
        .then((result) => {
          if (result === 'unavailable') {
            console.warn(
              `No mesh data available for "${item?.name ?? 'this item'}" yet - selection kept, but the model won't change.`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error(`Failed to equip item for slot ${SLOT_LABELS[modelType]}:`, err);
        });
    },
    [slotItems],
  );

  const handleCommandSubmit = () => {
    const trimmed = commandInput.trim();
    if (!trimmed) return;
    setCommandInput('');

    // Debug-panel/stats/equip visibility is pure UI state, not scene state -
    // handled here rather than round-tripping through ViewerScene.runCommand.
    const debugMatch = /^%debug\s+([01])$/.exec(trimmed);
    if (debugMatch) {
      const show = debugMatch[1] === '1';
      setShowDebugPanel(show);
      setCommandFeedback(`Debug panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const statsMatch = /^%stats\s+([01])$/.exec(trimmed);
    if (statsMatch) {
      const show = statsMatch[1] === '1';
      setShowStats(show);
      setCommandFeedback(`Stats panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const equipMatch = /^%eq\s+([01])$/.exec(trimmed);
    if (equipMatch) {
      const show = equipMatch[1] === '1';
      setShowEquip(show);
      setCommandFeedback(`Equip panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    viewerSceneRef.current
      ?.runCommand(trimmed)
      .then((result) => setCommandFeedback(result))
      .catch((err: unknown) => setCommandFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`));
  };

  return (
    <div className="rf-viewer">
      {status === 'loading' && <div className="rf-viewer-overlay">Loading character…</div>}
      {status === 'error' && (
        <div className="rf-viewer-overlay rf-viewer-overlay-error">
          Failed to load assets: {errorMessage}
          <br />
          Make sure the files described in public/game-assets/README.md are in place.
        </div>
      )}

      <div className="rf-viewer-toggle-bar">
        {status === 'ready' && (
          <button
            className={`rf-viewer-debug-toggle${moveMode === 'run' ? ' active' : ''}`}
            onClick={() => setMoveMode((v) => (v === 'walk' ? 'run' : 'walk'))}
          >
            {moveMode === 'run' ? 'Run' : 'Walk'}
          </button>
        )}
        {status === 'ready' && (
          <button
            className={`rf-viewer-debug-toggle${battleMode === 'war' ? ' active' : ''}`}
            onClick={() => setBattleMode((v) => (v === 'peace' ? 'war' : 'peace'))}
          >
            {battleMode === 'war' ? 'War' : 'Peace'}
          </button>
        )}
        <button
          className={`rf-viewer-debug-toggle${showStats || showEquip ? ' active' : ''}`}
          onClick={() => {
            setShowStats((v) => !v);
            setShowEquip((v) => !v);
          }}
        >
          Debug UI
        </button>
      </div>

      {status === 'ready' && <MobileControls onMove={handleJoystickMove} />}

      {/* Always rendered (not gated by showDebugPanel) - it's the only way to send "%debug 1" and bring the panel back once hidden. */}
      {status === 'ready' && (
        <CommandConsole
          commandInput={commandInput}
          onCommandInputChange={setCommandInput}
          onCommandSubmit={handleCommandSubmit}
          commandFeedback={commandFeedback}
        />
      )}

      {status === 'ready' && showStats && <StatsPanel stats={debugStats} />}

      {status === 'ready' && showEquip && (
        <EquipPanel
          equippedItemId={equippedItemId}
          slotItems={slotItems}
          onEquipChange={handleEquipChange}
          onClose={handleEquipClose}
        />
      )}

      {showDebugPanel && (
        <DebugPanel
          ready={status === 'ready'}
          raceGender={raceGender}
          onRaceGenderChange={setRaceGender}
          clipName={clipName}
          onManualClip={handleManualClip}
          showBones={showBones}
          onToggleBones={() => setShowBones((v) => !v)}
          camMode={camMode}
          onCamModeChange={setCamMode}
          debugPaused={debugPaused}
          onToggleDebugPaused={() => setDebugPaused((v) => !v)}
          onStepFrame={stepFrame}
          onLogFrameState={logFrameState}
          frameLabel={frameLabel}
          onExit={onExit}
        />
      )}
    </div>
  );
}
