import { useState } from 'react';
import type { ReactNode } from 'react';
import { Card } from '../ui';
import './InventoryWindow.css';

export interface InventoryWindowProps {
  onClose: () => void;
}

type EquipSlotType = 'amulet' | 'helmet' | 'earring' | 'weapon' | 'torso' | 'cape' | 'offhand' | 'legs' | 'gloves' | 'boots' | 'ring';

interface EquipSlotDef {
  type: EquipSlotType;
  label: string;
  /** Width in a 12-unit grid column (see .equip-grid) - the reference screenshot's rows aren't uniform: a denser row of 4 smaller accessory slots up top, 3 bigger armor slots per row in the middle, then rings flanking a wider center slot at the bottom. Matching that row-length/size pattern (not just a plain uniform NxM grid) is the actual "paperdoll" look. */
  span: 3 | 4 | 6;
  /** Ring slots render as circles, not squares - see .equip-slot-round. */
  round?: boolean;
}

/** design.md §5.2's own list (Headgear/Torso/Greaves/Boots/Main-hand/Off-hand/Cape/Rings/Amulets) plus Earring/Gloves to round the set out. No real equip data behind any of this yet - see this component's own doc comment. */
const EQUIP_SLOTS: EquipSlotDef[] = [
  // Row 1 - 4 smaller accessory slots (4x span-3 = 12).
  { type: 'amulet', label: 'Amulet', span: 3 },
  { type: 'helmet', label: 'Helmet', span: 3 },
  { type: 'earring', label: 'Earring', span: 3 },
  { type: 'earring', label: 'Earring', span: 3 },
  // Row 2 - 3 bigger armor slots (3x span-4 = 12).
  { type: 'weapon', label: 'Weapon', span: 4 },
  { type: 'torso', label: 'Torso', span: 4 },
  { type: 'cape', label: 'Cape', span: 4 },
  // Row 3 - same 3-wide layout as row 2.
  { type: 'legs', label: 'Legs', span: 4 },
  { type: 'gloves', label: 'Gloves', span: 4 },
  { type: 'boots', label: 'Boots', span: 4 },
  // Row 4 - round ring slots flanking a wider center slot (3 + 6 + 3 = 12).
  { type: 'ring', label: 'Ring (Left)', span: 3, round: true },
  { type: 'offhand', label: 'Off-Hand', span: 6 },
  { type: 'ring', label: 'Ring (Right)', span: 3, round: true },
];

const BAG_COUNT = 5;
/** 5 columns x 4 rows - design.md §5.3's own "4x5 or 4x6" spec. */
const BAG_SLOT_COUNT = 20;

/** Minimal geometric silhouettes, not detailed art - design.md §5.2 calls an empty slot a "subtle wireframe silhouette... at 25% opacity" anyway, so simple shapes are the actual spec, not a placeholder shortcut. */
function SlotIcon({ type }: { type: EquipSlotType }) {
  const shapes: Record<EquipSlotType, ReactNode> = {
    amulet: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M12 11.5 9 18h6Z" />
      </>
    ),
    helmet: (
      <>
        <path d="M5 15a7 7 0 0 1 14 0" />
        <path d="M4 15h16" />
        <path d="M8 15v3M16 15v3" />
      </>
    ),
    earring: (
      <>
        <circle cx="12" cy="7" r="2" />
        <path d="M12 9v6a2.2 2.2 0 1 1-2.2 2.2" />
      </>
    ),
    weapon: (
      <>
        <path d="M5 19 19 5" />
        <path d="M15 5h4v4" />
        <path d="m5 19-1.5 1.5M9 15l3 3" />
      </>
    ),
    torso: <path d="M9 3 6 6v5l3-1v11h6V10l3 1V6l-3-3-2 2-2-2Z" />,
    cape: (
      <>
        <path d="M8 4h8l3 16H5Z" />
        <path d="M8 4a4 4 0 0 1 8 0" />
      </>
    ),
    offhand: <path d="M12 2 20 5v6c0 6-3.5 9.5-8 11-4.5-1.5-8-5-8-11V5Z" />,
    legs: <path d="M7 3h10l1 18h-4l-1.5-11L11 21H7Z" />,
    gloves: <path d="M8 21v-9a2 2 0 1 1 4 0v3M12 12V7a2 2 0 1 1 4 0v5M16 12a2 2 0 1 1 4 0v5a5 5 0 0 1-5 5h-4a3 3 0 0 1-3-3v-2" />,
    boots: <path d="M9 2v10l-5 4.5V20h15v-4.5l-7-2.5V2Z" />,
    ring: (
      <>
        <circle cx="12" cy="15" r="5.2" />
        <path d="M9.5 9 12 5l2.5 4" />
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

/**
 * Inventory UI shell, matching the real client's layout (equipment paperdoll
 * + currency row + bag tabs, plus a separate per-bag item grid below) -
 * design.md §5.2/§5.3 already spec exactly this ("Equipment Matrix" /
 * "Inventory Bag Matrix"), so this is mostly that spec made concrete rather
 * than a fresh design. No real equip/item/currency data exists yet (there's
 * no inventory system wired up online), so every slot renders empty and
 * currency reads 0 - same "shell now, wire later" precedent as
 * MobileControls' inert Attack/Skill buttons. Bag-tab selection IS real
 * local state (which tab looks active, which bag's grid/title shows) since
 * that's pure presentation, not something that needs backend item data.
 */
export default function InventoryWindow({ onClose }: InventoryWindowProps) {
  const [activeBag, setActiveBag] = useState(0);

  return (
    <div className="inventory-window">
      <Card title="Inventory" onClose={onClose} className="inventory-equip-card">
        <div className="equip-grid">
          {EQUIP_SLOTS.map((slot, i) => (
            <div
              key={i}
              className={`equip-slot${slot.round ? ' equip-slot-round' : ''}`}
              style={{ gridColumn: `span ${slot.span}` }}
              title={slot.label}
              aria-label={slot.label}
            >
              <SlotIcon type={slot.type} />
            </div>
          ))}
        </div>

        <div className="inventory-currency-row">
          <span className="inventory-currency-swatch" aria-hidden="true" />
          <span className="inventory-currency-value inventory-currency-cp">
            0<span className="inventory-currency-label">CP</span>
          </span>
          <span className="inventory-currency-value inventory-currency-gold">
            0<span className="inventory-currency-label">Gold</span>
          </span>
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
              onClick={() => setActiveBag(i)}
            >
              <BagIcon />
            </button>
          ))}
        </div>
      </Card>

      <Card title={`Bag ${activeBag + 1}`} onClose={onClose} className="inventory-bag-card">
        <div className="bag-grid">
          {Array.from({ length: BAG_SLOT_COUNT }, (_, i) => (
            <div key={i} className="bag-slot" />
          ))}
        </div>
        <div className="inventory-capacity-footer">
          Capacity: <span className="inventory-mono">0 / {BAG_SLOT_COUNT}</span>
        </div>
      </Card>
    </div>
  );
}
