import { useCallback, useEffect, useRef, useState } from 'react';
import ChatBox from '../hud/ChatBox';
import FullscreenButton from '../hud/FullscreenButton';
import HudIconRow from '../hud/HudIconRow';
import InventoryWindow from '../inventory/InventoryWindow';
import MiniMap from '../hud/MiniMap';
import type { MiniMapHandle } from '../hud/MiniMap';
import MobileControls from '../hud/MobileControls';
import PingIndicator from '../hud/PingIndicator';
import VitalsBar from '../hud/VitalsBar';
import { useKeyboardMove } from '../../hooks/useKeyboardMove';
import type { RaceGender } from '../../rf/character';
import type { ConnectionStatus } from '../../net/WorldConnection';
import { OnlineScene } from '../../scenes/OnlineScene';
import type { ChatLogEntry } from '../../scenes/OnlineScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './OnlineScreen.css';

/** Capped so a long session's chat log can't grow the DOM/memory unboundedly - oldest entries just fall off. */
const MAX_CHAT_ENTRIES = 50;

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
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [chatEntries, setChatEntries] = useState<ChatLogEntry[]>([]);

  // Assigned by the mount effect below, so handleMoveInput (and any other
  // future per-frame input) can reach the scene without needing it in its
  // own dependency array - same pattern RfViewer uses for viewerSceneRef.
  const onlineSceneRef = useRef<OnlineScene | null>(null);
  // Written to directly every frame (see onRadarFrame below), not through
  // React state - same reasoning as onlineSceneRef/MobileControls' knob.
  const miniMapRef = useRef<MiniMapHandle | null>(null);

  useEffect(() => {
    const onlineScene = new OnlineScene(sceneManager.renderer, initialRaceGender, sessionToken, characterId, {
      onConnectionStatusChange: setConnectionStatus,
      onStatusChange: (nextStatus, message) => {
        setStatus(nextStatus);
        setErrorMessage(message ?? '');
      },
      onPingChange: setPingMs,
      onRadarFrame: (frame) => miniMapRef.current?.update(frame.facingRad, frame.blips),
      onChatMessage: (entry) => setChatEntries((prev) => [...prev, entry].slice(-MAX_CHAT_ENTRIES)),
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
  // on why movement is camera-relative now) move intent, shared by WASD/
  // arrow keys (useKeyboardMove below) and the mobile joystick
  // (MobileControls below) - both drive the exact same setMoveInput()
  // channel, same as RfViewer/ViewerScene's equivalent pairing. Memoized
  // (stable identity) for two reasons, both confirmed live bugs in
  // RfViewer's own copy of this: useKeyboardMove's listeners would be torn
  // down/reattached (losing in-progress key state) on every unrelated
  // re-render, and MobileControls' unmount-cleanup effect would fire on
  // every fresh reference too, repeatedly zeroing the joystick input
  // mid-hold - see MobileControls' own onMoveRef doc comment.
  const handleMoveInput = useCallback((input: { x: number; y: number } | null) => {
    onlineSceneRef.current?.setMoveInput(input);
  }, []);

  useKeyboardMove(handleMoveInput);

  // Toggles, not just "open" - HudIconRow's Inventory button/(I) shortcut is
  // the only trigger there is right now, so pressing it again while open
  // needs to close it rather than being a no-op.
  const handleToggleInventory = useCallback(() => setInventoryOpen((open) => !open), []);
  const handleCloseInventory = useCallback(() => setInventoryOpen(false), []);

  const handleSendChat = useCallback((message: string) => {
    onlineSceneRef.current?.sendChatMessage(message);
  }, []);

  return (
    <div className="online-screen">
      {status === 'ready' && <MiniMap ref={miniMapRef} />}
      {status === 'ready' && <ChatBox entries={chatEntries} onSend={handleSendChat} />}
      {status === 'ready' && <PingIndicator pingMs={pingMs} />}
      {status === 'ready' && <FullscreenButton />}
      {status === 'ready' && <HudIconRow onOpenInventory={handleToggleInventory} />}
      {status === 'ready' && <VitalsBar />}
      {status === 'ready' && <MobileControls onMove={handleMoveInput} />}
      {status === 'ready' && inventoryOpen && <InventoryWindow onClose={handleCloseInventory} />}

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
