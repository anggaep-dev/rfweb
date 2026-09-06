import { CanvasTexture, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Object3D, Scene } from 'three';

const FONT = 'bold 64px "Space Grotesk", system-ui, sans-serif';
/** design.md's vital-emerald token (src/styles/tokens.css's --vital-emerald) - this project's established "green," not an arbitrary one. */
const TEXT_COLOR = '#34d179';
const OUTLINE_COLOR = 'rgba(10, 14, 21, 0.9)';
const CANVAS_PADDING_X = 24;
const CANVAS_HEIGHT = 96;
/**
 * Sized as a fraction of the character's own bounding radius, not a fixed
 * world-unit height - same "radius-relative" convention CharacterController
 * already uses (WALK_SPEED_RADIUS_PER_SEC, ARRIVE_FRACTION_OF_RADIUS) for
 * exactly this reason: race models differ hugely in native mesh scale
 * (confirmed empirically - a Bell_Female's head bone alone sits at world
 * Y≈13, nowhere near a "1 unit ≈ 1 meter" assumption), so a fixed height
 * that looked right for one race would be imperceptibly tiny on another. A
 * fixed constant here (the original bug) rendered at ~3% of the character's
 * actual height - technically on-screen, but invisible in practice.
 */
const SPRITE_HEIGHT_RADIUS_FACTOR = 0.18;
/** How far above the head bone's own position the tag floats, same radius-relative reasoning - the bone itself sits roughly at the neck/chin joint, not the top of the skull. */
const HEAD_CLEARANCE_RADIUS_FACTOR = 0.40;

function createNameTagTexture(name: string): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  ctx.font = FONT;
  const textWidth = ctx.measureText(name).width;
  canvas.width = Math.ceil(textWidth) + CANVAS_PADDING_X * 2;
  canvas.height = CANVAS_HEIGHT;
  // Resizing a canvas resets its 2D context state, font included - re-set
  // before drawing.
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeText(name, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { texture, aspect:   canvas.width / canvas.height };
}

/**
 * A floating, always-camera-facing name label above a character's head -
 * three.js's Sprite is inherently billboarded (no manual look-at-camera
 * math needed). One per character, local player or remote (see
 * OnlineScene/RemoteEntityController), repositioned every frame from the
 * character's own head bone so it stays put through every animation/pose
 * rather than a fixed offset from the group's root.
 */
export class NameTag {
  private readonly sprite: Sprite;
  private readonly headWorldPosition = new Vector3();
  private readonly headClearance: number;

  /** `radius` is the same CharacterBounds.radius returned by CharacterController.mount() - sizes and positions this tag proportionally to that specific character's own native scale (see SPRITE_HEIGHT_RADIUS_FACTOR's doc comment). */
  constructor(scene: Scene, name: string, radius: number) {
    const { texture, aspect } = createNameTagTexture(name);
    const height = radius * SPRITE_HEIGHT_RADIUS_FACTOR;
    // depthWrite off so the tag never occludes anything behind it in the
    // depth buffer; depthTest stays on (default) so it's still properly
    // hidden behind real geometry (a wall, another player) in front of it.
    this.sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    this.sprite.scale.set(height * aspect, height, 1);
    this.headClearance = radius * HEAD_CLEARANCE_RADIUS_FACTOR;
    scene.add(this.sprite);
  }

  /** Repositions the tag just above the given head bone - call once per frame after the character's own pose/position for that frame is set. No-op (tag stays wherever it last was) if `headBone` is null (e.g. mid-load). */
  update(headBone: Object3D | null): void {
    if (!headBone) return;
    // Forces this bone's own world matrix up to date from its parents right
    // now, rather than reading whatever the last render pass left behind
    // (which would be a frame stale, since nothing has re-run
    // updateMatrixWorld yet at this point in the loop).
    headBone.updateWorldMatrix(true, false);
    headBone.getWorldPosition(this.headWorldPosition);
    this.sprite.position.copy(this.headWorldPosition);
    this.sprite.position.y += this.headClearance;
  }

  dispose(scene: Scene): void {
    scene.remove(this.sprite);
    this.sprite.material.map?.dispose();
    this.sprite.material.dispose();
  }
}
