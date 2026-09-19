import { useMemo } from 'react';
import './LoadingScreen.css';

/** Concept-art sheets dropped in for the loading screen background - see public/game-assets/loadingscreen/. One is picked at random per mount, not re-randomized on every re-render (see the useMemo below), so the bar filling in doesn't also flicker the art. */
const LOADING_SCREEN_IMAGE_COUNT = 2;

export interface LoadingScreenProps {
  /** 0-1. Driven by real load milestones (see OnlineScene.mount's own onLoadProgress calls), not a fake/animated fill. */
  progress: number;
  /** Small status line under the bar, e.g. "Loading character…" / "Entering Elan…". */
  label?: string;
}

/**
 * Full-viewport branded loading overlay - shown while OnlineScreen's status
 * is 'loading' (character selected, world not yet ready: map details,
 * character model/profile, and map geometry are all loading in parallel -
 * see OnlineScene.mount). Replaces the old plain-text "Loading character…"
 * overlay with the concept-art background plus a real progress bar.
 */
export default function LoadingScreen({ progress, label }: LoadingScreenProps) {
  const imageIndex = useMemo(() => Math.floor(Math.random() * LOADING_SCREEN_IMAGE_COUNT), []);
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <div
      className="loading-screen"
      style={{ backgroundImage: `url(/game-assets/loadingscreen/${imageIndex}.png)` }}
      role="status"
      aria-live="polite"
    >
      <div className="loading-screen-scrim" />
      <div className="loading-screen-content">
        <div className="loading-screen-bar-track">
          <div className="loading-screen-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="loading-screen-footer">
          <span className="loading-screen-label">{label ?? 'Loading…'}</span>
          <span className="loading-screen-percent">{percent}%</span>
        </div>
      </div>
    </div>
  );
}
