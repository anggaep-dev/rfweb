export const INVENTORY_SHORTCUT_MIME = 'application/x-rfworld-inventory-shortcut';
export const SHORTCUT_SLOT_MIME = 'application/x-rfworld-shortcut-slot';

export interface InventoryShortcutDragPayload {
  type: 'inventory-item';
  slotIndex: number;
}

export function encodeInventoryShortcutPayload(slotIndex: number): string {
  return JSON.stringify({ type: 'inventory-item', slotIndex } satisfies InventoryShortcutDragPayload);
}

export function decodeInventoryShortcutPayload(raw: string | null): InventoryShortcutDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InventoryShortcutDragPayload>;
    if (parsed.type !== 'inventory-item') return null;
    const { slotIndex } = parsed;
    if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex) || slotIndex < 0) return null;
    return { type: 'inventory-item', slotIndex };
  } catch {
    return null;
  }
}

export interface ShortcutSlotDragPayload {
  type: 'shortcut-slot';
  rowIndex: number;
  colIndex: number;
}

export function encodeShortcutSlotPayload(rowIndex: number, colIndex: number): string {
  return JSON.stringify({ type: 'shortcut-slot', rowIndex, colIndex } satisfies ShortcutSlotDragPayload);
}

export function decodeShortcutSlotPayload(raw: string | null): ShortcutSlotDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ShortcutSlotDragPayload>;
    if (parsed.type !== 'shortcut-slot') return null;
    const { rowIndex, colIndex } = parsed;
    if (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 0) return null;
    if (typeof colIndex !== 'number' || !Number.isInteger(colIndex) || colIndex < 0) return null;
    return { type: 'shortcut-slot', rowIndex, colIndex };
  } catch {
    return null;
  }
}
