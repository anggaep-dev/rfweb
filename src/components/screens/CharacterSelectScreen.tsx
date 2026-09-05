import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { RACE_LABELS, RaceGender } from '../../rf/character';
import type { CharacterSummary } from '../../rf/characterProfile';
import { defaultBaseAppearance, MAX_CHARACTERS_PER_ACCOUNT } from '../../rf/characterProfile';
import { createCharacter, deleteCharacter, listCharacters } from '../../net/CharacterClient';
import { CharacterSelectScene } from '../../scenes/CharacterSelectScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './CharacterSelectScreen.css';

export interface CharacterSelectScreenProps {
  sceneManager: SceneManager;
  sessionToken: string;
  onEnterWorld: (characterId: string, race: RaceGender) => void;
}

const RACE_OPTIONS: RaceGender[] = [
  RaceGender.Bell_Male,
  RaceGender.Bell_Female,
  RaceGender.Cora_Male,
  RaceGender.Cora_Female,
  RaceGender.Accretia,
];

function formatLastPlayed(iso: string | undefined): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

/**
 * Real client's character-select screen: up to MAX_CHARACTERS_PER_ACCOUNT
 * slots, each either an existing character (Select / Character Info /
 * Delete) or an empty "Create Character" slot. The 3D stage (see
 * CharacterSelectScene) shows every existing character standing at its own
 * saved base appearance; this component owns the account-level character
 * list and the create/delete network calls around it.
 */
export default function CharacterSelectScreen({ sceneManager, sessionToken, onEnterWorld }: CharacterSelectScreenProps) {
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createSlotIndex, setCreateSlotIndex] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listCharacters(sessionToken)
      .then((list) => {
        if (!cancelled) setCharacters(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load characters');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken, reloadNonce]);

  useEffect(() => {
    if (!characters) return;
    const domElement = sceneManager.renderer.domElement;
    const scene = new CharacterSelectScene(domElement, domElement.clientWidth / domElement.clientHeight, characters, {
      onPick: (characterId) => {
        setSelectedId(characterId);
        setShowInfo(false);
      },
    });
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(scene);
  }, [sceneManager, characters]);

  const selected = characters?.find((c) => c.id === selectedId) ?? null;

  const handleDelete = (characterId: string) => {
    deleteCharacter(sessionToken, characterId)
      .then(() => {
        if (selectedId === characterId) setSelectedId(null);
        setConfirmDeleteId(null);
        setReloadNonce((n) => n + 1);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to delete character'));
  };

  if (loadError) {
    return (
      <div className="character-select-screen">
        <div className="character-select-overlay character-select-overlay-error">
          Failed to load characters: {loadError}
          <button
            onClick={() => {
              setLoadError('');
              setReloadNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!characters) {
    return (
      <div className="character-select-screen">
        <div className="character-select-overlay">Loading characters…</div>
      </div>
    );
  }

  const slots = Array.from({ length: MAX_CHARACTERS_PER_ACCOUNT }, (_, slotIndex) =>
    characters.find((c) => c.slotIndex === slotIndex) ?? null,
  );

  return (
    <div className="character-select-screen">
      <div className="character-select-title">Character Selection</div>

      <div className="character-select-row">
        {slots.map((character, slotIndex) =>
          character ? (
            <div
              key={character.id}
              className={`character-select-card${selectedId === character.id ? ' character-select-card-active' : ''}`}
              onClick={() => setSelectedId(character.id)}
            >
              <div className="character-select-card-portrait" />
              <div className="character-select-card-name">{character.name}</div>
              <div className="character-select-card-meta">
                Lv.{character.level} · {RACE_LABELS[character.race]}
              </div>
              <button
                className="character-select-card-select"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnterWorld(character.id, character.race);
                }}
              >
                Select
              </button>
              <div className="character-select-card-links">
                <button
                  className="character-select-card-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(character.id);
                    setShowInfo(true);
                  }}
                >
                  Info
                </button>
                <button
                  className="character-select-card-link character-select-card-link-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteId(character.id);
                  }}
                >
                  Delete
                </button>
              </div>
              {confirmDeleteId === character.id && (
                <div className="character-select-confirm">
                  <span>Delete {character.name}?</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(character.id);
                    }}
                  >
                    Yes, delete
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div key={`empty-${slotIndex}`} className="character-select-card character-select-card-empty">
              <button className="character-select-card-create" onClick={() => setCreateSlotIndex(slotIndex)}>
                + Create Character
              </button>
            </div>
          ),
        )}
      </div>

      {showInfo && selected && (
        <div className="character-select-info" onClick={() => setShowInfo(false)}>
          <div className="character-select-info-panel" onClick={(e) => e.stopPropagation()}>
            <h2>{selected.name}</h2>
            <dl>
              <dt>Race</dt>
              <dd>{RACE_LABELS[selected.race]}</dd>
              <dt>Level</dt>
              <dd>{selected.level}</dd>
              <dt>Gold</dt>
              <dd>{selected.gold.toLocaleString()}</dd>
              <dt>CP</dt>
              <dd>{selected.cp.toLocaleString()}</dd>
              <dt>EXP</dt>
              <dd>{selected.exp.toLocaleString()}</dd>
              <dt>Guild</dt>
              <dd>{selected.guildName ?? 'None'}</dd>
              <dt>Location</dt>
              <dd>
                {selected.lastLocation.x}, {selected.lastLocation.y}, {selected.lastLocation.z}
              </dd>
              <dt>Created</dt>
              <dd>{new Date(selected.createdAt).toLocaleDateString()}</dd>
              <dt>Last Played</dt>
              <dd>{formatLastPlayed(selected.lastPlayedAt)}</dd>
            </dl>
            <button onClick={() => setShowInfo(false)}>Close</button>
          </div>
        </div>
      )}

      {createSlotIndex !== null && (
        <CreateCharacterDialog
          slotIndex={createSlotIndex}
          onCancel={() => setCreateSlotIndex(null)}
          onCreate={(name, race) => {
            createCharacter(sessionToken, { name, race, baseAppearance: defaultBaseAppearance() })
              .then(() => {
                setCreateSlotIndex(null);
                setReloadNonce((n) => n + 1);
              })
              .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to create character'));
          }}
        />
      )}
    </div>
  );
}

interface CreateCharacterDialogProps {
  slotIndex: number;
  onCreate: (name: string, race: RaceGender) => void;
  onCancel: () => void;
}

function CreateCharacterDialog({ onCreate, onCancel }: CreateCharacterDialogProps) {
  const [name, setName] = useState('');
  const [race, setRace] = useState<RaceGender>(RaceGender.Bell_Male);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim(), race);
  };

  return (
    <div className="character-select-info" onClick={onCancel}>
      <form className="character-select-info-panel" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2>Create Character</h2>
        <label className="character-select-create-label">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="character-select-create-label">
          Race
          <select value={race} onChange={(e) => setRace(Number(e.target.value) as RaceGender)}>
            {RACE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {RACE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <div className="character-select-create-actions">
          <button type="submit">Create</button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
