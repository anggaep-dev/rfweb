import './PingIndicator.css';

export interface PingIndicatorProps {
  /** Round-trip time in ms, or null while disconnected/not yet measured. */
  pingMs: number | null;
}

/** Good/warn/bad thresholds, in ms - tuned by eye, not measured against real server behavior. */
const WARN_THRESHOLD_MS = 150;
const BAD_THRESHOLD_MS = 300;

function pingClass(pingMs: number | null): string {
  if (pingMs === null) return 'ping-indicator-unknown';
  if (pingMs >= BAD_THRESHOLD_MS) return 'ping-indicator-bad';
  if (pingMs >= WARN_THRESHOLD_MS) return 'ping-indicator-warn';
  return 'ping-indicator-good';
}

export default function PingIndicator({ pingMs }: PingIndicatorProps) {
  return (
    <div className={`ping-indicator ${pingClass(pingMs)}`}>{pingMs === null ? '—' : `${Math.round(pingMs)} ms`}</div>
  );
}
