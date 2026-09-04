import { useEffect, useState } from 'react';
import type { WeaponEditState, WeaponEditTransform } from '../../scenes/ViewerScene';
import './DebugPanel.css';

export interface WeaponEditPanelProps {
  state: WeaponEditState | null;
  onModeChange: (mode: 'translate' | 'rotate') => void;
  onReset: () => void;
  onClose: () => void;
}

function formatVec3(v: readonly [number, number, number], fractionDigits: number): string {
  return `[${v.map((n) => n.toFixed(fractionDigits)).join(', ')}]`;
}

function delta(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

function formatBlock(label: string, t: WeaponEditTransform, fractionDigits: number): string {
  return `${label}: pos=${formatVec3(t.position, fractionDigits)} rotDeg=${formatVec3(t.eulerDeg, 1)}`;
}

function buildCopyText(state: WeaponEditState): string {
  const posDelta = delta(state.original.position, state.current.position);
  const rotDelta = delta(state.original.eulerDeg, state.current.eulerDeg);
  return [
    `Weapon: ${state.weaponLabel}`,
    formatBlock('Original (computed)', state.original, 4),
    formatBlock('Edited (gizmo)', state.current, 4),
    `Delta: pos=${formatVec3(posDelta, 4)} rotDeg=${formatVec3(rotDelta, 1)}`,
  ].join('\n');
}

/**
 * Live readout + controls for the %wpedit gizmo (see ViewerScene.
 * setWeaponEditEnabled) - a Blender-style move/rotate handle attached to the
 * currently-equipped weapon, for hand-tuning its placement and comparing the
 * result against what CharacterController actually computed. G/R switch
 * mode (same letters Blender uses for grab/rotate) whenever this panel has
 * focus-independent global listeners active; the buttons do the same thing
 * for anyone not used to the shortcuts.
 */
export default function WeaponEditPanel({ state, onModeChange, onReset, onClose }: WeaponEditPanelProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [state?.current.position[0], state?.current.position[1], state?.current.position[2], state?.current.eulerDeg[0], state?.current.eulerDeg[1], state?.current.eulerDeg[2]]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'g' || event.key === 'G') onModeChange('translate');
      else if (event.key === 'r' || event.key === 'R') onModeChange('rotate');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onModeChange]);

  const handleCopy = () => {
    if (!state) return;
    void navigator.clipboard.writeText(buildCopyText(state)).then(() => setCopied(true));
  };

  return (
    <div className="debug-panel-weapon-edit">
      <div className="debug-panel-panel-header">
        <span>Weapon Edit</span>
        <button type="button" className="debug-panel-panel-close" onClick={onClose} aria-label="Close weapon edit">
          ×
        </button>
      </div>

      {!state ? (
        <div className="debug-panel-weapon-edit-empty">No weapon equipped.</div>
      ) : (
        <>
          <div className="debug-panel-weapon-edit-label">{state.weaponLabel}</div>

          <div className="debug-panel-controls debug-panel-weapon-edit-mode">
            <button type="button" className={state.mode === 'translate' ? 'active' : ''} onClick={() => onModeChange('translate')}>
              Move (G)
            </button>
            <button type="button" className={state.mode === 'rotate' ? 'active' : ''} onClick={() => onModeChange('rotate')}>
              Rotate (R)
            </button>
            <button type="button" onClick={onReset}>
              Reset
            </button>
          </div>

          <pre className="debug-panel-weapon-edit-readout">{buildCopyText(state)}</pre>

          <button type="button" className="debug-panel-weapon-edit-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy for chat'}
          </button>
        </>
      )}
    </div>
  );
}
