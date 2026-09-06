import { useEffect, useState } from 'react';
import { Button } from '../ui';
import type { RaceGender } from '../../rf/character';
import { CharacterCreateRaceScene } from '../../scenes/CharacterCreateRaceScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './CharacterCreateRaceScreen.css';

export interface CharacterCreateRaceScreenProps {
  sceneManager: SceneManager;
  onPickRace: (race: RaceGender) => void;
  onCancel: () => void;
}

/**
 * Character creation's first step: a cinematic showcase of every playable
 * race, each dressed in impressive gear (see CharacterCreateRaceScene),
 * standing on stage to be picked before moving on to the base-appearance
 * editor (CharacterCreateScreen) for whichever one is chosen.
 */
export default function CharacterCreateRaceScreen({ sceneManager, onPickRace, onCancel }: CharacterCreateRaceScreenProps) {
  const [picked, setPicked] = useState<{ race: RaceGender; label: string } | null>(null);

  useEffect(() => {
    const domElement = sceneManager.renderer.domElement;
    const scene = new CharacterCreateRaceScene(domElement, domElement.clientWidth / domElement.clientHeight, {
      onPick: (race, label) => setPicked({ race, label }),
    });
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(scene);
  }, [sceneManager]);

  return (
    <div className="character-create-race-screen">
      <Button className="character-create-race-back" variant="ghost" size="sm" onClick={onCancel}>
        ← Back
      </Button>
      <div className="character-create-race-title">Choose Your Race</div>
      <div className="character-create-race-hint">Click a hero on stage to choose their race</div>

      <div className="character-create-race-panel">
        <div className="character-create-race-name">{picked ? picked.label : 'No race selected'}</div>
        <Button variant="primary" disabled={!picked} onClick={() => picked && onPickRace(picked.race)}>
          Continue
        </Button>
      </div>
    </div>
  );
}
