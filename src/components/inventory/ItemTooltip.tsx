import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { effectRowLabel, formatEffectValue, itemGradeColor, itemGradeLabel, itemRaceLabel } from '../../rf/items';
import type { ItemDefinition, ModelType } from '../../rf/items';
import { talicSlots } from '../../rf/itemUpgrade';
import './ItemTooltip.css';

export interface ItemTooltipData {
  itemCode: string;
  name: string;
  iconUrl: string | null;
  /** Full definition, when item_code resolved to a known catalog (see findItemDefinitionByCode) - undefined for anything outside the 8 body/weapon/cloak slot catalogs (potions, rings, bullets, ...), in which case every item-derived row below is simply omitted rather than shown with guessed/wrong values. */
  item?: ItemDefinition;
  modelType?: ModelType;
  /** InventorySlot.upgrade (docs/inventory.md) - "" for an equip-slot item, which EquipmentDisplay doesn't carry a real upgrade string for yet. */
  upgrade: string;
  /** Bag context only - equip-slot items are always exactly one, so this is omitted there rather than shown as "x1". */
  quantity?: number;
  isLocked?: boolean;
  isRental?: boolean;
}

export interface ItemTooltipProps {
  data: ItemTooltipData;
  /** The hovered slot's own bounding rect, viewport-relative - anchors the tooltip beside it, flipping to the other side rather than running off-screen. */
  anchorRect: DOMRect;
}

const TOOLTIP_WIDTH = 240;
const VIEWPORT_MARGIN = 8;
/** Rough ceiling on the tooltip's own rendered height, purely to keep the top-edge clamp below from letting it run off the bottom of the viewport - doesn't need to be exact, just not smaller than the real thing ever gets. */
const ESTIMATED_MAX_HEIGHT = 340;

function TooltipRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="item-tooltip-row">
      <span className="item-tooltip-row-label">{label}</span>
      <span className="item-tooltip-row-value">{value}</span>
    </div>
  );
}

export default function ItemTooltip({ data, anchorRect }: ItemTooltipProps) {
  const { item } = data;
  const grade = itemGradeLabel(item?.grade);
  // Undefined only for an item with no grade data at all (never resolved to
  // a catalog) - falls back to the tooltip's own default border/text color
  // (--elevation-panel-border / --text-primary) rather than a hardcoded
  // white, so an unresolved item_code doesn't look like a real grade-0 item.
  const gradeColor = item ? itemGradeColor(item.grade) : undefined;
  const slots = talicSlots(data.upgrade);
  // Whether the rows section has anything to show at all - an unresolved
  // item_code (item undefined) with quantity 1 and no locked/rental status
  // otherwise renders an empty bordered strip with nothing in it.
  const hasRows = Boolean(item) || (data.quantity ?? 0) > 1 || data.isLocked || data.isRental;

  const overflowsRight = anchorRect.right + VIEWPORT_MARGIN + TOOLTIP_WIDTH > window.innerWidth;
  const left = overflowsRight ? anchorRect.left - VIEWPORT_MARGIN - TOOLTIP_WIDTH : anchorRect.right + VIEWPORT_MARGIN;
  const top = Math.min(anchorRect.top, Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - ESTIMATED_MAX_HEIGHT));

  // Portaled straight to document.body rather than rendered in place -
  // InventoryWindow's own outer wrapper has `transform: translate(...)`
  // (its centering trick), and a transformed ancestor becomes the
  // containing block for a `position: fixed` descendant per the CSS spec
  // (Card's `overflow: hidden` would clip it too) - so without the portal
  // this tooltip was never actually viewport-fixed at all, just fixed
  // relative to the inventory window, and could get clipped by it.
  return createPortal(
    <div className="item-tooltip" style={{ left, top, width: TOOLTIP_WIDTH, borderColor: gradeColor }} role="tooltip">
      <div className="item-tooltip-header">
        {data.iconUrl && <img className="item-tooltip-icon" src={data.iconUrl} alt="" />}
        <div className="item-tooltip-title">
          <span className="item-tooltip-name" style={{ color: gradeColor }}>
            {data.name}
          </span>
          {grade && <span className="item-tooltip-grade">{grade}</span>}
        </div>
      </div>

      {hasRows && (
        <div className="item-tooltip-rows">
          {item && <TooltipRow label="Level" value={item.levelLim} />}
          {item && data.modelType !== undefined && <TooltipRow label="Race" value={itemRaceLabel(item.civil, data.modelType)} />}
          {item?.attackMin !== undefined && <TooltipRow label="Attack" value={`${item.attackMin} - ${item.attackMax}`} />}
          {item?.forceAttackMin !== undefined && <TooltipRow label="Force Attack" value={`${item.forceAttackMin} - ${item.forceAttackMax}`} />}
          {item && <TooltipRow label="Trade" value={item.tradeable ? 'Possible' : 'Not possible'} />}
          {item?.effects.map((effect, i) => (
            <TooltipRow key={i} label={effectRowLabel(effect)} value={formatEffectValue(effect.unit)} />
          ))}
          {data.quantity !== undefined && data.quantity > 1 && <TooltipRow label="Quantity" value={data.quantity} />}
          {data.isLocked && <TooltipRow label="Status" value="Locked" />}
          {data.isRental && <TooltipRow label="Status" value="Rental" />}
        </div>
      )}

      <div className="item-tooltip-upgrade" aria-label={`Upgrade: ${slots.filter((s) => s !== 'f').length} of ${slots.length}`}>
        {slots.map((nibble, i) => (
          <span key={i} className={`item-tooltip-upgrade-dot${nibble !== 'f' ? ' item-tooltip-upgrade-dot-filled' : ''}`} />
        ))}
      </div>

      <div className="item-tooltip-code">{data.itemCode}</div>
    </div>,
    document.body,
  );
}
