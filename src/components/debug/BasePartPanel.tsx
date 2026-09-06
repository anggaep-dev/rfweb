import { memo } from 'react';
import { ALL_MODEL_TYPES, BASE_APPEARANCE_VARIANT_COUNT, baseSlotLabel, ModelType } from '../../rf/items';
import type { RaceGender } from '../../rf/character';
import './DebugPanel.css';

export interface BasePartPanelProps {
  raceGender: RaceGender;
  /** Current variant (0-4) per base slot - see CharacterController.setBaseAppearance. */
  variantBySlot: Partial<Record<ModelType, number>>;
  onVariantChange: (modelType: ModelType, variantIndex: number) => void;
  onClose: () => void;
}

const VARIANT_OPTIONS = Array.from({ length: BASE_APPEARANCE_VARIANT_COUNT }, (_, i) => i);

/**
 * Character-creation-time appearance: which of the 5 pre-made variants
 * each base slot (Helmet/Face/Upper/Lower/Gauntlet/Shoes) uses when nothing
 * real is equipped there - a separate panel from EquipPanel (%eq) since
 * these aren't items, just a fixed 1-of-5 choice per slot. Toggled via
 * "%base 1"/"%base 0" (see RfViewer's handleCommandSubmit), independent of
 * every other debug panel.
 */
const BasePartPanel = memo(function BasePartPanel({
  raceGender,
  variantBySlot,
  onVariantChange,
  onClose,
}: BasePartPanelProps) {
  return (
    <div className="debug-panel-base-part-panel">
      <div className="debug-panel-panel-header">
        <span>Base Appearance</span>
        <button
          type="button"
          className="debug-panel-panel-close"
          onClick={onClose}
          aria-label="Close base appearance panel"
        >
          ×
        </button>
      </div>

      {ALL_MODEL_TYPES.map((modelType) => (
        <label key={modelType} className="debug-panel-equip-row">
          <span>{baseSlotLabel(modelType, raceGender)}</span>
          <select
            className="debug-panel-base-part-select"
            value={variantBySlot[modelType] ?? 0}
            onChange={(e) => onVariantChange(modelType, Number(e.target.value))}
          >
            {VARIANT_OPTIONS.map((variant) => (
              <option key={variant} value={variant}>
                {variant + 1}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
});

export default BasePartPanel;
