import './FpsCounter.css';

export interface FpsCounterProps {
  /** Rounded frames-per-second, averaged over OnlineScene's own update interval - null before the first sample. */
  fps: number | null;
}

/** Good/warn/bad thresholds, in fps - tuned by eye, not measured against any real target framerate. */
const WARN_THRESHOLD_FPS = 45;
const BAD_THRESHOLD_FPS = 25;

function fpsClass(fps: number | null): string {
  if (fps === null) return 'fps-counter-unknown';
  if (fps <= BAD_THRESHOLD_FPS) return 'fps-counter-bad';
  if (fps <= WARN_THRESHOLD_FPS) return 'fps-counter-warn';
  return 'fps-counter-good';
}

export default function FpsCounter({ fps }: FpsCounterProps) {
  return <div className={`fps-counter ${fpsClass(fps)}`}>{fps === null ? '—' : `${fps} fps`}</div>;
}
