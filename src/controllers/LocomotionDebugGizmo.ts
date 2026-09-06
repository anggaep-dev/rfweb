import { ArrowHelper, CanvasTexture, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Scene } from 'three';
import type { LocomotionDirection } from '../rf/character';

const FONT = 'bold 48px "Space Grotesk", system-ui, sans-serif';
const TEXT_COLOR = '#ffce54';
const OUTLINE_COLOR = 'rgba(10, 14, 21, 0.9)';
const CANVAS_PADDING_X = 20;
const CANVAS_HEIGHT = 64;
const LABEL_HEIGHT_RADIUS_FACTOR = 0.16;
/** Above NameTag's own HEAD_CLEARANCE_RADIUS_FACTOR (0.40) so the two labels never overlap. */
const LABEL_CLEARANCE_RADIUS_FACTOR = 0.7;
const ARROW_LENGTH_RADIUS_FACTOR = 1.3;
/** design.md's vital-emerald - matches NameTag's own green, since this is "facing" same as the concept a nametag hovers over. */
const FACING_COLOR = 0x34d179;
const MOVE_COLOR = 0xff5566;

/** null unambiguously means "forward" here - classifyLocomotionDirection(Stable) already gives backward its own distinct 'bw', never folds it into null - so labeling null as "fwd" (not some vaguer placeholder) is accurate, not a guess. */
function labelText(locomotionDirection: LocomotionDirection | null, clipKey: string | null): string {
  return `${locomotionDirection ?? 'fwd'} | ${clipKey ?? '?'}`;
}

function createLabelTexture(text: string): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  ctx.font = FONT;
  const textWidth = ctx.measureText(text).width;
  canvas.width = Math.ceil(textWidth) + CANVAS_PADDING_X * 2;
  canvas.height = CANVAS_HEIGHT;
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { texture, aspect: canvas.width / canvas.height };
}

/**
 * TEMP debug-only visualization for the strafe-misclassified-on-observer
 * investigation - two ArrowHelpers (facing=green, moveDirection=red) plus a
 * floating text label showing the resolved locomotionDirection and clip key,
 * anchored above a character. One per character (local player in
 * OnlineScene, or each remote entity in RemoteEntityController) - lets a
 * screenshot from either side show exactly what that side computed, instead
 * of needing matching console logs from two separate clients. Remove once
 * the bug's confirmed fixed on both sides.
 */
export class LocomotionDebugGizmo {
  private readonly scene: Scene;
  private readonly facingArrow: ArrowHelper;
  private readonly moveArrow: ArrowHelper;
  private readonly label: Sprite;
  private readonly arrowLength: number;
  private readonly labelHeight: number;
  private readonly labelClearance: number;
  private lastText = '';

  /** `radius` is the same CharacterBounds.radius CharacterController.mount() returns - sizes/positions everything proportionally to that character's own native scale, same convention as NameTag. */
  constructor(scene: Scene, radius: number) {
    this.scene = scene;
    this.arrowLength = radius * ARROW_LENGTH_RADIUS_FACTOR;
    this.labelClearance = radius * LABEL_CLEARANCE_RADIUS_FACTOR;
    this.labelHeight = radius * LABEL_HEIGHT_RADIUS_FACTOR;

    const headLength = this.arrowLength * 0.25;
    const headWidth = this.arrowLength * 0.15;
    this.facingArrow = new ArrowHelper(new Vector3(0, 0, -1), new Vector3(), this.arrowLength, FACING_COLOR, headLength, headWidth);
    this.moveArrow = new ArrowHelper(new Vector3(0, 0, -1), new Vector3(), this.arrowLength, MOVE_COLOR, headLength, headWidth);
    this.facingArrow.visible = false;
    this.moveArrow.visible = false;
    scene.add(this.facingArrow, this.moveArrow);

    const { texture, aspect } = createLabelTexture(labelText(null, null));
    this.label = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    this.label.scale.set(this.labelHeight * aspect, this.labelHeight, 1);
    scene.add(this.label);
  }

  /**
   * Repositions/reorients everything for this frame. `facing` should always
   * be a valid unit-ish vector; `moveDirection` is null while not moving
   * (hides its arrow rather than pointing it somewhere meaningless).
   */
  update(
    origin: Vector3,
    facing: Vector3,
    moveDirection: Vector3 | null,
    locomotionDirection: LocomotionDirection | null,
    clipKey: string | null,
  ): void {
    if (facing.lengthSq() > 1e-8) {
      this.facingArrow.visible = true;
      this.facingArrow.position.copy(origin);
      this.facingArrow.setDirection(facing.clone().normalize());
    } else {
      this.facingArrow.visible = false;
    }

    if (moveDirection && moveDirection.lengthSq() > 1e-8) {
      this.moveArrow.visible = true;
      this.moveArrow.position.copy(origin);
      this.moveArrow.setDirection(moveDirection.clone().normalize());
    } else {
      this.moveArrow.visible = false;
    }

    this.label.position.copy(origin);
    this.label.position.y += this.labelClearance;

    const text = labelText(locomotionDirection, clipKey);
    if (text !== this.lastText) {
      this.lastText = text;
      const oldMap = this.label.material.map;
      const { texture, aspect } = createLabelTexture(text);
      this.label.material.map = texture;
      this.label.material.needsUpdate = true;
      oldMap?.dispose();
      this.label.scale.set(this.labelHeight * aspect, this.labelHeight, 1);
    }
  }

  dispose(): void {
    this.scene.remove(this.facingArrow, this.moveArrow, this.label);
    this.facingArrow.dispose();
    this.moveArrow.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}
