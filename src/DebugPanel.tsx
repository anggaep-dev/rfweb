import { memo } from 'react';
import type { CamMode } from './controllers/CameraController';
import { CLIP_NAMES, RaceGender } from './rf/character';
import { ALL_EQUIP_SLOTS, SLOT_LABELS } from './rf/items';
import type { ItemDefinition, ModelType } from './rf/items';
import type { ViewerDebugStats } from './scenes/ViewerScene';
import './DebugPanel.css';

const RACE_OPTIONS: { value: RaceGender; label: string }[] = [
  { value: RaceGender.Bell_Male, label: 'Bell Male' },
  { value: RaceGender.Bell_Female, label: 'Bell Female' },
  { value: RaceGender.Cora_Male, label: 'Cora Male' },
  { value: RaceGender.Cora_Female, label: 'Cora Female' },
  { value: RaceGender.Accretia, label: 'Accretia' },
];

interface EquipPanelProps {
  equippedItemId: Partial<Record<ModelType, string>>;
  slotItems: Partial<Record<ModelType, ItemDefinition[]>>;
  onEquipChange: (modelType: ModelType, itemId: string) => void;
}

// Some slots carry thousands of items (gauntlet alone has ~2,500 eligible
// per race), so this renders thousands of <option> elements. memo() keeps
// that expensive tree from being torn down and rebuilt on every unrelated
// re-render of DebugPanel (e.g. the FPS/memory readout updating twice a
// second) - only an actual change to this panel's own props should redo it.
const EquipPanel = memo(function EquipPanel({ equippedItemId, slotItems, onEquipChange }: EquipPanelProps) {
  return (
    <div className="debug-panel-equip-panel">
      {ALL_EQUIP_SLOTS.map((modelType) => {
        const items = slotItems[modelType];
        return (
          <label key={modelType} className="debug-panel-equip-row">
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

export interface DebugPanelProps {
  /** Whether a character is currently mounted and ready - gates everything except the race switcher, which should stay usable while loading. */
  ready: boolean;

  raceGender: RaceGender;
  onRaceGenderChange: (race: RaceGender) => void;

  debugStats: ViewerDebugStats;

  equippedItemId: Partial<Record<ModelType, string>>;
  slotItems: Partial<Record<ModelType, ItemDefinition[]>>;
  onEquipChange: (modelType: ModelType, itemId: string) => void;

  clipName: string;
  onManualClip: (name: string) => void;
  showBones: boolean;
  onToggleBones: () => void;
  camMode: CamMode;
  onCamModeChange: (mode: CamMode) => void;

  debugPaused: boolean;
  onToggleDebugPaused: () => void;
  onStepFrame: (deltaFrames: number) => void;
  onLogFrameState: () => void;
  frameLabel: string;

  commandInput: string;
  onCommandInputChange: (value: string) => void;
  onCommandSubmit: () => void;
  commandFeedback: string;

  /** Optional "back to character select" action, shown as a button when provided. */
  onExit?: () => void;
}

/**
 * All the asset-viewer/dev tooling that used to be RfViewer's entire UI:
 * race switcher, FPS/memory readout, equip-slot dropdowns, animation clip
 * buttons, camera-mode select, frame-stepping tools, and the GM command
 * console. Kept as one togglable layer (see RfViewer's showDebugUI) so real
 * gameplay UI can be built on the scene without this cluttering it up.
 */
export default function DebugPanel({
  ready,
  raceGender,
  onRaceGenderChange,
  debugStats,
  equippedItemId,
  slotItems,
  onEquipChange,
  clipName,
  onManualClip,
  showBones,
  onToggleBones,
  camMode,
  onCamModeChange,
  debugPaused,
  onToggleDebugPaused,
  onStepFrame,
  onLogFrameState,
  frameLabel,
  commandInput,
  onCommandInputChange,
  onCommandSubmit,
  commandFeedback,
  onExit,
}: DebugPanelProps) {
  return (
    <div className="debug-panel">
      <div className="debug-panel-race-select">
        <select value={raceGender} onChange={(e) => onRaceGenderChange(Number(e.target.value) as RaceGender)}>
          {RACE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {ready && (
        <>
          <div className="debug-panel-stats">
            {debugStats.fps} FPS
            {debugStats.heapMB !== null && <> · {debugStats.heapMB} MB</>}
            {' · '}
            {debugStats.geometries} geo · {debugStats.textures} tex
          </div>

          <EquipPanel equippedItemId={equippedItemId} slotItems={slotItems} onEquipChange={onEquipChange} />

          <div className="debug-panel-hint">Click the ground to walk there</div>

          <div className="debug-panel-controls">
            {onExit && <button onClick={onExit}>« character select</button>}
            {CLIP_NAMES.map((name) => (
              <button key={name} className={name === clipName ? 'active' : ''} onClick={() => onManualClip(name)}>
                {name}
              </button>
            ))}
            <button className={showBones ? 'active' : ''} onClick={onToggleBones}>
              bones
            </button>
            <select
              className="debug-panel-cam-select"
              value={camMode}
              onChange={(e) => onCamModeChange(e.target.value as CamMode)}
            >
              <option value="third">3rd person cam</option>
              <option value="first">1st person cam</option>
              <option value="debug">debug cam</option>
            </select>
          </div>

          <div className="debug-panel-controls debug-panel-controls-debug">
            <button className={debugPaused ? 'active' : ''} onClick={onToggleDebugPaused}>
              {debugPaused ? 'resume' : 'pause'}
            </button>
            <button disabled={!debugPaused} onClick={() => onStepFrame(-1)}>
              « step
            </button>
            <button disabled={!debugPaused} onClick={() => onStepFrame(1)}>
              step »
            </button>
            <button onClick={onLogFrameState}>log now</button>
            {frameLabel && <span className="debug-panel-frame-label">{frameLabel}</span>}
          </div>

          <div className="debug-panel-command-bar">
            <input
              type="text"
              className="debug-panel-command-input"
              placeholder="GM command, e.g. %addbot 5"
              value={commandInput}
              onChange={(e) => onCommandInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommandSubmit();
              }}
            />
            {commandFeedback && <span className="debug-panel-command-feedback">{commandFeedback}</span>}
          </div>
        </>
      )}
    </div>
  );
}
