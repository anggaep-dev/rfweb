import { useEffect, useState } from 'react';
import FullscreenButton from '../hud/FullscreenButton';
import PingIndicator from '../hud/PingIndicator';
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

  useEffect(() => {
    const onlineScene = new OnlineScene(sceneManager.renderer, initialRaceGender, sessionToken, characterId, {
      onConnectionStatusChange: setConnectionStatus,
      onStatusChange: (nextStatus, message) => {
        setStatus(nextStatus);
        setErrorMessage(message ?? '');
      },
      onPingChange: setPingMs,
    });
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(onlineScene);
  }, [sceneManager, initialRaceGender, sessionToken, characterId]);

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
