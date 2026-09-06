import { useCallback, useEffect, useRef, useState } from 'react';
import FullscreenButton from '../hud/FullscreenButton';
import PingIndicator from '../hud/PingIndicator';
import { useKeyboardMove } from '../../hooks/useKeyboardMove';
import type { RaceGender } from '../../rf/character';
import type { ConnectionStatus } from '../../net/WorldConnection';
import { OnlineScene } from '../../scenes/OnlineScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './OnlineScreen.css';

export interface OnlineScreenProps {
  sceneManager: SceneManager;
  initialRaceGender: RaceGender;
  /** Issued by LoginScreen's real login() call - the WS connection authenticates with this. */
  sessionToken: string;
  /** Which of the account's characters (CharacterSelectScreen) is entering the world. */
  characterId: string;
  /** Optional "back to character select" action, shown as a button when provided. */
  onExit?: () => void;
}

export default function OnlineScreen({ sceneManager, initialRaceGender, sessionToken, characterId, onExit }: OnlineScreenProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [pingMs, setPingMs] = useState<number | null>(null);

  // Assigned by the mount effect below, so handleMoveInput (and any other
  // future per-frame input) can reach the scene without needing it in its
  // own dependency array - same pattern RfViewer uses for viewerSceneRef.
  const onlineSceneRef = useRef<OnlineScene | null>(null);

  useEffect(() => {
    const onlineScene = new OnlineScene(sceneManager.renderer, initialRaceGender, sessionToken, characterId, {
      onConnectionStatusChange: setConnectionStatus,
      onStatusChange: (nextStatus, message) => {
        setStatus(nextStatus);
        setErrorMessage(message ?? '');
      },
      onPingChange: setPingMs,
    });
    onlineSceneRef.current = onlineScene;
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(onlineScene);

    return () => {
      onlineSceneRef.current = null;
    };
  }, [sceneManager, initialRaceGender, sessionToken, characterId]);

  // Camera-relative (x=right, y=forward - see OnlineScene's own doc comment
  // on why movement is camera-relative now) WASD/arrow-key input, same
  // shared channel ViewerScene's debug controls use. Memoized so
  // useKeyboardMove's listeners aren't torn down/reattached (losing
  // in-progress key state) on every unrelated re-render - see RfViewer's
  // own handleMoveInput for the same reasoning.
  const handleMoveInput = useCallback((input: { x: number; y: number } | null) => {
    onlineSceneRef.current?.setMoveInput(input);
  }, []);

  useKeyboardMove(handleMoveInput);

  return (
    <div className="online-screen">
      {status === 'ready' && <PingIndicator pingMs={pingMs} />}
      {status === 'ready' && <FullscreenButton />}

      {status === 'loading' && <div className="online-screen-overlay">Loading character…</div>}
      {status === 'error' && (
        <div className="online-screen-overlay online-screen-overlay-error">
          Failed to load character: {errorMessage}
        </div>
      )}
      {status === 'ready' && connectionStatus !== 'open' && (
        <div className="online-screen-overlay">
          {connectionStatus === 'connecting' ? 'Connecting to server…' : 'Disconnected from server.'}
        </div>
      )}
      {onExit && (
        <button className="online-screen-exit" onClick={onExit}>
          Exit
        </button>
      )}
    </div>
  );
}
