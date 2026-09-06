import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { AssetController } from '../controllers/AssetController';
import { CameraController } from '../controllers/CameraController';
import { CharacterController } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
import type { RaceGender } from '../rf/character';
import type { AppScene } from './AppScene';

export interface CharacterCreateSceneCallbacks {
  onStatusChange?: (status: 'loading' | 'ready' | 'error', errorMessage?: string) => void;
}

/**
 * Character-creation preview stage: one character, idling, orbit-only camera
 * - a stripped-down sibling of ViewerScene with no locomotion, click-to-move,
 * bots, or weapon-edit gizmo, since none of that applies while picking a
 * look. loadRace() swaps race live on the same CharacterController/camera
 * instance (same idiom as ViewerScene.loadRace/RfViewer), so switching race
 * mid-creation doesn't recreate the scene or reset the orbit the player
 * already set up. characterController is exposed directly so the React
 * screen can call setBaseAppearance() per variant pick without a remount,
 * same as RfViewer does for BasePartPanel.
 */
export class CharacterCreateScene implements AppScene {
  readonly sceneController = new SceneController();
  readonly cameraController: CameraController;
  readonly characterController: CharacterController;
  readonly assetController = new AssetController();

  private readonly callbacks: CharacterCreateSceneCallbacks;
  private disposed = false;

  constructor(renderer: WebGLRenderer, private initialRaceGender: RaceGender, callbacks: CharacterCreateSceneCallbacks = {}) {
    this.callbacks = callbacks;

    this.cameraController = new CameraController(
      renderer.domElement,
      renderer.domElement.clientWidth / renderer.domElement.clientHeight,
      this.sceneController.scene,
    );
    this.characterController = new CharacterController(this.sceneController.scene);
  }

  get scene(): Scene {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.cameraController.camera;
  }

  mount(): void {
    // Resolves immediately - the character itself loads in the background
    // (status reported via onStatusChange), same as ViewerScene.mount.
    this.loadRace(this.initialRaceGender);
  }

  /** Loads (or switches to) a race's character. Assets are expected to already be cached (see preloadAllRaces, run once at app startup) so this is normally near-instant. */
  loadRace(race: RaceGender): void {
    this.callbacks.onStatusChange?.('loading');
    this.assetController
      .loadRace(race)
      .then(async (character) => {
        if (this.disposed || !character) return; // null means a newer loadRace() superseded this one

        const bounds = await this.characterController.mount(character, race);
        if (this.disposed) return;
        this.sceneController.frameGround(bounds.box, bounds.radius);
        this.cameraController.frameOnCharacter(bounds);
        this.callbacks.onStatusChange?.('ready');
      })
      .catch((err: unknown) => {
        if (this.disposed) return;
        console.error('Failed to load character:', err);
        this.callbacks.onStatusChange?.('error', err instanceof Error ? err.message : String(err));
      });
  }

  update(delta: number): void {
    this.characterController.update(delta);
    const character = this.characterController.getCharacter();
    this.cameraController.update(delta, {
      hipsBone: this.characterController.getHipsBone(),
      headBone: this.characterController.getHeadBone(),
      characterGroupQuaternion: character ? character.group.quaternion : null,
      characterPosition: character ? character.group.position : null,
      isMoving: false,
    });
  }

  resize(aspect: number): void {
    this.cameraController.setAspect(aspect);
  }

  dispose(): void {
    this.disposed = true;
    this.assetController.cancelPending();
    this.cameraController.dispose();
    this.characterController.dispose();
    this.sceneController.dispose();
  }
}
