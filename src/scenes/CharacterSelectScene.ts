import { PerspectiveCamera, Raycaster, Vector2 } from 'three';
import type { Scene } from 'three';
import { CharacterController } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
import { RaceGender, loadCharacter } from '../rf/character';
import type { AppScene } from './AppScene';

const CLICK_DRAG_TOLERANCE_PX = 12;
/** How far apart each stage slot sits, as a multiple of the tallest character's bounding radius. */
const SLOT_SPACING_RADIUS_FACTOR = 2.6;

export const SELECTABLE_RACES: { race: RaceGender; label: string }[] = [
  { race: RaceGender.Bell_Male, label: 'Bell Male' },
  { race: RaceGender.Bell_Female, label: 'Bell Female' },
  { race: RaceGender.Cora_Male, label: 'Cora Male' },
  { race: RaceGender.Cora_Female, label: 'Cora Female' },
  { race: RaceGender.Accretia, label: 'Accretia' },
];

interface Slot {
  race: RaceGender;
  label: string;
  controller: CharacterController;
}

export interface CharacterSelectCallbacks {
  /** Fired when a stage slot is clicked. Purely informational - the scene doesn't track "which is currently picked" itself, the React overlay does, same as it decides when to actually enter the world. */
  onPick?: (race: RaceGender, label: string) => void;
}

/**
 * The character-select screen: every playable race/gender standing side by
 * side on a stage, idling in place. Clicking one reports it via onPick().
 */
export class CharacterSelectScene implements AppScene {
  private readonly sceneController = new SceneController();
  private readonly camera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly domElement: HTMLElement;
  private readonly callbacks: CharacterSelectCallbacks;

  private slots: Slot[] = [];
  private pointerDownPos: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(domElement: HTMLElement, aspect: number, callbacks: CharacterSelectCallbacks = {}) {
    this.domElement = domElement;
    this.callbacks = callbacks;
    this.camera = new PerspectiveCamera(45, aspect, 0.01, 1000);
  }

  get scene(): Scene {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.camera;
  }

  async mount(): Promise<void> {
    const loaded = await Promise.all(
      SELECTABLE_RACES.map(async ({ race, label }) => ({ race, label, character: await loadCharacter(race) })),
    );
    if (this.disposed) return;

    const mounted = await Promise.all(
      loaded.map(async ({ race, label, character }) => {
        const controller = new CharacterController(this.sceneController.scene);
        const bounds = await controller.mount(character, race);
        return { race, label, controller, bounds };
      }),
    );
    if (this.disposed) {
      for (const m of mounted) m.controller.dispose();
      return;
    }

    const maxRadius = Math.max(1, ...mounted.map((m) => m.bounds.radius));
    const spacing = maxRadius * SLOT_SPACING_RADIUS_FACTOR;
    const startX = -((mounted.length - 1) * spacing) / 2;
    mounted.forEach((m, i) => {
      const group = m.controller.group;
      if (group) group.position.x += startX + i * spacing;
    });

    this.slots = mounted.map((m) => ({ race: m.race, label: m.label, controller: m.controller }));

    const feetY = mounted[0]?.bounds.box.min.y ?? 0;
    this.sceneController.grid.position.y = feetY;
    this.sceneController.grid.scale.setScalar(Math.max(spacing * mounted.length, maxRadius * 5));
    this.sceneController.groundPlane.constant = -feetY;

    this.camera.position.set(0, feetY + maxRadius * 1.6, maxRadius * (mounted.length + 2));
    this.camera.lookAt(0, feetY + maxRadius * 0.9, 0);
    this.camera.near = maxRadius / 50;
    this.camera.far = maxRadius * 200;
    this.camera.updateProjectionMatrix();
  }

  update(delta: number): void {
    for (const slot of this.slots) slot.controller.update(delta);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  }

  onPointerUp(event: PointerEvent): void {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    if (!down) return;
    const movedPx = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (movedPx > CLICK_DRAG_TOLERANCE_PX) return; // was a drag, not a click

    const rect = this.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    for (const slot of this.slots) {
      const group = slot.controller.group;
      if (!group) continue;
      if (this.raycaster.intersectObject(group, true).length > 0) {
        this.callbacks.onPick?.(slot.race, slot.label);
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots) slot.controller.dispose();
    this.slots = [];
    this.sceneController.dispose();
  }
}
