import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { InventorySlot } from '../../net/generated/protocol';
import type { EquipmentSlotKey, InventoryState } from '../../scenes/OnlineScene';
import { findItemDefinitionByCode } from '../../rf/items';
import type { ItemDefinition, ModelType } from '../../rf/items';
import { getItemIconUrl } from '../../rf/itemIcon';
import { SHORTCUT_ROW_COUNT } from './shortcutBarTypes';
import { shortcutCarryItemCode } from './shortcutBarTypes';
import type { ShortcutCarry, ShortcutCarryPointer, ShortcutEntry, ShortcutGrid } from './shortcutBarTypes';
import './ShortcutBar.css';

interface ItemDisplayInfo {
  name: string;
  iconUrl: string | null;
  item?: ItemDefinition;
  modelType?: ModelType;
}

export interface ShortcutBarProps {
  shortcutCarry: ShortcutCarry | null;
  shortcutCarryPointer: ShortcutCarryPointer | null;
  inventory: InventoryState;
  equippedItemCodes: ReadonlySet<string>;
  equippedSlotByItemCode: ReadonlyMap<string, EquipmentSlotKey>;
  shortcuts: ShortcutGrid;
  rowVisibility: boolean[];
  onDropShortcut: (rowIndex: number, colIndex: number) => void;
  onClear: (rowIndex: number, colIndex: number) => void;
  onCancelCarry: () => void;
  onPickShortcut: (rowIndex: number, colIndex: number, shortcut: ShortcutEntry, point: ShortcutCarryPointer) => void;
  onToggleRow: (rowIndex: number) => void;
  onUseInventorySlot: (slotIndex: number) => void;
  onUnuseEquipmentSlot: (slotKey: EquipmentSlotKey) => void;
}

const LONG_PRESS_MS = 420;
const LONG_PRESS_MOVE_TOLERANCE = 10;

function collectShortcutCodes(shortcuts: ShortcutGrid, shortcutCarry: ShortcutCarry | null): string[] {
  const codes = new Set<string>();
  for (const row of shortcuts) {
    for (const shortcut of row) {
      if (shortcut?.kind !== 'inventory') continue;
      codes.add(shortcut.itemCode);
    }
  }
  const carryItemCode = shortcutCarryItemCode(shortcutCarry);
  if (carryItemCode) codes.add(carryItemCode);
  return [...codes];
}

function fallbackInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

export default function ShortcutBar({
  shortcutCarry,
  shortcutCarryPointer,
  inventory,
  equippedItemCodes,
  equippedSlotByItemCode,
  shortcuts,
  rowVisibility,
  onDropShortcut,
  onClear,
  onCancelCarry,
  onPickShortcut,
  onToggleRow,
  onUseInventorySlot,
  onUnuseEquipmentSlot,
}: ShortcutBarProps) {
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<ShortcutCarryPointer | null>(null);
  const suppressNextTap = useRef(false);
  const lastPointerType = useRef<string>('mouse');
  const [itemDisplay, setItemDisplay] = useState<Record<string, ItemDisplayInfo>>({});
  const shortcutCodes = useMemo(() => collectShortcutCodes(shortcuts, shortcutCarry), [shortcutCarry, shortcuts]);
  const visibleRowCount = rowVisibility.filter(Boolean).length;

  useEffect(() => {
    const missing = shortcutCodes.filter((code) => !(code in itemDisplay));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (code) => {
        const resolved = await findItemDefinitionByCode(code).catch(() => null);
        if (!resolved) return [code, { name: code, iconUrl: null }] as const;
        const iconUrl = await getItemIconUrl(resolved.modelType, resolved.item.icon).catch(() => null);
        return [code, { name: resolved.item.name, iconUrl, item: resolved.item, modelType: resolved.modelType }] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setItemDisplay((prev) => {
        const next = { ...prev };
        for (const [code, display] of results) next[code] = display;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [itemDisplay, shortcutCodes]);

  const clearLongPressTimer = () => {
    if (longPressTimer.current === null) return;
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>, shortcut: ShortcutEntry | null) => {
    event.preventDefault();
    if (!shortcut) {
      onCancelCarry();
      return;
    }
    if (shortcut.kind === 'inventory') {
      const equippedSlotKey = equippedSlotByItemCode.get(shortcut.itemCode);
      if (equippedSlotKey) {
        onUnuseEquipmentSlot(equippedSlotKey);
        onCancelCarry();
        return;
      }
      const slot = inventory.slots[shortcut.slotIndex];
      if (slot?.itemCode === shortcut.itemCode) onUseInventorySlot(shortcut.slotIndex);
    }
    onCancelCarry();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, rowIndex: number, colIndex: number, shortcut: ShortcutEntry | null) => {
    lastPointerType.current = event.pointerType;
    clearLongPressTimer();
    if (event.pointerType === 'mouse' || !shortcut) return;
    longPressStart.current = { x: event.clientX, y: event.clientY };
    longPressTimer.current = window.setTimeout(() => {
      suppressNextTap.current = true;
      onPickShortcut(rowIndex, colIndex, shortcut, { x: event.clientX, y: event.clientY });
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!longPressStart.current) return;
    if (Math.hypot(event.clientX - longPressStart.current.x, event.clientY - longPressStart.current.y) <= LONG_PRESS_MOVE_TOLERANCE) return;
    clearLongPressTimer();
    longPressStart.current = null;
  };

  const handlePointerEnd = () => {
    clearLongPressTimer();
    longPressStart.current = null;
  };

  const handleSlotClick = (event: ReactMouseEvent<HTMLDivElement>, rowIndex: number, colIndex: number, shortcut: ShortcutEntry | null, slot: InventorySlot | undefined) => {
    if (suppressNextTap.current) {
      suppressNextTap.current = false;
      event.preventDefault();
      return;
    }
    if (shortcutCarry) {
      onDropShortcut(rowIndex, colIndex);
      return;
    }
    if (!shortcut) return;
    if (lastPointerType.current === 'mouse') {
      onPickShortcut(rowIndex, colIndex, shortcut, { x: event.clientX, y: event.clientY });
      return;
    }
    if (shortcut.kind === 'inventory' && slot?.itemCode === shortcut.itemCode) onUseInventorySlot(shortcut.slotIndex);
  };

  const renderSlotContent = (shortcut: ShortcutEntry | null, slot: InventorySlot | undefined) => {
    if (!shortcut) return null;
    if (shortcut.kind === 'skill') {
      return <span className="shortcut-slot-label">SK</span>;
    }
    const display = itemDisplay[shortcut.itemCode] ?? { name: shortcut.itemCode, iconUrl: null };
    return (
      <>
        {display.iconUrl ? (
          <img className="shortcut-slot-icon" src={display.iconUrl} alt="" />
        ) : (
          <span className="shortcut-slot-label">{fallbackInitials(display.name)}</span>
        )}
        {slot?.quantity && slot.quantity > 1 && <span className="shortcut-slot-qty">{slot.quantity}</span>}
      </>
    );
  };

  return (
    <div className="shortcut-bar" aria-label="Shortcut bar">
      <details className="shortcut-row-dropdown">
        <summary className="shortcut-row-dropdown-trigger" aria-label="Shortcut row visibility">
          Rows {visibleRowCount}/{SHORTCUT_ROW_COUNT}
        </summary>
        <div className="shortcut-row-dropdown-menu">
          {Array.from({ length: SHORTCUT_ROW_COUNT }, (_, rowIndex) => (
            <button
              key={rowIndex}
              type="button"
              className={`shortcut-row-dropdown-item${rowVisibility[rowIndex] ? ' shortcut-row-dropdown-item-active' : ''}`}
              aria-pressed={rowVisibility[rowIndex]}
              onClick={() => onToggleRow(rowIndex)}
            >
              <span className="shortcut-row-dropdown-check" aria-hidden="true" />
              Row {rowIndex + 1}
            </button>
          ))}
        </div>
      </details>

      <div className="shortcut-row-stack">
        {shortcuts.map((row, rowIndex) => {
          if (!rowVisibility[rowIndex]) return null;
          return (
            <div key={rowIndex} className="shortcut-row" role="group" aria-label={`Shortcut row ${rowIndex + 1}`}>
              <span className="shortcut-row-number" aria-hidden="true">
                {rowIndex + 1}
              </span>
              {row.map((shortcut, colIndex) => {
                const rawSlot = shortcut?.kind === 'inventory' ? inventory.slots[shortcut.slotIndex] : undefined;
                const slot = shortcut?.kind === 'inventory' && rawSlot?.itemCode === shortcut.itemCode ? rawSlot : undefined;
                const hasVisibleContent = Boolean(shortcut);
                const isEquipped = Boolean(shortcut?.kind === 'inventory' && equippedItemCodes.has(shortcut.itemCode));
                const isCarrySource =
                  shortcutCarry?.source === 'shortcut' && shortcutCarry.rowIndex === rowIndex && shortcutCarry.colIndex === colIndex;
                return (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    role="button"
                    tabIndex={0}
                    className={`shortcut-slot${hasVisibleContent ? ' shortcut-slot-filled' : ''}${isEquipped ? ' shortcut-slot-equipped' : ''}${isCarrySource ? ' shortcut-slot-carry-source' : ''}${shortcutCarry ? ' shortcut-slot-drop-ready' : ''}`}
                    aria-label={
                      shortcut?.kind === 'inventory'
                        ? `Shortcut ${rowIndex + 1}-${colIndex + 1}: ${itemDisplay[shortcut.itemCode]?.name ?? shortcut.itemCode}`
                        : `Shortcut ${rowIndex + 1}-${colIndex + 1}`
                    }
                    onClick={(event) => handleSlotClick(event, rowIndex, colIndex, shortcut, slot)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (shortcutCarry) {
                        onDropShortcut(rowIndex, colIndex);
                        return;
                      }
                      if (shortcut?.kind === 'inventory' && slot?.itemCode === shortcut.itemCode) onUseInventorySlot(shortcut.slotIndex);
                    }}
                    onContextMenu={(event) => handleContextMenu(event, shortcut)}
                    onPointerDown={(event) => handlePointerDown(event, rowIndex, colIndex, shortcut)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                  >
                    {renderSlotContent(shortcut, slot)}
                    {hasVisibleContent && (
                      <button
                        type="button"
                        draggable={false}
                        className="shortcut-slot-clear"
                        aria-label={`Clear shortcut ${rowIndex + 1}-${colIndex + 1}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onClear(rowIndex, colIndex);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          event.stopPropagation();
                          onClear(rowIndex, colIndex);
                        }}
                      >
                        x
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {shortcutCarry && shortcutCarryPointer && <ShortcutCarryPreview carry={shortcutCarry} pointer={shortcutCarryPointer} itemDisplay={itemDisplay} />}
    </div>
  );
}

function ShortcutCarryPreview({
  carry,
  pointer,
  itemDisplay,
}: {
  carry: ShortcutCarry;
  pointer: ShortcutCarryPointer;
  itemDisplay: Record<string, ItemDisplayInfo>;
}) {
  if (carry.source === 'shortcut' && carry.shortcut.kind === 'skill') {
    return (
      <div className="shortcut-carry-preview" style={{ left: pointer.x, top: pointer.y }}>
        <span className="shortcut-slot-label">SK</span>
      </div>
    );
  }
  const itemCode = shortcutCarryItemCode(carry);
  if (!itemCode) return null;
  const display = itemDisplay[itemCode] ?? { name: itemCode, iconUrl: null };
  return (
    <div className="shortcut-carry-preview" style={{ left: pointer.x, top: pointer.y }}>
      {display.iconUrl ? <img className="shortcut-slot-icon" src={display.iconUrl} alt="" /> : <span className="shortcut-slot-label">{fallbackInitials(display.name)}</span>}
    </div>
  );
}
