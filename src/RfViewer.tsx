import { useCallback, useEffect, useRef, useState } from 'react';
import DebugPanel from './DebugPanel';
import type { CamMode } from './controllers/CameraController';
import type { BattleMode, MoveMode } from './controllers/CharacterController';
import { RaceGender } from './rf/character';
import { ALL_EQUIP_SLOTS, SLOT_LABELS, loadUsableSlotItems } from './rf/items';
import type { ModelType, ItemDefinition } from './rf/items';
import type { SceneManager } from './scenes/SceneManager';
import type { ViewerDebugStats } from './scenes/ViewerScene';
import { ViewerScene } from './scenes/ViewerScene';
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

  // The debug/dev-tooling UI (race switcher, equip panel, clip buttons,
  // camera-mode select, frame-stepping, GM console) - everything RfViewer
  // currently renders, until real gameplay UI is built on top of the scene.
  // Kept togglable rather than always-on so that future UI has a clean
  // scene to work with by default.
  const [showDebugUI, setShowDebugUI] = useState(true);

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
          className={`rf-viewer-debug-toggle${showDebugUI ? ' active' : ''}`}
          onClick={() => setShowDebugUI((v) => !v)}
        >
          Debug UI
        </button>
      </div>

      {showDebugUI && (
        <DebugPanel
          ready={status === 'ready'}
          raceGender={raceGender}
          onRaceGenderChange={setRaceGender}
          debugStats={debugStats}
          equippedItemId={equippedItemId}
          slotItems={slotItems}
          onEquipChange={handleEquipChange}
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
          commandInput={commandInput}
          onCommandInputChange={setCommandInput}
          onCommandSubmit={handleCommandSubmit}
          commandFeedback={commandFeedback}
          onExit={onExit}
        />
      )}
    </div>
  );
}
