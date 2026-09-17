export const SHORTCUT_ROW_COUNT = 5;
export const SHORTCUT_COL_COUNT = 10;

export type ShortcutEntry = { kind: 'inventory'; slotIndex: number; itemCode: string } | { kind: 'skill'; skillId: string };
export type ShortcutGrid = (ShortcutEntry | null)[][];

export type ShortcutCarry =
  | { source: 'inventory'; slotIndex: number; itemCode: string }
  | { source: 'shortcut'; rowIndex: number; colIndex: number; shortcut: ShortcutEntry };

export interface ShortcutCarryPointer {
  x: number;
  y: number;
}

export function shortcutEntryItemCode(shortcut: ShortcutEntry | null): string | null {
  return shortcut?.kind === 'inventory' ? shortcut.itemCode : null;
}

export function shortcutCarryItemCode(carry: ShortcutCarry | null): string | null {
  if (!carry) return null;
  return carry.source === 'inventory' ? carry.itemCode : shortcutEntryItemCode(carry.shortcut);
}

export function createEmptyShortcutGrid(): ShortcutGrid {
  return Array.from({ length: SHORTCUT_ROW_COUNT }, () => Array.from({ length: SHORTCUT_COL_COUNT }, () => null as ShortcutEntry | null));
}
