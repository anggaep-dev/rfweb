import { PerspectiveCamera } from 'three';
import type { Scene } from 'three';
import { CharacterController } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
import { RaceGender, loadCharacter } from '../rf/character';
import type { AppScene } from './AppScene';

/** Slow idle turntable rotation, radians/sec. */
const ROTATE_SPEED = 0.25;

const DECORATIVE_RACES: RaceGender[] = [
  RaceGender.Bell_Male,
  RaceGender.Bell_Female,
  RaceGender.Cora_Male,
  RaceGender.Cora_Female,
  RaceGender.Accretia,
];

/**
 * The title/login screen: a single, randomly picked character slowly
 * turntable-rotating on a lit stage behind the (React-rendered) login form.
 * Real geometry, not a static image, so it stays visually consistent with
 * the rest of the app - but there's no gameplay here, so it deliberately
 * skips CameraController (no orbit/first-person/debug modes needed) and
 * BotController.
 */
export class LoginScene implements AppScene {
  private readonly sceneController = new SceneController();
  private readonly camera: PerspectiveCamera;
  private readonly characterController: CharacterController;
  private disposed = false;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(45, aspect, 0.01, 1000);
    this.characterController = new CharacterController(this.sceneController.scene);
  }

  get scene(): Scene {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.camera;
  }

  async mount(): Promise<void> {
    const race = DECORATIVE_RACES[Math.floor(Math.random() * DECORATIVE_RACES.length)];
    const character = await loadCharacter(race);
    if (this.disposed) return;
    const bounds = await this.characterController.mount(character, race);
    if (this.disposed) return;

    this.sceneController.frameGround(bounds.box, bounds.radius);
    this.camera.position.set(
      bounds.center.x,
      bounds.center.y + bounds.radius * 0.4,
      bounds.center.z + bounds.radius * 2.2,
    );
    this.camera.near = bounds.radius / 100;
    this.camera.far = bounds.radius * 100;
    this.camera.lookAt(bounds.center.x, bounds.center.y + bounds.radius * 0.2, bounds.center.z);
    this.camera.updateProjectionMatrix();
  }

  update(delta: number): void {
    this.characterController.update(delta);
    const group = this.characterController.group;
    if (group) group.rotation.y += delta * ROTATE_SPEED;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.characterController.dispose();
    this.sceneController.dispose();
  }
}
