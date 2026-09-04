import type { ViewerDebugStats } from './scenes/ViewerScene';
import './DebugPanel.css';

export interface StatsPanelProps {
  stats: ViewerDebugStats;
}

/** Top-right FPS/memory/renderer readout, refreshed twice a second by ViewerScene - see STATS_UPDATE_INTERVAL_SEC. */
export default function StatsPanel({ stats }: StatsPanelProps) {
  return (
    <div className="debug-panel-stats">
      {stats.fps} FPS
      {stats.heapMB !== null && <> · {stats.heapMB} MB</>}
      {' · '}
      {stats.geometries} geo · {stats.textures} tex
    </div>
  );
}
