import { memo } from 'react';
import { ALL_EQUIP_SLOTS, SLOT_LABELS } from './rf/items';
import type { ItemDefinition, ModelType } from './rf/items';
import './DebugPanel.css';

export interface EquipPanelProps {
  equippedItemId: Partial<Record<ModelType, string>>;
  slotItems: Partial<Record<ModelType, ItemDefinition[]>>;
  onEquipChange: (modelType: ModelType, itemId: string) => void;
  onClose: () => void;
}

// Some slots carry thousands of items (gauntlet alone has ~2,500 eligible
// per race), so this renders thousands of <option> elements. memo() keeps
// that expensive tree from being torn down and rebuilt on every unrelated
// re-render of DebugPanel (e.g. the FPS/memory readout updating twice a
// second) - only an actual change to this panel's own props should redo it.
const EquipPanel = memo(function EquipPanel({ equippedItemId, slotItems, onEquipChange, onClose }: EquipPanelProps) {
  return (
    <div className="debug-panel-equip-panel">
      <div className="debug-panel-panel-header">
        <span>Equip</span>
        <button type="button" className="debug-panel-panel-close" onClick={onClose} aria-label="Close equip panel">
          ×
        </button>
      </div>

      {ALL_EQUIP_SLOTS.map((modelType) => {
        const items = slotItems[modelType];
        return (
          <label key={modelType} className="debug-panel-equip-row">
            <span>{SLOT_LABELS[modelType]}</span>
            <select
              value={equippedItemId[modelType] ?? ''}
              disabled={!items}
              onChange={(e) => onEquipChange(modelType, e.target.value)}
            >
              <option value="">{items ? 'None' : 'Loading…'}</option>
              {items?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
});

export default EquipPanel;
