import { useEffect, useState } from 'react';
import type { EffectSocketInspection } from '../../controllers/CharacterController';
import type { NumberOrRange, ParticleTemplate } from '../../rf/particleTemplate';
import type { ParticleEffect, ParticleLiveValues } from '../../rf/particleSystem';
import './DebugPanel.css';

export interface EffectEditPanelProps {
  /** The last-clicked %efedit socket marker's resolved info, or null before anything's been clicked yet - see ViewerScene.onEffectSocketInfo. */
  inspection: EffectSocketInspection | null;
  onClose: () => void;
  /** Fires on every keystroke in a live-tune input below, for whichever particle effect owns that row (the same reference from EffectSocketInspection.liveEffects, passed straight through - not a lookup key of any kind) - see CharacterController.setParticleLiveValues. */
  onLiveChange: (effect: ParticleEffect, patch: Partial<ParticleLiveValues>) => void;
}

/** null/undefined -> "-", everything else -> String(v) - same convention WeaponEditPanel's own fmt uses. */
function fmt(v: unknown): string {
  return v === null || v === undefined ? '-' : String(v);
}

/** Collapses a NumberOrRange down to one representative number for display/editing - the low end of the range for a real rand(), or the plain value for a fixed one. Editing the resulting input always writes back a fixed value (see ParticleEffect.setLiveValues) - this is a "pick a starting point to tune from," not a lossless round-trip. */
function collapseRange(range: NumberOrRange): number {
  return range.min;
}

function templateToLiveValues(template: ParticleTemplate): ParticleLiveValues {
  return {
    num: template.num,
    posBox: template.posBox,
    gravity: template.gravity,
    startPower: [collapseRange(template.startPower[0]), collapseRange(template.startPower[1]), collapseRange(template.startPower[2])],
    startScale: collapseRange(template.startScale),
    startAlpha: collapseRange(template.startAlpha),
    startZRot: collapseRange(template.startZRot),
    liveTime: template.liveTime,
    timeSpeed: template.timeSpeed,
  };
}

/** A labeled number input - shared by every live-tune row below, same shape as WeaponEditPanel's own GradeNumberField. */
function ParticleNumberField({
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
    <label className="debug-panel-effect-edit-field">
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

function buildCopyText(inspection: EffectSocketInspection, liveByPath: Map<string, ParticleLiveValues>): string {
  const { info } = inspection;
  const lines = [`Socket "${info.socketName}" - .eff: ${info.effPath ?? '(none registered)'}`];

  info.sections.forEach((section, i) => {
    lines.push(
      `Section ${i + 1}: surfaceTexture=${fmt(section.surfaceTexture)} glowTexture=${fmt(section.glowTexture)} movementMode=${section.movementMode} speedByte=0x${section.speedByte.toString(16)} particleIds=[${section.particleIds.join(', ') || '-'}]`,
    );
  });

  for (const { sptPath, entity } of info.particles) {
    const material =
      entity?.material?.kind === 'mst'
        ? `.mst=${entity.material.mstName} texture=${fmt(entity.material.textureName)}`
        : entity?.material?.kind === 'r3m'
          ? `.r3m=${entity.material.r3mName} texture(embedded in .r3t)=${fmt(entity.material.textureName)}`
          : 'no material data';
    lines.push(`\n.spt: ${sptPath}`);
    lines.push(`  entity: ${fmt(entity?.entityFile)} -> ${material}`);
    const live = liveByPath.get(sptPath);
    if (live) {
      lines.push(
        `  live: num=${live.num} posBox=[${live.posBox.join(', ')}] gravity=[${live.gravity.join(', ')}] startPower=[${live.startPower.join(', ')}] startScale=${live.startScale} startAlpha=${live.startAlpha} startZRot=${live.startZRot} liveTime=${live.liveTime} timeSpeed=${live.timeSpeed}`,
      );
    } else {
      lines.push('  (not currently spawned - no live values to show)');
    }
  }

  return lines.join('\n');
}

/**
 * `%efedit`'s per-socket inspector: shows exactly what's clicked (a real
 * `.eff` section, its resolved `.spt` particle(s), and each one's real
 * material - `.mst` or `.r3m`/`.r3t`, see CharacterController.
 * getSocketDebugInfo), plus live-editable number inputs for every
 * currently-running particle's own tunable `.spt` values (see
 * ParticleEffect.setLiveValues) - for empirically dialing in "the exact
 * formula" against the real game's own look, the same live-tune-and-
 * observe workflow WeaponEditPanel's grade values already offer.
 * Editing a field rebuilds that one particle effect's instances
 * immediately (see setLiveValues's own doc comment on why a full
 * rebuild, not a partial patch) - a brief visible reset of its loop, not
 * a bug.
 */
export default function EffectEditPanel({ inspection, onClose, onLiveChange }: EffectEditPanelProps) {
  const [liveByPath, setLiveByPath] = useState<Map<string, ParticleLiveValues>>(new Map());
  const [effectByPath, setEffectByPath] = useState<Map<string, ParticleEffect>>(new Map());
  const [copied, setCopied] = useState(false);

  // Re-seeds from whatever's actually running the moment a *different*
  // socket (or the same socket's freshly re-resolved data) comes in -
  // not on every render, or a live-tune keystroke would get its own
  // input stomped back to the effect's last-rebuilt values.
  useEffect(() => {
    setCopied(false);
    if (!inspection) {
      setLiveByPath(new Map());
      setEffectByPath(new Map());
      return;
    }
    const nextLive = new Map<string, ParticleLiveValues>();
    const nextEffects = new Map<string, ParticleEffect>();
    for (const { sptPath, effect } of inspection.liveEffects) {
      nextEffects.set(sptPath, effect);
      const template = effect.getLiveTemplate();
      if (template) nextLive.set(sptPath, templateToLiveValues(template));
    }
    setEffectByPath(nextEffects);
    setLiveByPath(nextLive);
  }, [inspection?.info.socketName, inspection?.info.effPath]);

  if (!inspection) return null;
  const { info } = inspection;

  const updateLive = (sptPath: string, patch: Partial<ParticleLiveValues>) => {
    const effect = effectByPath.get(sptPath);
    if (!effect) return;
    setLiveByPath((prev) => {
      const next = new Map(prev);
      const current = next.get(sptPath);
      if (current) next.set(sptPath, { ...current, ...patch });
      return next;
    });
    onLiveChange(effect, patch);
  };

  const handleCopy = () => {
    void navigator.clipboard.writeText(buildCopyText(inspection, liveByPath)).then(() => setCopied(true));
  };

  return (
    <div className="debug-panel-effect-edit">
      <div className="debug-panel-panel-header">
        <span>Effect Inspector - {info.socketName}</span>
        <button type="button" className="debug-panel-panel-close" onClick={onClose} aria-label="Close effect inspector">
          ×
        </button>
      </div>

      <div className="debug-panel-effect-edit-eff">.eff: {info.effPath ?? '(this weapon has no registered .eff at all)'}</div>

      {info.sections.length === 0 ? (
        <div className="debug-panel-effect-edit-empty">
          No .eff section is explicitly labeled for this socket (it may still get an effect via array-order fallback).
        </div>
      ) : (
        info.sections.map((section, i) => (
          <div key={i} className="debug-panel-effect-edit-section">
            surfaceTexture={fmt(section.surfaceTexture)} glowTexture={fmt(section.glowTexture)} movementMode={section.movementMode} speedByte=0x
            {section.speedByte.toString(16)} particleIds=[{section.particleIds.join(', ') || '-'}]
          </div>
        ))
      )}

      {info.particles.length === 0 ? (
        <div className="debug-panel-effect-edit-empty">No real particle (.spt) resolves for this socket.</div>
      ) : (
        info.particles.map(({ sptPath, entity }) => {
          const effect = effectByPath.get(sptPath);
          const seeded = liveByPath.get(sptPath);
          return (
            <div key={sptPath} className="debug-panel-effect-edit-particle">
              <div className="debug-panel-effect-edit-label">{sptPath}</div>
              <div className="debug-panel-effect-edit-entity">
                entity: {fmt(entity?.entityFile)} -&gt;{' '}
                {entity?.material?.kind === 'mst'
                  ? `.mst=${entity.material.mstName} texture=${fmt(entity.material.textureName)}`
                  : entity?.material?.kind === 'r3m'
                    ? `.r3m=${entity.material.r3mName} texture(embedded in .r3t)=${fmt(entity.material.textureName)}`
                    : 'no material data'}
              </div>

              {!effect ? (
                <div className="debug-panel-effect-edit-empty">Not currently spawned (particle test off, or still loading) - nothing to live-tune yet.</div>
              ) : !seeded ? (
                <div className="debug-panel-effect-edit-empty">Loading live values…</div>
              ) : (
                <>
                  <div className="debug-panel-effect-edit-row">
                    <ParticleNumberField label="Num" value={seeded.num} step={1} onChange={(v) => updateLive(sptPath, { num: v })} />
                    <ParticleNumberField label="Live Time" value={seeded.liveTime} step={0.1} onChange={(v) => updateLive(sptPath, { liveTime: v })} />
                    <ParticleNumberField label="Time Speed" value={seeded.timeSpeed} step={0.1} onChange={(v) => updateLive(sptPath, { timeSpeed: v })} />
                  </div>
                  <div className="debug-panel-effect-edit-row">
                    <ParticleNumberField label="Pos X" value={seeded.posBox[0]} step={0.1} onChange={(v) => updateLive(sptPath, { posBox: [v, seeded.posBox[1], seeded.posBox[2]] })} />
                    <ParticleNumberField label="Pos Y" value={seeded.posBox[1]} step={0.1} onChange={(v) => updateLive(sptPath, { posBox: [seeded.posBox[0], v, seeded.posBox[2]] })} />
                    <ParticleNumberField label="Pos Z" value={seeded.posBox[2]} step={0.1} onChange={(v) => updateLive(sptPath, { posBox: [seeded.posBox[0], seeded.posBox[1], v] })} />
                  </div>
                  <div className="debug-panel-effect-edit-row">
                    <ParticleNumberField label="Gravity X" value={seeded.gravity[0]} step={0.1} onChange={(v) => updateLive(sptPath, { gravity: [v, seeded.gravity[1], seeded.gravity[2]] })} />
                    <ParticleNumberField label="Gravity Y" value={seeded.gravity[1]} step={0.1} onChange={(v) => updateLive(sptPath, { gravity: [seeded.gravity[0], v, seeded.gravity[2]] })} />
                    <ParticleNumberField label="Gravity Z" value={seeded.gravity[2]} step={0.1} onChange={(v) => updateLive(sptPath, { gravity: [seeded.gravity[0], seeded.gravity[1], v] })} />
                  </div>
                  <div className="debug-panel-effect-edit-row">
                    <ParticleNumberField label="Power X" value={seeded.startPower[0]} step={0.1} onChange={(v) => updateLive(sptPath, { startPower: [v, seeded.startPower[1], seeded.startPower[2]] })} />
                    <ParticleNumberField label="Power Y" value={seeded.startPower[1]} step={0.1} onChange={(v) => updateLive(sptPath, { startPower: [seeded.startPower[0], v, seeded.startPower[2]] })} />
                    <ParticleNumberField label="Power Z" value={seeded.startPower[2]} step={0.1} onChange={(v) => updateLive(sptPath, { startPower: [seeded.startPower[0], seeded.startPower[1], v] })} />
                  </div>
                  <div className="debug-panel-effect-edit-row">
                    <ParticleNumberField label="Start Scale" value={seeded.startScale} step={0.1} onChange={(v) => updateLive(sptPath, { startScale: v })} />
                    <ParticleNumberField label="Start Alpha" value={seeded.startAlpha} step={1} onChange={(v) => updateLive(sptPath, { startAlpha: v })} />
                    <ParticleNumberField label="Start ZRot" value={seeded.startZRot} step={1} onChange={(v) => updateLive(sptPath, { startZRot: v })} />
                  </div>
                </>
              )}
            </div>
          );
        })
      )}

      <button type="button" className="debug-panel-effect-edit-copy" onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy for chat'}
      </button>
    </div>
  );
}
