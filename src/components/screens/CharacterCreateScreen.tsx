import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '../ui';
import { RACE_LABELS } from '../../rf/character';
import type { RaceGender } from '../../rf/character';
import { BASE_MODEL_TYPES, defaultBaseAppearance } from '../../rf/characterProfile';
import type { BaseAppearance, BaseModelType } from '../../rf/characterProfile';
import { BASE_APPEARANCE_VARIANT_COUNT, baseSlotLabel } from '../../rf/items';
import { createCharacter } from '../../net/CharacterClient';
import { CharacterCreateScene } from '../../scenes/CharacterCreateScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './CharacterCreateScreen.css';

export interface CharacterCreateScreenProps {
  sceneManager: SceneManager;
  sessionToken: string;
  /** Chosen in the previous step (CharacterCreateRaceScreen) - fixed for the rest of creation, same as the real client. */
  race: RaceGender;
  /** Called once the character is successfully created - caller reloads the character list and returns to select. */
  onCreated: () => void;
  /** "Change Race" - returns to the previous step, not all the way to character select. */
  onCancel: () => void;
}

const VARIANT_OPTIONS = Array.from({ length: BASE_APPEARANCE_VARIANT_COUNT }, (_, i) => i);

/**
 * Character creation's second step: a name and 1-of-5 for each base
 * appearance slot (Helmet/hair, Face, Upper, Lower, Gauntlet, Shoes) for the
 * race chosen in CharacterCreateRaceScreen, while watching a live-rotating
 * preview - RF has no continuous sculpting sliders, just these pre-made
 * variants (see items.ts's ALL_MODEL_TYPES doc comment), so that's the
 * entire look-picking surface. Mirrors RfViewer's
 * scene-ref-plus-direct-controller-calls pattern (see CharacterCreateScene)
 * rather than recreating the 3D scene on every variant change.
 */
export default function CharacterCreateScreen({ sceneManager, sessionToken, race, onCreated, onCancel }: CharacterCreateScreenProps) {
  const [name, setName] = useState('');
  const [baseAppearance, setBaseAppearance] = useState<BaseAppearance>(defaultBaseAppearance());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [previewError, setPreviewError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const sceneRef = useRef<CharacterCreateScene | null>(null);
  const baseAppearanceRef = useRef(baseAppearance);

  useEffect(() => {
    baseAppearanceRef.current = baseAppearance;
  }, [baseAppearance]);

  useEffect(() => {
    let disposed = false;

    const scene = new CharacterCreateScene(sceneManager.renderer, race, {
      onStatusChange: (nextStatus, message) => {
        if (disposed) return;
        setStatus(nextStatus);
        setPreviewError(message ?? '');
        if (nextStatus === 'ready') {
          // A fresh mount always starts every slot at variant 0 - reapply
          // whatever's actually selected (relevant if this ever remounts).
          for (const modelType of BASE_MODEL_TYPES) {
            scene.characterController
              .setBaseAppearance(modelType, baseAppearanceRef.current[modelType])
              .catch((err: unknown) => console.error(`Failed to apply base appearance for slot ${modelType}:`, err));
          }
        }
      },
    });
    sceneRef.current = scene;
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(scene);

    return () => {
      disposed = true;
      sceneRef.current = null;
    };
  }, [sceneManager, race]);

  const handleVariantChange = (modelType: BaseModelType, variantIndex: number) => {
    setBaseAppearance((prev) => ({ ...prev, [modelType]: variantIndex }));
    sceneRef.current?.characterController
      .setBaseAppearance(modelType, variantIndex)
      .catch((err: unknown) => console.error(`Failed to set base appearance for slot ${modelType}:`, err));
  };

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    setCreateError('');
    createCharacter(sessionToken, { name: trimmed, race, baseAppearance })
      .then(() => onCreated())
      .catch((err: unknown) => {
        setCreateError(err instanceof Error ? err.message : 'Failed to create character');
        setIsCreating(false);
      });
  };

  return (
    <div className="character-create-screen">
      <Button className="character-create-back" variant="ghost" size="sm" onClick={onCancel}>
        ← Change Race
      </Button>
      <div className="character-create-title">Character Creation · {RACE_LABELS[race]}</div>

      <Card title="APPEARANCE" statusLed className="character-create-sidebar">
        <label className="character-create-name-label">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="Enter a name" />
        </label>

        <div className="character-create-categories">
          {BASE_MODEL_TYPES.map((modelType) => (
            <div key={modelType} className="character-create-category">
              <div className="character-create-section-label">{baseSlotLabel(modelType, race)}</div>
              <div className="character-create-variant-row">
                {VARIANT_OPTIONS.map((variant) => (
                  <Button
                    key={variant}
                    size="sm"
                    variant={baseAppearance[modelType] === variant ? 'primary' : 'secondary'}
                    onClick={() => handleVariantChange(modelType, variant)}
                  >
                    {variant + 1}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {status === 'loading' && <div className="character-create-overlay">Loading preview…</div>}
      {status === 'error' && (
        <div className="character-create-overlay character-create-overlay-error">
          Failed to load preview: {previewError}
        </div>
      )}

      <div className="character-create-footer">
        {createError && <div className="character-create-error">{createError}</div>}
        <Button variant="primary" size="lg" disabled={!name.trim()} loading={isCreating} onClick={handleCreate}>
          Create Character
        </Button>
      </div>
    </div>
  );
}
