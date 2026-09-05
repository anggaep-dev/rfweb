import { useOrientation } from '../../hooks/useOrientation';
import type { ViewerDebugStats } from '../../scenes/ViewerScene';
import './DebugPanel.css';

export interface StatsPanelProps {
  stats: ViewerDebugStats;
}

/** Top-right FPS/memory/renderer/animation/weapon readout, refreshed twice a second by ViewerScene - see STATS_UPDATE_INTERVAL_SEC. */
export default function StatsPanel({ stats }: StatsPanelProps) {
  const orientation = useOrientation();

  return (
    <div className="debug-panel-stats">
      <div>
        {stats.fps} FPS
        {stats.heapMB !== null && <> · {stats.heapMB} MB</>}
        {' · '}
        {stats.geometries} geo · {stats.textures} tex
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
    </div>
  );
}
