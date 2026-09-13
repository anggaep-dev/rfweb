/**
 * RF's per-instance "upgrade" string (InventorySlot.upgrade, docs/
 * inventory.md) - an 8-hex-character code: the leading character is some
 * other per-item value (unconfirmed meaning here, not decoded), followed by
 * exactly 7 talic-slot nibbles ('f' = empty, any other nibble = a specific
 * talic inserted - see TALIC_NAMES). A "+N upgrade level" (the filled-vs-
 * empty dot/feather row the real client's item tooltip shows) is just how
 * many of those 7 aren't 'f'.
 */
export const TALIC_SLOT_COUNT = 7;

/** docs/inventory.md's own talic nibble map, keyed lowercase. */
export const TALIC_NAMES: Record<string, string> = {
  f: 'None',
  '0': 'Keen',
  '1': 'Destruction',
  '2': 'Darkness',
  '3': 'Chaos',
  '4': 'Hatred',
  '5': 'Favor',
  '6': 'Wisdom',
  '7': 'SacredFire',
  '8': 'Belief',
  '9': 'Guard',
  a: 'Glory',
  b: 'Grace',
  c: 'Mercy',
  d: 'Resto',
};

/** The 7 talic-slot nibbles, most-significant first, lowercased - a missing/short/malformed upgrade string just reads as "all empty" (padded with 'f') rather than throwing, since a blank/default InventorySlot.upgrade ("") is a normal, common case. */
export function talicSlots(upgrade: string): string[] {
  return upgrade.slice(-TALIC_SLOT_COUNT).toLowerCase().padStart(TALIC_SLOT_COUNT, 'f').split('');
}

/** How many of the 7 talic slots actually have something inserted - the real client's "+N" upgrade level. */
export function upgradeLevel(upgrade: string): number {
  return talicSlots(upgrade).filter((nibble) => nibble !== 'f').length;
}
