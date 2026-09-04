import { useEffect, useState } from 'react';
import type { RaceGender } from '../../rf/character';
import { CharacterSelectScene } from '../../scenes/CharacterSelectScene';
import type { SceneManager } from '../../scenes/SceneManager';
import './CharacterSelectScreen.css';

export interface CharacterSelectScreenProps {
  sceneManager: SceneManager;
  onEnterWorld: (race: RaceGender) => void;
}

export default function CharacterSelectScreen({ sceneManager, onEnterWorld }: CharacterSelectScreenProps) {
  const [picked, setPicked] = useState<{ race: RaceGender; label: string } | null>(null);

  useEffect(() => {
    const domElement = sceneManager.renderer.domElement;
    const scene = new CharacterSelectScene(domElement, domElement.clientWidth / domElement.clientHeight, {
      onPick: (race, label) => setPicked({ race, label }),
    });
    // Disposal is SceneManager's job once this scene is superseded (by
    // whichever screen's mount effect calls setScene() next) or on full app
    // unmount - see the equivalent note in RfViewer's mount effect.
    void sceneManager.setScene(scene);
  }, [sceneManager]);

  return (
    <div className="character-select-screen">
      <div className="character-select-hint">Click a character to select it</div>
      <div className="character-select-panel">
        <div className="character-select-name">{picked ? picked.label : 'No character selected'}</div>
        <button disabled={!picked} onClick={() => picked && onEnterWorld(picked.race)}>
          Enter World
        </button>
      </div>
    </div>
  );
}
