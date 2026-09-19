import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AttackTargetPanel from '../hud/AttackTargetPanel';
import ChatBox from '../hud/ChatBox';
import FpsCounter from '../hud/FpsCounter';
import FullscreenButton from '../hud/FullscreenButton';
import HudIconRow from '../hud/HudIconRow';
import InventoryWindow from '../inventory/InventoryWindow';
import MiniMap from '../hud/MiniMap';
import type { MiniMapHandle } from '../hud/MiniMap';
import MobileControls from '../hud/MobileControls';
import PingIndicator from '../hud/PingIndicator';
import ShortcutBar from '../hud/ShortcutBar';
import { createEmptyShortcutGrid, SHORTCUT_ROW_COUNT } from '../hud/shortcutBarTypes';
import type { ShortcutCarry, ShortcutCarryPointer, ShortcutEntry, ShortcutGrid } from '../hud/shortcutBarTypes';
import { LoadingScreen } from '../ui';
import VitalsBar from '../hud/VitalsBar';
import { useKeyboardMove } from '../../hooks/useKeyboardMove';
import type { RaceGender } from '../../rf/character';
import type { ConnectionStatus } from '../../net/WorldConnection';
import { OnlineScene } from '../../scenes/OnlineScene';
import type { ChatLogEntry, EquipmentDisplay, EquipmentSlotKey, InventoryState, SelectedTarget } from '../../scenes/OnlineScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './OnlineScreen.css';

const EMPTY_INVENTORY: InventoryState = { slots: [], gold: 0, cp: 0 };

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
  const [loadProgress, setLoadProgress] = useState(0);
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [chatEntries, setChatEntries] = useState<ChatLogEntry[]>([]);
  const [inventory, setInventory] = useState<InventoryState>(EMPTY_INVENTORY);
  const [equipment, setEquipment] = useState<EquipmentDisplay>({});
  const [shortcutRows, setShortcutRows] = useState<ShortcutGrid>(() => createEmptyShortcutGrid());
  const [shortcutRowVisibility, setShortcutRowVisibility] = useState<boolean[]>(() =>
    Array.from({ length: SHORTCUT_ROW_COUNT }, (_, index) => index === 0),
  );
  const [shortcutCarry, setShortcutCarry] = useState<ShortcutCarry | null>(null);
  const [shortcutCarryPointer, setShortcutCarryPointer] = useState<ShortcutCarryPointer | null>(null);
  const equippedItemCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const visual of Object.values(equipment)) {
      if (visual?.itemCode) codes.add(visual.itemCode);
    }
    return codes;
  }, [equipment]);
  const equippedSlotByItemCode = useMemo(() => {
    const slots = new Map<string, EquipmentSlotKey>();
    for (const [slotKey, visual] of Object.entries(equipment) as [EquipmentSlotKey, { itemCode: string; upgrade: string } | undefined][]) {
      if (visual?.itemCode) slots.set(visual.itemCode, slotKey);
    }
    return slots;
  }, [equipment]);

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
      onLoadProgress: setLoadProgress,
      onTargetChange: setSelectedTarget,
      onPingChange: setPingMs,
      onFpsChange: setFps,
      onRadarFrame: (frame) => miniMapRef.current?.update(frame.facingRad, frame.blips),
      onChatMessage: (entry) => setChatEntries((prev) => [...prev, entry].slice(-MAX_CHAT_ENTRIES)),
      onInventoryChange: setInventory,
      onEquipmentChange: setEquipment,
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

  const handleAttack = useCallback(() => {
    onlineSceneRef.current?.attackSelectedTarget();
  }, []);

  const handleSendChat = useCallback((message: string) => {
    onlineSceneRef.current?.sendChatMessage(message);
  }, []);

  const handleSellItem = useCallback((slotIndex: number) => {
    onlineSceneRef.current?.sellInventoryItem(slotIndex);
  }, []);
  const handleDropItem = useCallback((slotIndex: number) => {
    onlineSceneRef.current?.dropInventoryItem(slotIndex);
  }, []);
  const handleUseItem = useCallback((slotIndex: number) => {
    onlineSceneRef.current?.useInventoryItem(slotIndex);
  }, []);
  const handleUnuseItem = useCallback((slotKey: EquipmentSlotKey) => {
    onlineSceneRef.current?.unuseEquipmentItem(slotKey);
  }, []);

  useEffect(() => {
    if (!shortcutCarry) return;
    const handlePointerMove = (event: PointerEvent) => setShortcutCarryPointer({ x: event.clientX, y: event.clientY });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShortcutCarry(null);
      setShortcutCarryPointer(null);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [shortcutCarry]);

  const handleAssignShortcut = useCallback(
    (rowIndex: number, colIndex: number, shortcut: ShortcutEntry) => {
      if (shortcut.kind === 'inventory' && inventory.slots[shortcut.slotIndex]?.itemCode !== shortcut.itemCode) return;
      setShortcutRows((current) =>
        current.map((row, r) => (r === rowIndex ? row.map((entry, c) => (c === colIndex ? shortcut : entry)) : row)),
      );
      setShortcutRowVisibility((current) => current.map((visible, index) => (index === rowIndex ? true : visible)));
    },
    [inventory.slots],
  );

  const handleClearShortcut = useCallback((rowIndex: number, colIndex: number) => {
    setShortcutRows((current) => current.map((row, r) => (r === rowIndex ? row.map((entry, c) => (c === colIndex ? null : entry)) : row)));
  }, []);

  const handlePickInventoryShortcut = useCallback((slotIndex: number, itemCode: string, point: ShortcutCarryPointer) => {
    if (inventory.slots[slotIndex]?.itemCode !== itemCode) return;
    setShortcutCarry({ source: 'inventory', slotIndex, itemCode });
    setShortcutCarryPointer(point);
  }, [inventory.slots]);

  const handlePickShortcut = useCallback((rowIndex: number, colIndex: number, shortcut: ShortcutEntry, point: ShortcutCarryPointer) => {
    setShortcutCarry({ source: 'shortcut', rowIndex, colIndex, shortcut });
    setShortcutCarryPointer(point);
  }, []);

  const handleMoveShortcut = useCallback((sourceRowIndex: number, sourceColIndex: number, targetRowIndex: number, targetColIndex: number) => {
    if (sourceRowIndex === targetRowIndex && sourceColIndex === targetColIndex) return;
    setShortcutRows((current) => {
      const source = current[sourceRowIndex]?.[sourceColIndex];
      if (!source || !current[targetRowIndex]) return current;
      const target = current[targetRowIndex][targetColIndex] ?? null;
      return current.map((row, rowIndex) =>
        row.map((entry, colIndex) => {
          if (rowIndex === sourceRowIndex && colIndex === sourceColIndex) return target;
          if (rowIndex === targetRowIndex && colIndex === targetColIndex) return source;
          return entry;
        }),
      );
    });
  }, []);

  const handleDropShortcut = useCallback(
    (rowIndex: number, colIndex: number) => {
      if (!shortcutCarry) return;
      if (shortcutCarry.source === 'inventory') {
        if (inventory.slots[shortcutCarry.slotIndex]?.itemCode === shortcutCarry.itemCode) {
          handleAssignShortcut(rowIndex, colIndex, {
            kind: 'inventory',
            slotIndex: shortcutCarry.slotIndex,
            itemCode: shortcutCarry.itemCode,
          });
        }
      } else {
        handleMoveShortcut(shortcutCarry.rowIndex, shortcutCarry.colIndex, rowIndex, colIndex);
      }
      setShortcutCarry(null);
      setShortcutCarryPointer(null);
    },
    [handleAssignShortcut, handleMoveShortcut, inventory.slots, shortcutCarry],
  );

  const handleCancelShortcutCarry = useCallback(() => {
    setShortcutCarry(null);
    setShortcutCarryPointer(null);
  }, []);

  const handleToggleShortcutRow = useCallback((rowIndex: number) => {
    setShortcutRowVisibility((current) => current.map((visible, index) => (index === rowIndex ? !visible : visible)));
  }, []);

  return (
    <div className="online-screen">
      {status === 'ready' && <MiniMap ref={miniMapRef} />}
      {status === 'ready' && <ChatBox entries={chatEntries} onSend={handleSendChat} />}
      {status === 'ready' && <PingIndicator pingMs={pingMs} />}
      {status === 'ready' && <FpsCounter fps={fps} />}
      {status === 'ready' && <FullscreenButton />}
      {status === 'ready' && <HudIconRow onOpenInventory={handleToggleInventory} onOpenSettings={onExit} settingsLabel={onExit ? 'Exit' : 'Settings'} />}
      {status === 'ready' && <VitalsBar />}
      {status === 'ready' && <AttackTargetPanel target={selectedTarget} onAttack={handleAttack} />}
      {status === 'ready' && (
        <ShortcutBar
          shortcutCarry={shortcutCarry}
          shortcutCarryPointer={shortcutCarryPointer}
          inventory={inventory}
          equippedItemCodes={equippedItemCodes}
          equippedSlotByItemCode={equippedSlotByItemCode}
          shortcuts={shortcutRows}
          rowVisibility={shortcutRowVisibility}
          onDropShortcut={handleDropShortcut}
          onClear={handleClearShortcut}
          onCancelCarry={handleCancelShortcutCarry}
          onPickShortcut={handlePickShortcut}
          onToggleRow={handleToggleShortcutRow}
          onUseInventorySlot={handleUseItem}
          onUnuseEquipmentSlot={handleUnuseItem}
        />
      )}
      {status === 'ready' && <MobileControls onMove={handleMoveInput} onAttack={handleAttack} />}
      {status === 'ready' && inventoryOpen && (
        <InventoryWindow
          onClose={handleCloseInventory}
          inventory={inventory}
          equipment={equipment}
          onSell={handleSellItem}
          onDrop={handleDropItem}
          onUse={handleUseItem}
          onUnuse={handleUnuseItem}
          shortcutCarry={shortcutCarry}
          onPickShortcutItem={handlePickInventoryShortcut}
        />
      )}

      {status === 'loading' && <LoadingScreen progress={loadProgress} label="Entering the world…" />}
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
    </div>
  );
}
