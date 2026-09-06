import { useEffect, useState } from 'react';
import { Button, Dialog } from '../ui';
import { RACE_LABELS, RaceGender } from '../../rf/character';
import type { CharacterSummary } from '../../rf/characterProfile';
import { MAX_CHARACTERS_PER_ACCOUNT } from '../../rf/characterProfile';
import { preloadShowcaseAssets } from '../../rf/characterShowcase';
import { deleteCharacter, listCharacters } from '../../net/CharacterClient';
import { CharacterSelectScene } from '../../scenes/CharacterSelectScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './CharacterSelectScreen.css';

export interface CharacterSelectScreenProps {
  sceneManager: SceneManager;
  sessionToken: string;
  onEnterWorld: (characterId: string, race: RaceGender) => void;
  /** Empty-slot "+ Create Character" - the actual creation flow is its own full screen (CharacterCreateScreen), owned by SceneApp. */
  onCreateCharacter: () => void;
}

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
export default function CharacterSelectScreen({
  sceneManager,
  sessionToken,
  onEnterWorld,
  onCreateCharacter,
}: CharacterSelectScreenProps) {
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CharacterSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
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

  const handleDelete = () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    deleteCharacter(sessionToken, deleteTarget.id)
      .then(() => {
        if (selectedId === deleteTarget.id) setSelectedId(null);
        setDeleteTarget(null);
        setIsDeleting(false);
        setReloadNonce((n) => n + 1);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to delete character');
        setIsDeleting(false);
      });
  };

  if (loadError) {
    return (
      <div className="character-select-screen">
        <div className="character-select-overlay character-select-overlay-error">
          Failed to load characters: {loadError}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLoadError('');
              setReloadNonce((n) => n + 1);
            }}
          >
            Retry
          </Button>
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
              <Button
                className="character-select-card-select"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnterWorld(character.id, character.race);
                }}
              >
                Select
              </Button>
              <div className="character-select-card-links">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(character.id);
                    setShowInfo(true);
                  }}
                >
                  Info
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(character);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <div key={`empty-${slotIndex}`} className="character-select-card character-select-card-empty">
              <Button
                variant="ghost"
                onClick={() => {
                  // Head start on the race-showcase screen's mesh fetches -
                  // see rf/characterShowcase.ts's preloadShowcaseAssets doc
                  // comment - fired here so the network has the whole
                  // screen-transition + all-5-characters-mount time to work
                  // before that screen's own equip calls need the data.
                  preloadShowcaseAssets();
                  onCreateCharacter();
                }}
              >
                + Create Character
              </Button>
            </div>
          ),
        )}
      </div>

      <Dialog open={showInfo && !!selected} title={selected?.name.toUpperCase() ?? ''} onClose={() => setShowInfo(false)}>
        {selected && (
          <dl className="character-select-info-list">
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
        )}
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        title="DELETE CHARACTER"
        onClose={() => setDeleteTarget(null)}
        closeOnBackdrop={!isDeleting}
        closeOnEscape={!isDeleting}
        actions={[
          { label: 'Cancel', onClick: () => setDeleteTarget(null), variant: 'secondary', disabled: isDeleting },
          { label: 'Delete', onClick: handleDelete, variant: 'danger', loading: isDeleting },
        ]}
      >
        <p>
          Delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.
        </p>
      </Dialog>

    </div>
  );
}
