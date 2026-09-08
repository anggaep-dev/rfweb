import { useEffect, useState } from 'react';
import type { WeaponDebugInfo } from '../../controllers/CharacterController';
import type { GradeLiveValues } from '../../rf/gradeEffect';
import type { WeaponEditState, WeaponEditTransform } from '../../scenes/ViewerScene';
import './DebugPanel.css';

export interface WeaponEditPanelProps {
  state: WeaponEditState | null;
  onModeChange: (mode: 'translate' | 'rotate') => void;
  onReset: () => void;
  onClose: () => void;
  /** Fires on every keystroke in a grade-overlay input below - see CharacterController.setWeaponGradeLiveValues. No-op (never called) while the current weapon has no grade overlay, since the inputs aren't rendered at all in that case. */
  onGradeLiveChange: (patch: Partial<GradeLiveValues>) => void;
  /** Simulated +N upgrade level (see CharacterController.setDebugWeaponUpgradeLevel) - weaponItem.json's real per-item upgrade level isn't tracked anywhere else in this project, so this dropdown is the only way to see how a weapon's Chef/ effect (glow/socket-glow/surface-shine) changes across PatternList.txt's upgrade-level columns. */
  upgradeLevel: number;
  onUpgradeLevelChange: (level: number) => void;
}

/** PatternList.txt only distinguishes +0 / +1-3 / +4 / +5-7 (see glowEffect.ts's patternColumnForUpgradeLevel) - every level in the dropdown, not just those 4, since a real item's own upgrade level can still be any of +0..+7 even though several map to the same resolved column. */
const UPGRADE_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7];

function formatVec3(v: readonly [number, number, number], fractionDigits: number): string {
  return `[${v.map((n) => n.toFixed(fractionDigits)).join(', ')}]`;
}

function delta(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

function formatBlock(label: string, t: WeaponEditTransform, fractionDigits: number): string {
  return `${label}: pos=${formatVec3(t.position, fractionDigits)} rotDeg=${formatVec3(t.eulerDeg, 1)}`;
}

/** null/undefined -> "-", everything else -> String(v) - shared formatting for every WeaponDebugInfo field below, so a not-yet-resolved or not-applicable value reads clearly instead of as a blank or literal "null"/"undefined". */
function fmt(v: unknown): string {
  return v === null || v === undefined ? '-' : String(v);
}

/**
 * `gradeLiveOverride` is this panel's own locally-edited copy (see
 * WeaponEditPanel's gradeLive state) rather than `debug.grade.live` - so
 * "Copy for chat" always reflects whatever's currently in the input boxes,
 * not just the value from whenever the weapon was last (re-)equipped.
 */
function buildDebugText(debug: WeaponDebugInfo | null, gradeLiveOverride: GradeLiveValues | null, upgradeLevel: number): string {
  if (!debug) return 'Item: (unarmed - no catalog entry)';

  const { item, token, stem, glow, grade, effectSockets, particleSocketCount, particlesSpawned } = debug;
  const lines = [
    `Item: ${item.name} (${item.id}) model=${item.model} grade=${fmt(item.grade)} civil=${item.civil} levelLim=${item.levelLim}`,
    `Token: ${fmt(token)}  Stem: ${fmt(stem)}`,
    `Simulated upgrade level: +${upgradeLevel} (see CharacterController.setDebugWeaponUpgradeLevel - not this item's real data, weaponItem.json doesn't carry an upgrade level field anywhere else in this project)`,
    `Effect sockets: ${effectSockets.socketCount} found, ${effectSockets.socketsWithGlow} carrying a glow billboard`,
    `Particle sockets ("P0N"): ${particleSocketCount} found - a separate, coexisting attachment convention from Effect sockets above, not every weapon has these`,
    `Particles spawned: ${particlesSpawned} (real .eff ParticleID -> Chef/Particle.ini -> .spt resolution - see glowEffect.ts's resolveWeaponParticles; 0 just means this item registers no particle data, the common case)`,
  ];

  lines.push(
    glow
      ? `Glow (.eff, whole-mesh): effPath=${glow.effPath} surfaceTexture=${fmt(glow.surfaceTexture)} glowTexture=${fmt(glow.glowTexture)} movementMode=${glow.movementMode} speedByte=${glow.speedByte} (0x${glow.speedByte.toString(16)})`
      : effectSockets.socketsWithGlow > 0
        ? 'Glow (.eff, whole-mesh): none - handled per-socket instead (see Effect sockets above)'
        : 'Glow (.eff): none registered',
  );

  if (grade) {
    const live = gradeLiveOverride ?? grade.live;
    const ro = grade.readOnly;
    lines.push(
      `Grade (.mst ${grade.letter}grade) - live/editable: alpha=${live.alpha} color=[${live.color.join(', ')}] uvScrollU=${live.uvScrollU} uvScrollV=${live.uvScrollV} aniAlphaFlicker=${live.aniAlphaFlicker} aniAlphaFlickerStart=${live.aniAlphaFlickerStart} aniAlphaFlickerEnd=${live.aniAlphaFlickerEnd}`,
      `Grade (.mst ${grade.letter}grade) - parsed, not yet applied to rendering: type=${ro.type} mapName=${fmt(ro.mapName)} uvEnv=${ro.uvEnv} uvScale=${fmt(ro.uvScale)} uvScaleEnd=${fmt(ro.uvScaleEnd)} uvScaleSpeed=${fmt(ro.uvScaleSpeed)} uvRotate=${fmt(ro.uvRotate)} aniTexFrame=${fmt(ro.aniTexFrame)} aniTexSpeed=${fmt(ro.aniTexSpeed)}`,
    );
  } else {
    lines.push('Grade (.mst): none registered');
  }

  return lines.join('\n');
}

function buildCopyText(state: WeaponEditState, gradeLiveOverride: GradeLiveValues | null, upgradeLevel: number): string {
  const posDelta = delta(state.original.position, state.current.position);
  const rotDelta = delta(state.original.eulerDeg, state.current.eulerDeg);
  return [
    `Weapon: ${state.weaponLabel}`,
    formatBlock('Original (computed)', state.original, 4),
    formatBlock('Edited (gizmo)', state.current, 4),
    `Delta: pos=${formatVec3(posDelta, 4)} rotDeg=${formatVec3(rotDelta, 1)}`,
    '',
    buildDebugText(state.debug, gradeLiveOverride, upgradeLevel),
  ].join('\n');
}

/** A labeled number input for one GradeLiveValues field - shared by every row in the "Grade (.mst) - live" section below. */
function GradeNumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="debug-panel-weapon-edit-grade-field">
      {label}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const next = Number.parseFloat(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

/**
 * Live readout + controls for the %wpedit gizmo (see ViewerScene.
 * setWeaponEditEnabled) - a Blender-style move/rotate handle attached to the
 * currently-equipped weapon, for hand-tuning its placement and comparing the
 * result against what CharacterController actually computed. G/R switch
 * mode (same letters Blender uses for grab/rotate) whenever this panel has
 * focus-independent global listeners active; the buttons do the same thing
 * for anyone not used to the shortcuts.
 *
 * Also doubles as the live-tuning tool for the currently-equipped weapon's
 * grade overlay (see gradeEffect.ts/CharacterController.setWeaponGradeLiveValues)
 * - a real .mst file's alpha/color/uv-scroll/alpha-flicker values are
 * educated-guess approximations (see GradeLiveValues' own doc comment), so
 * editing them here and watching the weapon live lets the right numbers be
 * found by eye instead of guessed at from the source file alone; "Copy for
 * chat" carries whatever's currently in these inputs.
 */
export default function WeaponEditPanel({
  state,
  onModeChange,
  onReset,
  onClose,
  onGradeLiveChange,
  upgradeLevel,
  onUpgradeLevelChange,
}: WeaponEditPanelProps) {
  const [copied, setCopied] = useState(false);
  const [gradeLive, setGradeLive] = useState<GradeLiveValues | null>(null);

  useEffect(() => {
    setCopied(false);
  }, [state?.current.position[0], state?.current.position[1], state?.current.position[2], state?.current.eulerDeg[0], state?.current.eulerDeg[1], state?.current.eulerDeg[2]]);

  // Re-seeds from the freshly-equipped weapon's own starting values whenever
  // the weapon (or which grade it carries) actually changes - not on every
  // render, or a drag-triggered emitWeaponEditState() would stomp whatever's
  // mid-edit in the inputs below back to the original file's numbers.
  useEffect(() => {
    setGradeLive(state?.debug?.grade?.live ?? null);
  }, [state?.weaponLabel, state?.debug?.grade?.letter]);

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
    void navigator.clipboard.writeText(buildCopyText(state, gradeLive, upgradeLevel)).then(() => setCopied(true));
  };

  const updateGradeLive = (patch: Partial<GradeLiveValues>) => {
    setGradeLive((prev) => (prev ? { ...prev, ...patch } : prev));
    onGradeLiveChange(patch);
  };

  const grade = state?.debug?.grade ?? null;

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

          <label className="debug-panel-weapon-edit-upgrade">
            Simulated upgrade level
            <select value={upgradeLevel} onChange={(e) => onUpgradeLevelChange(Number(e.target.value))}>
              {UPGRADE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  +{level}
                </option>
              ))}
            </select>
          </label>

          {grade && gradeLive && (
            <div className="debug-panel-weapon-edit-grade">
              <div className="debug-panel-weapon-edit-label">Grade overlay ({grade.letter}grade.mst) - live</div>
              <div className="debug-panel-weapon-edit-grade-row">
                <GradeNumberField label="Alpha" value={gradeLive.alpha} step={1} onChange={(v) => updateGradeLive({ alpha: v })} />
                <GradeNumberField
                  label="Color R"
                  value={gradeLive.color[0]}
                  step={1}
                  onChange={(v) => updateGradeLive({ color: [v, gradeLive.color[1], gradeLive.color[2]] })}
                />
                <GradeNumberField
                  label="Color G"
                  value={gradeLive.color[1]}
                  step={1}
                  onChange={(v) => updateGradeLive({ color: [gradeLive.color[0], v, gradeLive.color[2]] })}
                />
                <GradeNumberField
                  label="Color B"
                  value={gradeLive.color[2]}
                  step={1}
                  onChange={(v) => updateGradeLive({ color: [gradeLive.color[0], gradeLive.color[1], v] })}
                />
              </div>
              <div className="debug-panel-weapon-edit-grade-row">
                <GradeNumberField label="UV Scroll U" value={gradeLive.uvScrollU} step={0.1} onChange={(v) => updateGradeLive({ uvScrollU: v })} />
                <GradeNumberField label="UV Scroll V" value={gradeLive.uvScrollV} step={0.1} onChange={(v) => updateGradeLive({ uvScrollV: v })} />
              </div>
              <div className="debug-panel-weapon-edit-grade-row">
                <GradeNumberField
                  label="Flicker Speed"
                  value={gradeLive.aniAlphaFlicker}
                  step={0.1}
                  onChange={(v) => updateGradeLive({ aniAlphaFlicker: v })}
                />
                <GradeNumberField
                  label="Flicker Start ×"
                  value={gradeLive.aniAlphaFlickerStart}
                  step={0.1}
                  onChange={(v) => updateGradeLive({ aniAlphaFlickerStart: v })}
                />
                <GradeNumberField
                  label="Flicker End ×"
                  value={gradeLive.aniAlphaFlickerEnd}
                  step={0.1}
                  onChange={(v) => updateGradeLive({ aniAlphaFlickerEnd: v })}
                />
              </div>
              <div className="debug-panel-weapon-edit-grade-readonly">
                Parsed, not yet applied to rendering: type={fmt(grade.readOnly.type)} mapName={fmt(grade.readOnly.mapName)} uvEnv=
                {fmt(grade.readOnly.uvEnv)} uvScale={fmt(grade.readOnly.uvScale)} uvScaleEnd={fmt(grade.readOnly.uvScaleEnd)} uvScaleSpeed=
                {fmt(grade.readOnly.uvScaleSpeed)} uvRotate={fmt(grade.readOnly.uvRotate)} aniTexFrame={fmt(grade.readOnly.aniTexFrame)} aniTexSpeed=
                {fmt(grade.readOnly.aniTexSpeed)}
              </div>
            </div>
          )}

          <pre className="debug-panel-weapon-edit-readout">{buildCopyText(state, gradeLive, upgradeLevel)}</pre>

          <button type="button" className="debug-panel-weapon-edit-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy for chat'}
          </button>
        </>
      )}
    </div>
  );
}
