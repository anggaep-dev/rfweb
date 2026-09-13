import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { InventorySlot } from '../../net/generated/protocol';
import type { EquipmentDisplay, EquipmentSlotKey, InventoryState } from '../../scenes/OnlineScene';
import { findItemDefinitionByCode } from '../../rf/items';
import type { ItemDefinition, ModelType } from '../../rf/items';
import { getItemIconUrl } from '../../rf/itemIcon';
import { Card } from '../ui';
import ItemTooltip from './ItemTooltip';
import type { ItemTooltipData } from './ItemTooltip';
import './InventoryWindow.css';

/** What the name/icon-resolution effect below caches per item_code - see itemDisplay's own doc comment. */
interface ItemDisplayInfo {
  name: string;
  /** A real cropped-from-the-DDS-sheet icon (see itemIcon.ts), or null when this item_code didn't resolve to a known slot catalog, that slot has no icon sheet (ICON_SHEET_BY_SLOT), or the sheet failed to load - callers fall back to SlotIcon's generic silhouette in that case. */
  iconUrl: string | null;
  /** Full definition + which catalog it came from, when item_code resolved to one - undefined otherwise (see findItemDefinitionByCode). Feeds ItemTooltip's level/race/attack/trade rows; those are simply omitted when this is undefined. */
  item?: ItemDefinition;
  modelType?: ModelType;
}

/** What's currently hovered (a bag slot or an equip slot) - just enough to look up display info and render ItemTooltip; re-resolved from itemDisplay/inventory at render time rather than snapshotted here, so the tooltip stays live if the hovered slot's own data changes underneath it. */
interface HoverTarget {
  itemCode: string;
  upgrade: string;
  quantity?: number;
  isLocked?: boolean;
  isRental?: boolean;
  anchorRect: DOMRect;
}

export interface InventoryWindowProps {
  onClose: () => void;
  /** Real, server-authoritative bag + currency state - see OnlineScene's InventoryState doc comment. */
  inventory: InventoryState;
  /** Real fixed-equipment paperdoll state - see OnlineScene's EquipmentDisplay doc comment for why ring/amulet/bullet slots can read empty even when something's actually equipped there. */
  equipment: EquipmentDisplay;
  /** slotIndex, always with quantity 0 (full stack) - see OnlineScene.sellInventoryItem. */
  onSell: (slotIndex: number) => void;
  /** slotIndex, always with quantity 0 (full stack) - see OnlineScene.dropInventoryItem. */
  onDrop: (slotIndex: number) => void;
  /** slotIndex, always with quantity 0 (1, or equip) - see OnlineScene.useInventoryItem. */
  onUse: (slotIndex: number) => void;
}

type EquipIconType = 'helmet' | 'amulet' | 'weapon' | 'upper' | 'shield' | 'lower' | 'gauntlet' | 'shoe' | 'ring' | 'bullet' | 'cloak';

interface EquipSlotDef {
  key: EquipmentSlotKey;
  type: EquipIconType;
  label: string;
  /** All in rem, absolutely positioned within .equip-grid (see EQUIP_SLOT_SIZE's own doc comment) - no grid/flow layout involved. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Ring slots render as circles, not squares - see .equip-slot-round. */
  round?: boolean;
}

/**
 * Fixed rem measurements every EQUIP_SLOTS position is computed from -
 * SLOT is the uniform HEIGHT every slot shares (Helmet included - it's
 * exactly as tall as Upper/Lower/Shoe, not a spanning "hero" slot), and
 * the uniform size for every ordinary slot's width too (Amulets, Weapon,
 * Shield, Upper, Cloak, Rings). HERO is only ever used as a WIDTH, for the
 * 3 wide centered slots (Helmet, Lower, Shoe) - they're twice a normal
 * slot's width plus the gap between them, but stay a single SLOT tall.
 */
const EQUIP_SLOT_SIZE = 3.35;
const EQUIP_GAP = 0.5;
const EQUIP_HERO_SIZE = EQUIP_SLOT_SIZE * 2 + EQUIP_GAP;
const EQUIP_COL2_LEFT = EQUIP_SLOT_SIZE + EQUIP_GAP;
const EQUIP_COL3_LEFT = EQUIP_COL2_LEFT + EQUIP_HERO_SIZE + EQUIP_GAP;
const EQUIP_ROW2_TOP = EQUIP_SLOT_SIZE + EQUIP_GAP;
const EQUIP_ROW3_TOP = EQUIP_ROW2_TOP + EQUIP_SLOT_SIZE + EQUIP_GAP;
const EQUIP_ROW4_TOP = EQUIP_ROW3_TOP + EQUIP_SLOT_SIZE + EQUIP_GAP;
const EQUIP_ROW5_TOP = EQUIP_ROW4_TOP + EQUIP_SLOT_SIZE + EQUIP_GAP;
/** EQUIP_SLOTS' own total footprint, in rem - the .equip-grid container is sized to exactly this (see its own render, not CSS) since its children are all position:absolute and contribute nothing to its natural size otherwise. */
const EQUIP_GRID_SIZE = { width: EQUIP_COL3_LEFT + EQUIP_SLOT_SIZE, height: EQUIP_ROW5_TOP + EQUIP_SLOT_SIZE };

/**
 * The real 14 fixed equipment slots (docs/inventory-action.md's own
 * EquipmentSlots/equipment table) - no "earring"/"off-hand-as-a-generic-
 * slot" here, since this game's EDF item model simply doesn't have those;
 * `shield` and the ring/amulet/bullet pairs are the only accessory-style
 * slots that actually exist. Position matches the real client's own equip
 * window layout: a wide centered Helmet up top flanked by the two
 * Amulets, Weapon/Shield below that, Upper/Cloak flanking a wide centered
 * Lower, then Rings flanking a wide centered Shoe - Helmet, Upper, Lower,
 * and Shoe are all exactly EQUIP_SLOT_SIZE tall (see its own doc comment).
 * Gauntlet and the two Bullet slots aren't part of that reference layout
 * at all (this app still needs to expose them somewhere), so they're a
 * plain extra row of 3 ordinary slots underneath instead, evenly spaced
 * across the same overall width.
 */
const EQUIP_SLOTS: EquipSlotDef[] = [
  { key: 'amulet1', type: 'amulet', label: 'Amulet 1', left: 0, top: 0, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'helmet', type: 'helmet', label: 'Helmet', left: EQUIP_COL2_LEFT, top: 0, width: EQUIP_HERO_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'amulet2', type: 'amulet', label: 'Amulet 2', left: EQUIP_COL3_LEFT, top: 0, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'weapon', type: 'weapon', label: 'Weapon', left: 0, top: EQUIP_ROW2_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'shield', type: 'shield', label: 'Shield', left: EQUIP_COL3_LEFT, top: EQUIP_ROW2_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'upper', type: 'upper', label: 'Upper', left: 0, top: EQUIP_ROW3_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'lower', type: 'lower', label: 'Lower', left: EQUIP_COL2_LEFT, top: EQUIP_ROW3_TOP, width: EQUIP_HERO_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'cloak', type: 'cloak', label: 'Cloak', left: EQUIP_COL3_LEFT, top: EQUIP_ROW3_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'ring1', type: 'ring', label: 'Ring 1', left: 0, top: EQUIP_ROW4_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE, round: true },
  { key: 'shoe', type: 'shoe', label: 'Shoe', left: EQUIP_COL2_LEFT, top: EQUIP_ROW4_TOP, width: EQUIP_HERO_SIZE, height: EQUIP_SLOT_SIZE },
  { key: 'ring2', type: 'ring', label: 'Ring 2', left: EQUIP_COL3_LEFT, top: EQUIP_ROW4_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE, round: true },
  { key: 'gauntlet', type: 'gauntlet', label: 'Gauntlet', left: 0, top: EQUIP_ROW5_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
  {
    key: 'bullet1',
    type: 'bullet',
    label: 'Bullet 1',
    left: EQUIP_COL2_LEFT + (EQUIP_HERO_SIZE - EQUIP_SLOT_SIZE) / 2,
    top: EQUIP_ROW5_TOP,
    width: EQUIP_SLOT_SIZE,
    height: EQUIP_SLOT_SIZE,
  },
  { key: 'bullet2', type: 'bullet', label: 'Bullet 2', left: EQUIP_COL3_LEFT, top: EQUIP_ROW5_TOP, width: EQUIP_SLOT_SIZE, height: EQUIP_SLOT_SIZE },
];

const BAG_COUNT = 5;
/** 5 columns x 4 rows, 5 bags - exactly covers InventorySlot's 100 real slots (docs/inventory.md). */
const BAG_SLOT_COUNT = 20;

/** Fallback for a slot with no real icon (itemDisplay.iconUrl is null - unresolved item_code, or a slot with no icon sheet at all like shield/ring/amulet/bullet) - a generic geometric silhouette, matching design.md §5.2's "subtle wireframe silhouette" spec for an unknown/empty slot. */
function SlotIcon({ type }: { type: EquipIconType }) {
  const shapes: Record<EquipIconType, ReactNode> = {
    helmet: (
      <>
        <path d="M5 15a7 7 0 0 1 14 0" />
        <path d="M4 15h16" />
        <path d="M8 15v3M16 15v3" />
      </>
    ),
    amulet: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M12 11.5 9 18h6Z" />
      </>
    ),
    weapon: (
      <>
        <path d="M5 19 19 5" />
        <path d="M15 5h4v4" />
        <path d="m5 19-1.5 1.5M9 15l3 3" />
      </>
    ),
    upper: <path d="M9 3 6 6v5l3-1v11h6V10l3 1V6l-3-3-2 2-2-2Z" />,
    shield: <path d="M12 2 20 5v6c0 6-3.5 9.5-8 11-4.5-1.5-8-5-8-11V5Z" />,
    lower: <path d="M7 3h10l1 18h-4l-1.5-11L11 21H7Z" />,
    gauntlet: <path d="M8 21v-9a2 2 0 1 1 4 0v3M12 12V7a2 2 0 1 1 4 0v5M16 12a2 2 0 1 1 4 0v5a5 5 0 0 1-5 5h-4a3 3 0 0 1-3-3v-2" />,
    shoe: <path d="M9 2v10l-5 4.5V20h15v-4.5l-7-2.5V2Z" />,
    ring: (
      <>
        <circle cx="12" cy="15" r="5.2" />
        <path d="M9.5 9 12 5l2.5 4" />
      </>
    ),
    bullet: (
      <>
        <path d="M9 21V10a3 3 0 0 1 3-3 3 3 0 0 1 3 3v11Z" />
        <path d="M9 10 12 3l3 7" />
      </>
    ),
    cloak: (
      <>
        <path d="M8 4h8l3 16H5Z" />
        <path d="M8 4a4 4 0 0 1 8 0" />
      </>
    ),
  };
  return (
    <svg className="equip-slot-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {shapes[type]}
    </svg>
  );
}

function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8h10l1 4v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-7Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="inventory-lock-icon" viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Every distinct real (non-empty) item_code currently visible in `inventory`/`equipment`, for the name-lookup effect below. */
function collectItemCodes(inventory: InventoryState, equipment: EquipmentDisplay): Set<string> {
  const codes = new Set<string>();
  for (const slot of inventory.slots) if (slot.itemCode) codes.add(slot.itemCode);
  for (const visual of Object.values(equipment)) if (visual?.itemCode) codes.add(visual.itemCode);
  return codes;
}

/**
 * Real inventory UI - equipment paperdoll + currency row + bag tabs, plus a
 * per-bag item grid with click-to-select Use/Sell/Drop actions, all wired to
 * OnlineScene's real InventoryResponse-backed state (see this file's own
 * props). Only ring/amulet/bullet equip slots can still legitimately render
 * empty despite something being equipped there - see EquipmentDisplay's own
 * doc comment; every other slot here reflects the server's actual state.
 */
export default function InventoryWindow({ onClose, inventory, equipment, onSell, onDrop, onUse }: InventoryWindowProps) {
  const [activeBag, setActiveBag] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  /**
   * Best-effort item_code -> {name, iconUrl} cache (see
   * items.ts's findItemDefinitionByCode's own doc comment on why a bag item
   * from outside the 8 body/weapon/cloak catalogs simply won't resolve one -
   * those fall back to the raw item_code as a label and no icon, never a
   * blank slot).
   */
  const [itemDisplay, setItemDisplay] = useState<Record<string, ItemDisplayInfo>>({});

  useEffect(() => {
    // Depending on itemDisplay itself (rather than a ref mirroring it) is
    // deliberate - a resolution batch's own setItemDisplay re-triggers this
    // effect, but by then every code it just resolved is already in
    // itemDisplay, so the filter below finds nothing new and returns
    // immediately; cheap, and avoids reading/writing a ref during render.
    const codes = [...collectItemCodes(inventory, equipment)].filter((code) => !(code in itemDisplay));
    if (codes.length === 0) return;
    let cancelled = false;
    void Promise.all(
      codes.map(async (code) => {
        const resolved = await findItemDefinitionByCode(code).catch(() => null);
        if (!resolved) return [code, { name: code, iconUrl: null }] as const;
        const iconUrl = await getItemIconUrl(resolved.modelType, resolved.item.icon).catch(() => null);
        return [code, { name: resolved.item.name, iconUrl, item: resolved.item, modelType: resolved.modelType }] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setItemDisplay((prev) => {
        const next = { ...prev };
        for (const [code, info] of results) next[code] = info;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [inventory, equipment, itemDisplay]);

  const bagStart = activeBag * BAG_SLOT_COUNT;
  const bagSlots = Array.from({ length: BAG_SLOT_COUNT }, (_, i) => inventory.slots[bagStart + i]);
  const occupiedInBag = bagSlots.filter((slot) => slot?.itemCode).length;
  const selected = selectedSlot !== null ? inventory.slots[selectedSlot] : undefined;
  const displayFor = (itemCode: string): ItemDisplayInfo => itemDisplay[itemCode] ?? { name: itemCode, iconUrl: null };

  const handleSelectBag = (bag: number) => {
    setActiveBag(bag);
    setSelectedSlot(null);
  };

  const handleSelectSlot = (slotIndex: number) => {
    setSelectedSlot((current) => (current === slotIndex ? null : slotIndex));
  };

  const handleBagSlotEnter = (event: ReactMouseEvent<HTMLButtonElement>, item: InventorySlot) => {
    setHover({
      itemCode: item.itemCode,
      upgrade: item.upgrade,
      quantity: item.quantity,
      isLocked: item.isLocked,
      isRental: item.isRental,
      anchorRect: event.currentTarget.getBoundingClientRect(),
    });
  };

  const handleEquipSlotEnter = (event: ReactMouseEvent<HTMLDivElement>, itemCode: string, upgrade: string) => {
    setHover({ itemCode, upgrade, anchorRect: event.currentTarget.getBoundingClientRect() });
  };

  const handleHoverLeave = () => setHover(null);

  /** Right-click use/equip - the fast path real RF's own inventory uses; the selected-item action row's Use button (see below) still works too. */
  const handleBagSlotContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, item: InventorySlot) => {
    event.preventDefault();
    if (item.isLocked) return;
    onUse(item.slotIndex);
  };

  return (
    <div className="inventory-window">
      <Card title="Inventory" onClose={onClose} className="inventory-equip-card">
        <div className="equip-grid" style={{ width: `${EQUIP_GRID_SIZE.width}rem`, height: `${EQUIP_GRID_SIZE.height}rem` }}>
          {EQUIP_SLOTS.map((slot) => {
            const visual = equipment[slot.key];
            const display = visual ? displayFor(visual.itemCode) : undefined;
            return (
              <div
                key={slot.key}
                className={`equip-slot${slot.round ? ' equip-slot-round' : ''}${visual ? ' equip-slot-filled' : ''}`}
                style={{ left: `${slot.left}rem`, top: `${slot.top}rem`, width: `${slot.width}rem`, height: `${slot.height}rem` }}
                aria-label={display ? `${slot.label}: ${display.name}` : slot.label}
                onMouseEnter={visual ? (event) => handleEquipSlotEnter(event, visual.itemCode, visual.upgrade) : undefined}
                onMouseLeave={visual ? handleHoverLeave : undefined}
              >
                {display?.iconUrl ? <img className="equip-slot-icon-img" src={display.iconUrl} alt="" /> : <SlotIcon type={slot.type} />}
              </div>
            );
          })}
        </div>

        <div className="inventory-currency-row">
          <span className="inventory-currency-swatch" aria-hidden="true" />
          <div className="inventory-currency-values">
            <span className="inventory-currency-value inventory-currency-cp">
              {inventory.cp}
              <span className="inventory-currency-label">CP</span>
            </span>
            <span className="inventory-currency-value inventory-currency-gold">
              {inventory.gold}
              <span className="inventory-currency-label">Gold</span>
            </span>
          </div>
        </div>

        <div className="inventory-bag-tabs" role="tablist" aria-label="Bags">
          {Array.from({ length: BAG_COUNT }, (_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={activeBag === i}
              aria-label={`Bag ${i + 1}`}
              className={`inventory-bag-tab${activeBag === i ? ' inventory-bag-tab-active' : ''}`}
              onClick={() => handleSelectBag(i)}
            >
              <BagIcon />
            </button>
          ))}
        </div>
      </Card>

      <Card title={`Bag ${activeBag + 1}`} onClose={onClose} className="inventory-bag-card">
        <div className="bag-grid">
          {bagSlots.map((slot, i) => {
            const slotIndex = bagStart + i;
            const item = slot?.itemCode ? slot : undefined;
            const display = item ? displayFor(item.itemCode) : undefined;
            return (
              <button
                key={slotIndex}
                type="button"
                className={`bag-slot${item ? ' bag-slot-occupied' : ''}${selectedSlot === slotIndex ? ' bag-slot-selected' : ''}`}
                disabled={!item}
                aria-label={item && display ? `${display.name}${item.quantity > 1 ? ` x${item.quantity}` : ''}` : `Empty slot ${slotIndex + 1}`}
                onClick={() => handleSelectSlot(slotIndex)}
                onContextMenu={item ? (event) => handleBagSlotContextMenu(event, item) : undefined}
                onMouseEnter={item ? (event) => handleBagSlotEnter(event, item) : undefined}
                onMouseLeave={item ? handleHoverLeave : undefined}
              >
                {item && display && (
                  <>
                    {display.iconUrl ? (
                      <img className="bag-slot-icon" src={display.iconUrl} alt="" />
                    ) : (
                      <span className="bag-slot-name">{display.name}</span>
                    )}
                    {item.quantity > 1 && <span className="bag-slot-qty">{item.quantity}</span>}
                    {item.isLocked && <LockIcon />}
                  </>
                )}
              </button>
            );
          })}
        </div>

        {selected?.itemCode && (
          <div className="inventory-selected">
            <div className="inventory-selected-info">
              <span className="inventory-selected-name">{displayFor(selected.itemCode).name}</span>
              {selected.quantity > 1 && <span className="inventory-selected-qty">x{selected.quantity}</span>}
              {selected.isLocked && (
                <span className="inventory-selected-locked">
                  <LockIcon /> Locked
                </span>
              )}
            </div>
            <div className="inventory-selected-actions">
              <button type="button" disabled={selected.isLocked} onClick={() => onUse(selected.slotIndex)}>
                Use
              </button>
              <button type="button" disabled={selected.isLocked} onClick={() => onSell(selected.slotIndex)}>
                Sell
              </button>
              <button type="button" disabled={selected.isLocked} onClick={() => onDrop(selected.slotIndex)}>
                Drop
              </button>
            </div>
          </div>
        )}

        <div className="inventory-capacity-footer">
          Capacity: <span className="inventory-mono">{occupiedInBag} / {BAG_SLOT_COUNT}</span>
        </div>
      </Card>

      {hover && <ItemTooltip data={buildTooltipData(hover, displayFor)} anchorRect={hover.anchorRect} />}
    </div>
  );
}

function buildTooltipData(hover: HoverTarget, displayFor: (itemCode: string) => ItemDisplayInfo): ItemTooltipData {
  const display = displayFor(hover.itemCode);
  return {
    itemCode: hover.itemCode,
    name: display.name,
    iconUrl: display.iconUrl,
    item: display.item,
    modelType: display.modelType,
    upgrade: hover.upgrade,
    quantity: hover.quantity,
    isLocked: hover.isLocked,
    isRental: hover.isRental,
  };
}
