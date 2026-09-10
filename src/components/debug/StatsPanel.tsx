import { useEffect, useState } from 'react';
import { useOrientation } from '../../hooks/useOrientation';
import type { ViewerDebugStats } from '../../scenes/ViewerScene';
import './DebugPanel.css';

export interface StatsPanelProps {
  stats: ViewerDebugStats;
}

/** Plain-text mirror of the panel's own rows, for pasting a snapshot into a bug report/chat without retyping every number by hand - see handleCopy. */
function buildStatsCopyText(stats: ViewerDebugStats, orientation: string): string {
  const weapon = stats.weapon
    ? `${stats.weapon.name} (${stats.weapon.id})${stats.weapon.token ? ` token=${stats.weapon.token}` : ''}${stats.weapon.stem ? ` stem=${stats.weapon.stem}` : ''}`
    : 'unarmed';
  return [
    `${stats.fps} FPS${stats.heapMB !== null ? ` · ${stats.heapMB} MB` : ''} · ${stats.geometries} geo · ${stats.textures} tex`,
    `Render: ${stats.calls} calls · ${stats.triangles} tris`,
    `Frame: update ${stats.updateMs.toFixed(2)} ms · render ${stats.renderMs.toFixed(2)} ms`,
    `Particles: ${stats.simulatedParticles}/${stats.particleInstances} · ${stats.particleEffects} effects · ${stats.particleBatches} batches · ${stats.culledParticleEffects} culled · ${stats.particleUpdateMs.toFixed(2)} ms`,
    `Anim: ${stats.clipKey ?? '-'}`,
    `Weapon: ${weapon}`,
    `Viewport: ${orientation} (${window.innerWidth}x${window.innerHeight})`,
  ].join('\n');
}

/** Top-right FPS/memory/renderer/animation/weapon readout, refreshed twice a second by ViewerScene - see STATS_UPDATE_INTERVAL_SEC. Includes a copy button so a snapshot (e.g. for a perf bug report) doesn't have to be retyped by hand. */
export default function StatsPanel({ stats }: StatsPanelProps) {
  const orientation = useOrientation();
  const [copied, setCopied] = useState(false);

  // Every real stats refresh (twice a second - see STATS_UPDATE_INTERVAL_SEC)
  // hands this a fresh object, so this also doubles as an auto-reset timer
  // for the "Copied!" flash - same "reset via an effect keyed to the data
  // changing" pattern WeaponEditPanel/EffectEditPanel's own copy buttons use,
  // just driven by the panel's own natural refresh instead of a selection
  // change.
  useEffect(() => {
    setCopied(false);
  }, [stats]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(buildStatsCopyText(stats, orientation)).then(() => setCopied(true));
  };

  return (
    <div className="debug-panel-stats">
      <div>
        {stats.fps} FPS
        {stats.heapMB !== null && <> · {stats.heapMB} MB</>}
        {' · '}
        {stats.geometries} geo · {stats.textures} tex
      </div>
      <div>Render: {stats.calls} calls · {stats.triangles.toLocaleString()} tris</div>
      <div>
        Frame: update {stats.updateMs.toFixed(2)} ms · render {stats.renderMs.toFixed(2)} ms
      </div>
      <div>
        Particles: {stats.simulatedParticles}/{stats.particleInstances} · {stats.particleEffects} effects · {stats.particleBatches} batches · {stats.culledParticleEffects} culled · {stats.particleUpdateMs.toFixed(2)} ms
      </div>
      <div>Anim: {stats.clipKey ?? '—'}</div>
      <div>
        Weapon:{' '}
        {stats.weapon
          ? `${stats.weapon.name} (${stats.weapon.id})${stats.weapon.token ? ` token=${stats.weapon.token}` : ''}${stats.weapon.stem ? ` stem=${stats.weapon.stem}` : ''}`
          : 'unarmed'}
      </div>
      <div>
        Viewport: {orientation} ({window.innerWidth}×{window.innerHeight})
      </div>
      <button type="button" className="debug-panel-stats-copy" onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}
