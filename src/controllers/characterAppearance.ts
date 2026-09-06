import { CharacterController } from './CharacterController';
import { BASE_MODEL_TYPES } from '../rf/characterProfile';
import type { BaseAppearance, EquippedItems } from '../rf/characterProfile';
import { loadSlotItems, ModelType } from '../rf/items';

export interface AppearanceLike {
  /** Optional because a Go nil map/unset field marshals to JSON `null`, not `{}` - a character that's never touched either field will genuinely have it missing, not empty. */
  baseAppearance?: BaseAppearance | null;
  equipped?: EquippedItems | null;
}

/**
 * Applies a fetched appearance (base-appearance variants, then whatever real
 * items are actually equipped over them) onto an already-mounted
 * CharacterController - shared by OnlineScene (the local player's own saved
 * CharacterProfile) and RemoteEntityController (another player's public
 * CharacterAppearance), since both need the exact same slot-by-slot
 * apply logic. Doesn't need to know about Helmet/Cloak/Weapon's own
 * special-casing - that's all inside CharacterController.equipItem.
 *
 * Failures per-slot are logged and skipped rather than aborting the rest -
 * one bad/missing item shouldn't leave the character undressed everywhere
 * else. `isCancelled` is checked between awaits so a controller that's been
 * disposed/superseded mid-fetch (the scene unmounted, or this entity left
 * view) stops applying to it instead of resurrecting a dead character.
 */
export async function applyCharacterAppearance(
  controller: CharacterController,
  appearance: AppearanceLike,
  isCancelled: () => boolean,
): Promise<void> {
  for (const modelType of BASE_MODEL_TYPES) {
    try {
      await controller.setBaseAppearance(modelType, appearance.baseAppearance?.[modelType] ?? 0);
    } catch (err) {
      console.error(`Failed to apply base appearance for slot ${modelType}:`, err);
    }
    if (isCancelled()) return;
  }

  for (const [modelTypeKey, itemId] of Object.entries(appearance.equipped ?? {})) {
    if (!itemId) continue;
    const modelType = Number(modelTypeKey) as ModelType;
    try {
      const items = await loadSlotItems(modelType);
      if (isCancelled()) return;
      const item = items.find((i) => i.id === itemId);
      if (!item) {
        console.warn(`Equipped item "${itemId}" not found in slot ${modelType}'s item table`);
        continue;
      }
      await controller.equipItem(modelType, item);
    } catch (err) {
      console.error(`Failed to equip item "${itemId}" for slot ${modelType}:`, err);
    }
    if (isCancelled()) return;
  }
}
