import { useEffect, useRef, useState } from 'react';
import RfViewer from './RfViewer';
import { preloadAllRaces } from './rf/character';
import type { RaceGender } from './rf/character';
import CharacterSelectScreen from './scenes/CharacterSelectScreen';
import LoginScreen from './scenes/LoginScreen';
import { SceneManager } from './scenes/SceneManager';
import './SceneApp.css';

type Screen = 'preloading' | 'login' | 'characterSelect' | 'viewer';

/**
 * Owns the single shared SceneManager (renderer/canvas/render loop) and the
 * top-level login -> character-select -> viewer screen flow. Each screen
 * component is responsible for building its own AppScene and installing it
 * via sceneManager.setScene() in its own mount effect - this component just
 * decides which screen is current and hands out the shared SceneManager.
 */
export default function SceneApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sceneManager, setSceneManagerState] = useState<SceneManager | null>(null);

  const [screen, setScreen] = useState<Screen>('preloading');
  const [preloadProgress, setPreloadProgress] = useState({ loaded: 0, total: 1 });
  const [preloadError, setPreloadError] = useState('');
  const [selectedRace, setSelectedRace] = useState<RaceGender | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const sceneManager = new SceneManager(container);
    setSceneManagerState(sceneManager);

    // Blocks entry past the login screen until every race's assets are
    // cached, so character-select and the viewer never hit the network -
    // switching races or picking a character afterward is instant.
    preloadAllRaces((loaded, total) => {
      if (!disposed) setPreloadProgress({ loaded, total });
    })
      .then(() => {
        if (!disposed) setScreen('login');
      })
      .catch((err: unknown) => {
        if (disposed) return;
        console.error('Failed to preload race assets:', err);
        setPreloadError(err instanceof Error ? err.message : String(err));
      });

    const handleResize = () => sceneManager.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      sceneManager.dispose();
      setSceneManagerState(null);
    };
  }, []);

  return (
    <div className="scene-app">
      <div className="scene-app-canvas" ref={containerRef} />

      {screen === 'preloading' && !preloadError && (
        <div className="scene-app-overlay">
          Preloading all races… {preloadProgress.loaded}/{preloadProgress.total}
        </div>
      )}
      {preloadError && (
        <div className="scene-app-overlay scene-app-overlay-error">
          Failed to preload assets: {preloadError}
          <br />
          Make sure the files described in public/game-assets/README.md are in place.
        </div>
      )}

      {sceneManager && screen === 'login' && (
        <LoginScreen sceneManager={sceneManager} onLoggedIn={() => setScreen('characterSelect')} />
      )}
      {sceneManager && screen === 'characterSelect' && (
        <CharacterSelectScreen
          sceneManager={sceneManager}
          onEnterWorld={(race) => {
            setSelectedRace(race);
            setScreen('viewer');
          }}
        />
      )}
      {sceneManager && screen === 'viewer' && selectedRace !== null && (
        <RfViewer
          sceneManager={sceneManager}
          initialRaceGender={selectedRace}
          onExit={() => setScreen('characterSelect')}
        />
      )}
    </div>
  );
}
