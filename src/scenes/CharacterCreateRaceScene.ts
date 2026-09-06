import { Color, DirectionalLight, PerspectiveCamera, PointLight, Raycaster, SpotLight, Vector2 } from 'three';
import type { Scene } from 'three';
import { CharacterController } from '../controllers/CharacterController';
import { SceneController } from '../controllers/SceneController';
import { RaceGender, loadCharacter } from '../rf/character';
import { loadShowcaseLoadout, preloadShowcaseAssets } from '../rf/characterShowcase';
import type { AppScene } from './AppScene';

const CLICK_DRAG_TOLERANCE_PX = 12;
/** How far apart each stage slot sits, as a multiple of the tallest character's bounding radius - tighter than CharacterSelectScene's, since this lineup wants to read as one cinematic group shot, not spaced-out individual portraits. */
const SLOT_SPACING_RADIUS_FACTOR = 1.5;
/** How many candidate items to try per slot before giving up and leaving it at base appearance - see loadShowcaseLoadout, most rows in this data dump have no backing mesh yet. */
const MAX_SHOWCASE_ATTEMPTS_PER_SLOT = 6;
/** The authored mesh's front faces world -Z at rest (see CharacterController's FACING_CORRECTION doc comment for the equivalent correction applied to computed turns) - this stage's camera sits on +Z looking back at the origin, so every character needs a 180 degree turn to actually face it instead of showing its back. */
const FACE_CAMERA_ROTATION_Y = Math.PI;

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

export interface CharacterCreateRaceCallbacks {
  /** Fired when a stage slot is clicked. Purely informational - the scene doesn't track "which is currently picked" itself, the React overlay does. */
  onPick?: (race: RaceGender, label: string) => void;
}

/**
 * Character-creation's first step: every playable race/gender standing side
 * by side, each dressed in impressive gear (see rf/characterShowcase.ts) and
 * posed battle-ready, under stage lighting - a cinematic "which hero do you
 * want to be" showcase rather than the plain race list this screen used to
 * be (see CharacterSelectScene, its sibling for "your saved characters").
 * Clicking one reports it via onPick(); the actual look this race ends up
 * with is decided next, in the base-appearance editor (CharacterCreateScene) -
 * the gear equipped here is never persisted, it's just a costume for this stage.
 */
export class CharacterCreateRaceScene implements AppScene {
  private readonly sceneController = new SceneController();
  private readonly camera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly domElement: HTMLElement;
  private readonly callbacks: CharacterCreateRaceCallbacks;

  private slots: Slot[] = [];
  private pointerDownPos: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(domElement: HTMLElement, aspect: number, callbacks: CharacterCreateRaceCallbacks = {}) {
    this.domElement = domElement;
    this.callbacks = callbacks;
    this.camera = new PerspectiveCamera(42, aspect, 0.01, 1000);
    this.addStageLighting();
  }

  /** Extra lighting on top of SceneController's flat ambient+sun, scoped to this scene only - a warm key spot per character plus a cool cyan rim light behind the lineup, both from the design system's own accent colors (design.md's accent-primary/energy-cyan), so this reads as a lit stage rather than a floodlit test room. */
  private addStageLighting(): void {
    this.sceneController.scene.background = new Color(0x05070c);

    const key = new SpotLight(0xffe8c2, 6, 0, Math.PI / 4, 0.5, 1.2);
    key.position.set(0, 6, 6);
    key.target.position.set(0, 1, 0);
    this.sceneController.scene.add(key, key.target);

    const rim = new DirectionalLight(0x22d3ee, 1.4);
    rim.position.set(0, 3, -6);
    this.sceneController.scene.add(rim);

    const fill = new PointLight(0xd4a246, 0.8, 0, 2);
    fill.position.set(-4, 2, 4);
    this.sceneController.scene.add(fill);
  }

  get scene(): Scene {
    return this.sceneController.scene;
  }

  getCamera(): PerspectiveCamera {
    return this.camera;
  }

  async mount(): Promise<void> {
    // Head start for whatever CharacterSelectScreen's own call to this
    // (fired the moment "+ Create Character" is clicked) hasn't already
    // finished fetching - safe/free to call again, everything it kicks off
    // is cached forever after the first fetch.
    preloadShowcaseAssets();

    const loaded = await Promise.all(
      SELECTABLE_RACES.map(async ({ race, label }) => ({ race, label, character: await loadCharacter(race) })),
    );
    if (this.disposed) return;

    const mounted = await Promise.all(
      loaded.map(async ({ race, label, character }) => {
        const controller = new CharacterController(this.sceneController.scene);
        const bounds = await controller.mount(character, race);
        // War mode purely for the pose/silhouette here (weapon held, combat
        // stance) - never persisted, and independent of whether dressing
        // below actually finds a weapon to show.
        controller.setBattleMode('war');
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
      if (!group) return;
      group.position.x += startX + i * spacing;
      group.rotation.y = FACE_CAMERA_ROTATION_Y;
    });

    this.slots = mounted.map((m) => ({ race: m.race, label: m.label, controller: m.controller }));

    const feetY = mounted[0]?.bounds.box.min.y ?? 0;
    this.sceneController.grid.position.y = feetY;
    this.sceneController.grid.scale.setScalar(Math.max(spacing * mounted.length, maxRadius * 5));
    this.sceneController.groundPlane.constant = -feetY;

    this.camera.position.set(0, feetY + maxRadius * 1.3, maxRadius * (mounted.length * 0.85 + 1.5));
    this.camera.lookAt(0, feetY + maxRadius * 0.9, 0);
    this.camera.near = maxRadius / 50;
    this.camera.far = maxRadius * 200;
    this.camera.updateProjectionMatrix();

    // Dressing happens after the stage is already framed and interactive -
    // it's pure spectacle, so a slow/failed equip should never delay or
    // break the ability to pick a race.
    for (const m of mounted) this.dressForShowcase(m.controller, m.race);
  }

  private async dressForShowcase(controller: CharacterController, race: RaceGender): Promise<void> {
    try {
      const equips = await loadShowcaseLoadout(race);
      for (const { modelType, candidates } of equips) {
        for (const candidate of candidates.slice(0, MAX_SHOWCASE_ATTEMPTS_PER_SLOT)) {
          if (this.disposed) return;
          const result = await controller.equipItem(modelType, candidate);
          if (result === 'equipped') break;
        }
      }
    } catch (err) {
      console.error(`Showcase dressing failed for race ${race}:`, err);
    }
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
