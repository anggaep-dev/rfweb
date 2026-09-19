import { memo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import SearchableSelect from './SearchableSelect';
import type { SearchableSelectOption } from './SearchableSelect';
import type { MonsterMode } from '../../controllers/MonsterController';
import './DebugPanel.css';

export interface MonsterPanelProps {
  /** Every converted monster stem (scripts/unpack_and_convert_monsters.py's manifest.json), undefined while still loading. */
  monsterNames: SearchableSelectOption[] | undefined;
  selectedMonster: string;
  onSelectedMonsterChange: (id: string) => void;
  spawnCount: number;
  onSpawnCountChange: (count: number) => void;
  /** Which PEACE/WAR* clip family newly-spawned instances wander/idle with - see MonsterController's own doc comment. */
  mode: MonsterMode;
  onModeChange: (mode: MonsterMode) => void;
  onSpawn: () => void;
  onClear: () => void;
  spawnedCount: number;
  /** The most recently spawned monster's own embedded clip names - see MonsterBotController.getLastSpawnedClipNames. Empty (dropdown hidden) before any successful spawn, same as DebugPanel's cloakAniStates. */
  clipNames: string[];
  onClipSelect: (name: string) => void;
  onClose: () => void;
}

/**
 * `%moncall` debug tool: pick a converted monster by name (type-to-search,
 * same SearchableSelect EquipPanel uses for items - a plain <select> would
 * be unusable once hundreds of monsters are converted), a Peace/War mode,
 * spawn N copies of it (they wander on their own from here - see
 * MonsterBotController), then optionally force a specific embedded clip
 * across every currently-spawned instance at once - for reviewing
 * scripts/monster_to_gltf.py's conversion output.
 *
 * Centered by default and drag-repositionable (see the header's own pointer
 * handlers below) rather than pinned to a screen corner like the other
 * debug panels - this one's meant to be dragged out of the way of whatever
 * part of the spawned monsters you're actually looking at, not left in a
 * fixed spot.
 */
const MonsterPanel = memo(function MonsterPanel({
  monsterNames,
  selectedMonster,
  onSelectedMonsterChange,
  spawnCount,
  onSpawnCountChange,
  mode,
  onModeChange,
  onSpawn,
  onClear,
  spawnedCount,
  clipNames,
  onClipSelect,
  onClose,
}: MonsterPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // null = still at the default centered position (see the CSS class's own
  // transform: translate(-50%, -50%)); once dragged, an explicit pixel
  // left/top takes over and the panel stops re-centering itself. Kept as
  // plain state (not a ref) since it needs to actually re-render the panel
  // at its new position while dragging.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Let the close button's own onClick fire normally instead of starting a drag.
    if ((event.target as HTMLElement).closest('.debug-panel-panel-close')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: rect.left, startTop: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({ left: drag.startLeft + (event.clientX - drag.startX), top: drag.startTop + (event.clientY - drag.startY) });
  };

  const handleDragPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return (
    <div
      ref={panelRef}
      className="debug-panel-monster-panel"
      style={position ? { left: position.left, top: position.top, transform: 'none' } : undefined}
    >
      <div
        className="debug-panel-panel-header debug-panel-panel-header-draggable"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
      >
        <span>Monsters</span>
        <button type="button" className="debug-panel-panel-close" onClick={onClose} aria-label="Close monster panel">
          ×
        </button>
      </div>

      <label className="debug-panel-equip-row">
        <span>Monster</span>
        <SearchableSelect value={selectedMonster} options={monsterNames} onChange={onSelectedMonsterChange} />
      </label>

      <label className="debug-panel-equip-row">
        <span>Mode</span>
        <select className="debug-panel-monster-mode-select" value={mode} onChange={(e) => onModeChange(e.target.value as MonsterMode)}>
          <option value="peace">Peace</option>
          <option value="war">War</option>
        </select>
      </label>

      <label className="debug-panel-equip-row">
        <span>Count</span>
        <input
          type="number"
          className="debug-panel-monster-count-input"
          min={1}
          max={30}
          value={spawnCount}
          onChange={(e) => onSpawnCountChange(Number.parseInt(e.target.value, 10) || 1)}
        />
      </label>

      <div className="debug-panel-controls">
        <button type="button" disabled={!selectedMonster} onClick={onSpawn}>
          Spawn
        </button>
        <button type="button" disabled={spawnedCount === 0} onClick={onClear}>
          Clear ({spawnedCount})
        </button>
      </div>

      {clipNames.length > 0 && (
        <select
          className="debug-panel-cloak-ani-select"
          value=""
          onChange={(e) => {
            if (e.target.value) onClipSelect(e.target.value);
          }}
        >
          <option value="" disabled>
            animation: preview...
          </option>
          {clipNames.map((clip) => (
            <option key={clip} value={clip}>
              {clip}
            </option>
          ))}
        </select>
      )}
    </div>
  );
});

export default MonsterPanel;
