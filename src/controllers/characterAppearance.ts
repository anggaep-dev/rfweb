import { Scene } from 'three';
import { CharacterController } from './CharacterController';
import { loadCharacter } from '../rf/character';
import type { RaceGender } from '../rf/character';
import { BASE_MODEL_TYPES } from '../rf/characterProfile';
import type { BaseAppearance, EquippedItems } from '../rf/characterProfile';
import { ALL_EQUIP_SLOTS, loadSlotItems, ModelType } from '../rf/items';
import type { VisibleEquipment } from '../net/generated/protocol';

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

/**
 * Warms every cache applyCharacterAppearance's underlying loaders populate
 * (mesh/texture fetch+parse+decode for each equipped item and base-appearance
 * variant - see character.ts's various pooled *Cache maps and items.ts's
 * loadSlotItems) for a character's real saved appearance, without ever
 * touching a visible scene.
 *
 * CharacterSelectScene's own on-stage preview deliberately shows base
 * appearance only, matching the real client (see CharacterSummary's own doc
 * comment) - it's not this function's job to change that. Instead this
 * mounts a throwaway CharacterController against a Scene that's never
 * rendered (never even added to SceneManager - just a plain `new Scene()`
 * this function creates and discards), applies the real fetched appearance
 * to force every underlying fetch/parse/decode to actually happen, then
 * disposes it - only the shared, module-level caches survive
 * (CharacterController.dispose's disposeObject3D already skips disposing
 * pooled/shared resources, e.g. weapon/cloak textures, so this doesn't undo
 * its own warm-up). By the time the player actually clicks "Select" and
 * OnlineScene mounts the same character for real, applyCharacterAppearance
 * there just replays cache hits instead of fresh network+parse+decode work.
 *
 * Best-effort: errors are logged and swallowed rather than thrown, since
 * this is a pure background warm-up, not a requirement for anything to work
 * (a cold cache just means OnlineScene's own later equip pays the normal,
 * previously-only cost).
 */
export async function preloadCharacterEquip(race: RaceGender, appearance: AppearanceLike): Promise<void> {
  const controller = new CharacterController(new Scene());
  try {
    const character = await loadCharacter(race);
    await controller.mount(character, race);
    await applyCharacterAppearance(controller, appearance, () => false);
  } catch (err) {
    console.error('Failed to preload character equip assets:', err);
  } finally {
    controller.dispose();
  }
}

/**
 * VisibleEquipment (protocol.proto) field -> ModelType this client actually
 * renders in the 3D scene. `shield` has no equivalent here (ModelType has no
 * shield/off-hand slot - there's no 3D shield mesh support at all yet, only
 * InventoryWindow's real-but-cosmetic-only shield equip slot, backed by
 * EquipmentDisplay instead of ModelType), so it's silently dropped rather
 * than guessed at.
 */
const VISIBLE_EQUIPMENT_SLOTS: Partial<Record<keyof VisibleEquipment, ModelType>> = {
  helmet: ModelType.Helmet,
  upper: ModelType.Upper,
  lower: ModelType.Lower,
  gauntlet: ModelType.Gauntlet,
  shoe: ModelType.Shoes,
  weapon: ModelType.Weapon,
  cloak: ModelType.Cloak,
};

/** Converts a wire VisibleEquipment (EntitySnapshot/EntityAppearanceUpdate) into this client's own EquippedItems shape - see VISIBLE_EQUIPMENT_SLOTS. An absent/empty item_code for a slot means that slot shows its base appearance, so it's simply left out of the returned map (same "absent = unequipped" convention EquippedItems already uses). */
export function visibleEquipmentToEquipped(visibleEquipment: VisibleEquipment | undefined): EquippedItems {
  const equipped: EquippedItems = {};
  if (!visibleEquipment) return equipped;
  for (const [slot, modelType] of Object.entries(VISIBLE_EQUIPMENT_SLOTS) as [keyof VisibleEquipment, ModelType][]) {
    const itemCode = visibleEquipment[slot]?.itemCode;
    if (itemCode) equipped[modelType] = itemCode;
  }
  return equipped;
}

/**
 * Applies only the slots that actually changed between `previous` and `next`
 * (both full EquippedItems snapshots, e.g. from successive
 * EntityAppearanceUpdate.visible_equipment payloads) - unlike
 * applyCharacterAppearance's initial-mount loop, this must also UNEQUIP a
 * slot that dropped out of `next` (equipItem(modelType, null)), since a live
 * gear change can remove an item, not just add one.
 */
export async function applyEquipmentDiff(
  controller: CharacterController,
  previous: EquippedItems,
  next: EquippedItems,
  isCancelled: () => boolean,
): Promise<void> {
  for (const modelType of ALL_EQUIP_SLOTS) {
    const itemId = next[modelType];
    if (itemId === previous[modelType]) continue;
    try {
      if (itemId) {
        const items = await loadSlotItems(modelType);
        if (isCancelled()) return;
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          console.warn(`Equipped item "${itemId}" not found in slot ${modelType}'s item table`);
          continue;
        }
        await controller.equipItem(modelType, item);
      } else {
        await controller.equipItem(modelType, null);
      }
    } catch (err) {
      console.error(`Failed to update equipped item for slot ${modelType}:`, err);
    }
    if (isCancelled()) return;
  }
}
