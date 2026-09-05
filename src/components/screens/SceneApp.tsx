import { useEffect, useRef, useState } from 'react';
import OnlineScreen from './OnlineScreen';
import RfViewer from './RfViewer';
import { preloadAllRaces, preloadWeaponMeshes, RaceGender } from '../../rf/character';
import { loadSlotItems, ModelType } from '../../rf/items';
import CharacterSelectScreen from './CharacterSelectScreen';
import LoginScreen from './LoginScreen';
import { SceneManager } from '../../scenes/SceneManager';
import './SceneApp.css';

type Screen = 'preloading' | 'login' | 'characterSelect' | 'viewer';

/** "/debug" reaches the old offline/debug viewer (ViewerScene); every other path is online play (OnlineScene). */
const isDebugRoute = window.location.pathname.replace(/\/+$/, '') === '/debug';

/** /debug skips login/character-select entirely - DebugPanel's own race switcher (top-left, once "%debug 1" is run) covers picking a character. */
const DEBUG_DEFAULT_RACE = RaceGender.Bell_Male;

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

    // Blocks entry past the login screen until every race's assets AND
    // every currently-existing weapon's mesh are cached, so nothing past
    // this screen - character-select, equipping any item, switching races -
    // ever hits the network again. The two run concurrently and report into
    // one combined counter; weapon preloading's own total isn't known until
    // its item list + stem resolution finishes (a moment after race
    // preloading's, which is a compile-time constant - see preloadAllRaces),
    // so the combined total briefly under-reports right at the start.
    let raceProgress = { loaded: 0, total: 0 };
    let weaponProgress = { loaded: 0, total: 0 };
    const reportCombinedProgress = () => {
      if (!disposed) {
        setPreloadProgress({
          loaded: raceProgress.loaded + weaponProgress.loaded,
          total: raceProgress.total + weaponProgress.total,
        });
      }
    };

    Promise.all([
      preloadAllRaces((loaded, total) => {
        raceProgress = { loaded, total };
        reportCombinedProgress();
      }),
      loadSlotItems(ModelType.Weapon).then((items) =>
        preloadWeaponMeshes(
          items.map((item) => item.model),
          (loaded, total) => {
            weaponProgress = { loaded, total };
            reportCombinedProgress();
          },
        ),
      ),
    ])
      .then(() => {
        if (disposed) return;
        if (isDebugRoute) {
          setSelectedRace(DEBUG_DEFAULT_RACE);
          setScreen('viewer');
        } else {
          setScreen('login');
        }
      })
      .catch((err: unknown) => {
        if (disposed) return;
        console.error('Failed to preload assets:', err);
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
          Preloading assets… {preloadProgress.loaded}/{preloadProgress.total}
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
      {sceneManager &&
        screen === 'viewer' &&
        selectedRace !== null &&
        (isDebugRoute ? (
          <RfViewer sceneManager={sceneManager} initialRaceGender={selectedRace} />
        ) : (
          <OnlineScreen
            sceneManager={sceneManager}
            initialRaceGender={selectedRace}
            onExit={() => setScreen('characterSelect')}
          />
        ))}
    </div>
  );
}
