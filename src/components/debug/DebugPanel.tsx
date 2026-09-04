import type { CamMode } from '../../controllers/CameraController';
import { CLIP_NAMES, RaceGender } from '../../rf/character';
import './DebugPanel.css';

const RACE_OPTIONS: { value: RaceGender; label: string }[] = [
  { value: RaceGender.Bell_Male, label: 'Bell Male' },
  { value: RaceGender.Bell_Female, label: 'Bell Female' },
  { value: RaceGender.Cora_Male, label: 'Cora Male' },
  { value: RaceGender.Cora_Female, label: 'Cora Female' },
  { value: RaceGender.Accretia, label: 'Accretia' },
];

export interface DebugPanelProps {
  /** Whether a character is currently mounted and ready - gates everything except the race switcher, which should stay usable while loading. */
  ready: boolean;

  raceGender: RaceGender;
  onRaceGenderChange: (race: RaceGender) => void;

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

  /** Optional "back to character select" action, shown as a button when provided. */
  onExit?: () => void;
}

/**
 * The asset-viewer/dev tooling that used to be RfViewer's entire UI: race
 * switcher, animation clip buttons, camera-mode select, and frame-stepping
 * tools. Hidden by default - RfViewer only mounts this once the GM console
 * gets a "%debug 1" (see its showDebugPanel state). The equip-slot dropdowns
 * and FPS/memory readout used to live here too, but now spawn independently
 * (RfViewer's StatsPanel/EquipPanel, via "%stats 1"/"%eq 1") so they stay
 * reachable even while this panel - and the console itself - are hidden.
 */
export default function DebugPanel({
  ready,
  raceGender,
  onRaceGenderChange,
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
        </>
      )}
    </div>
  );
}
