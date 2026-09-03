import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CamMode } from './controllers/CameraController';
import { CLIP_NAMES, RaceGender } from './rf/character';
import { ALL_MODEL_TYPES, ModelType, loadUsableSlotItems } from './rf/items';
import type { ItemDefinition } from './rf/items';
import type { SceneManager } from './scenes/SceneManager';
import type { ViewerDebugStats } from './scenes/ViewerScene';
import { ViewerScene } from './scenes/ViewerScene';
import './RfViewer.css';

const RACE_OPTIONS: { value: RaceGender; label: string }[] = [
  { value: RaceGender.Bell_Male, label: 'Bell Male' },
  { value: RaceGender.Bell_Female, label: 'Bell Female' },
  { value: RaceGender.Cora_Male, label: 'Cora Male' },
  { value: RaceGender.Cora_Female, label: 'Cora Female' },
  { value: RaceGender.Accretia, label: 'Accretia' },
];

const SLOT_LABELS: Record<ModelType, string> = {
  [ModelType.Helmet]: 'Helmet',
  [ModelType.Face]: 'Face',
  [ModelType.Upper]: 'Upper',
  [ModelType.Lower]: 'Lower',
  [ModelType.Gauntlet]: 'Gauntlet',
  [ModelType.Shoes]: 'Shoes',
};

interface EquipPanelProps {
  equippedItemId: Partial<Record<ModelType, string>>;
  slotItems: Partial<Record<ModelType, ItemDefinition[]>>;
  onEquipChange: (modelType: ModelType, itemId: string) => void;
}

// Some slots carry thousands of items (gauntlet alone has ~2,500 eligible
// per race), so this renders thousands of <option> elements. memo() keeps
// that expensive tree from being torn down and rebuilt on every unrelated
// re-render of RfViewer (e.g. the FPS/memory readout updating twice a
// second) - only an actual change to this panel's own props should redo it.
const EquipPanel = memo(function EquipPanel({ equippedItemId, slotItems, onEquipChange }: EquipPanelProps) {
  return (
    <div className="rf-viewer-equip-panel">
      {ALL_MODEL_TYPES.map((modelType) => {
        const items = slotItems[modelType];
        return (
          <label key={modelType} className="rf-viewer-equip-row">
            <span>{SLOT_LABELS[modelType]}</span>
            <select
              value={equippedItemId[modelType] ?? ''}
              disabled={!items}
              onChange={(e) => onEquipChange(modelType, e.target.value)}
            >
              <option value="">{items ? 'None' : 'Loading…'}</option>
              {items?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
});

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
  // selections are cleared on a race switch. Done during render by
  // comparing against a state-held "previous value" - React's documented
  // pattern for resetting state when a value changes (a ref can't be used
  // here: reading/writing ref.current during render isn't allowed).
  const [prevRaceGenderForEquip, setPrevRaceGenderForEquip] = useState(raceGender);
  if (prevRaceGenderForEquip !== raceGender) {
    setPrevRaceGenderForEquip(raceGender);
    setEquippedItemId({});
  }

  // Loads each slot's race-eligible item list whenever the character is
  // ready or the race changes. Item JSON files are cached per slot in
  // rf/items.ts, so a race switch only re-filters already-fetched data
  // rather than re-downloading it.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    for (const modelType of ALL_MODEL_TYPES) {
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
      <div className="rf-viewer-race-select">
        <select value={raceGender} onChange={(e) => setRaceGender(Number(e.target.value) as RaceGender)}>
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
      {status === 'ready' && (
        <EquipPanel equippedItemId={equippedItemId} slotItems={slotItems} onEquipChange={handleEquipChange} />
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
            {onExit && <button onClick={onExit}>« character select</button>}
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
          <div className="rf-viewer-command-bar">
            <input
              type="text"
              className="rf-viewer-command-input"
              placeholder="GM command, e.g. %addbot 5"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCommandSubmit();
              }}
            />
            {commandFeedback && <span className="rf-viewer-command-feedback">{commandFeedback}</span>}
          </div>
        </>
      )}
    </div>
  );
}
