import { useEffect, useRef, useState } from 'react';
import CharacterCreateScreen from './CharacterCreateScreen';
import CharacterCreateRaceScreen from './CharacterCreateRaceScreen';
import OnlineScreen from './OnlineScreen';
import RegisterScreen from './RegisterScreen';
import RfViewer from './RfViewer';
import UiTestPage from './UiTestPage';
import { preloadAllRaces, RaceGender } from '../../rf/character';
import CharacterSelectScreen from './CharacterSelectScreen';
import LoginScreen from './LoginScreen';
import { SceneManager } from '../../scenes/SceneManager';
import './SceneApp.css';

type Screen =
  | 'preloading'
  | 'login'
  | 'register'
  | 'characterSelect'
  | 'characterCreateRace'
  | 'characterCreate'
  | 'viewer'
  | 'uitest';

/** "/debug" reaches the old offline/debug viewer (ViewerScene); every other path is online play (OnlineScene). */
const isDebugRoute = window.location.pathname.replace(/\/+$/, '') === '/debug';

/** "/uitest" renders the UI component showcase page (no 3D scene needed). */
const isUiTestRoute = window.location.pathname.replace(/\/+$/, '') === '/uitest';

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
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  // Chosen in CharacterCreateRaceScreen, consumed by CharacterCreateScreen - only ever set while screen is 'characterCreateRace' or 'characterCreate'.
  const [createRace, setCreateRace] = useState<RaceGender | null>(null);
  // Issued by LoginScreen's real login() call (see net/AuthClient.ts) - the
  // WS connection authenticates with this, not with credentials again. Only
  // ever needed on the online (non-debug) route, which is the only one
  // that goes through LoginScreen for real - /debug skips straight to the
  // viewer.
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const sceneManager = new SceneManager(container);
    setSceneManagerState(sceneManager);

    // Blocks entry past the login screen only until every race's small
    // default-body assets are cached (~6MB/race) - real armor/weapon/cloak
    // meshes are loaded on demand instead, the first time an equip actually
    // needs one (see getRaceArmorArchives/loadParsedWeaponMesh/
    // loadCloakArchives), so this stays fast regardless of how much
    // equipment data exists rather than blocking on ~600MB of it upfront.
    preloadAllRaces((loaded, total) => {
      if (!disposed) setPreloadProgress({ loaded, total });
    })
      .then(() => {
        if (disposed) return;
        if (isDebugRoute) {
          setSelectedRace(DEBUG_DEFAULT_RACE);
          setScreen('viewer');
        } else if (isUiTestRoute) {
          setScreen('uitest');
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
        <LoginScreen
          sceneManager={sceneManager}
          onLoggedIn={(token) => {
            setSessionToken(token);
            setScreen('characterSelect');
          }}
          onSwitchToRegister={() => setScreen('register')}
        />
      )}
      {sceneManager && screen === 'register' && (
        <RegisterScreen
          sceneManager={sceneManager}
          onRegistered={(token) => {
            setSessionToken(token);
            setScreen('characterSelect');
          }}
          onSwitchToLogin={() => setScreen('login')}
        />
      )}
      {sceneManager && screen === 'characterSelect' && sessionToken !== null && (
        <CharacterSelectScreen
          sceneManager={sceneManager}
          sessionToken={sessionToken}
          onEnterWorld={(characterId, race) => {
            setSelectedCharacterId(characterId);
            setSelectedRace(race);
            setScreen('viewer');
          }}
          onCreateCharacter={() => setScreen('characterCreateRace')}
        />
      )}
      {sceneManager && screen === 'characterCreateRace' && (
        <CharacterCreateRaceScreen
          sceneManager={sceneManager}
          onPickRace={(race) => {
            setCreateRace(race);
            setScreen('characterCreate');
          }}
          onCancel={() => setScreen('characterSelect')}
        />
      )}
      {sceneManager && screen === 'characterCreate' && sessionToken !== null && createRace !== null && (
        <CharacterCreateScreen
          sceneManager={sceneManager}
          sessionToken={sessionToken}
          race={createRace}
          onCreated={() => setScreen('characterSelect')}
          onCancel={() => setScreen('characterCreateRace')}
        />
      )}
      {sceneManager &&
        screen === 'viewer' &&
        selectedRace !== null &&
        (isDebugRoute ? (
          <RfViewer sceneManager={sceneManager} initialRaceGender={selectedRace} />
        ) : sessionToken === null || selectedCharacterId === null ? null : (
          <OnlineScreen
            sceneManager={sceneManager}
            initialRaceGender={selectedRace}
            sessionToken={sessionToken}
            characterId={selectedCharacterId}
            onExit={() => setScreen('characterSelect')}
          />
        ))}

      {screen === 'uitest' && <UiTestPage />}
    </div>
  );
}
