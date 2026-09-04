import { memo } from 'react';
import { ALL_EQUIP_SLOTS, SLOT_LABELS } from '../../rf/items';
import type { ItemDefinition, ModelType } from '../../rf/items';
import SearchableSelect from './SearchableSelect';
import './DebugPanel.css';

export interface EquipPanelProps {
  equippedItemId: Partial<Record<ModelType, string>>;
  slotItems: Partial<Record<ModelType, ItemDefinition[]>>;
  onEquipChange: (modelType: ModelType, itemId: string) => void;
  onClose: () => void;
}

// Some slots carry thousands of items (gauntlet alone has ~2,500 eligible
// per race) - each row is a SearchableSelect (type-to-filter) rather than a
// plain <select>, since a native dropdown has no in-place search and is
// unusable at that size. memo() keeps this expensive tree from being torn
// down and rebuilt on every unrelated re-render of DebugPanel (e.g. the
// FPS/memory readout updating twice a second) - only an actual change to
// this panel's own props should redo it.
const EquipPanel = memo(function EquipPanel({ equippedItemId, slotItems, onEquipChange, onClose }: EquipPanelProps) {
  return (
    <div className="debug-panel-equip-panel">
      <div className="debug-panel-panel-header">
        <span>Equip</span>
        <button type="button" className="debug-panel-panel-close" onClick={onClose} aria-label="Close equip panel">
          ×
        </button>
      </div>

      {ALL_EQUIP_SLOTS.map((modelType) => (
        <label key={modelType} className="debug-panel-equip-row">
          <span>{SLOT_LABELS[modelType]}</span>
          <SearchableSelect
            value={equippedItemId[modelType] ?? ''}
            options={slotItems[modelType]}
            onChange={(itemId) => onEquipChange(modelType, itemId)}
          />
        </label>
      ))}
    </div>
  );
});

export default EquipPanel;
