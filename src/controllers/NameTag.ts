import { CanvasTexture, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Box3, Object3D, Scene } from 'three';
import { RaceGender } from '../rf/character';

const FONT = 'bold 64px "Space Grotesk", system-ui, sans-serif';
/** design.md's vital-emerald token (src/styles/tokens.css's --vital-emerald) - this project's established "green," not an arbitrary one. */
const TEXT_COLOR = '#34d179';
const OUTLINE_COLOR = 'rgba(10, 14, 21, 0.9)';
const CANVAS_PADDING_X = 24;
const CANVAS_HEIGHT = 96;
const RANK_ICON_SIZE = 24;
const RANK_ICON_DRAW_SIZE = 64;
const RANK_ICON_GAP = 12;
const RANK_SHEET_COLUMNS = 8;
const RANK_SHEET_URL = '/game-gui/allrank.png';
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
/** Small clearance above the static mounted character bounds, so the tag does not bob with animated head bones. */
const ROOT_CLEARANCE_RADIUS_FACTOR = 0.12;

export type SpecialRankBadge = 'owner' | 'vip' | 'dev' | 'mod' | 'gm';

export interface NameTagRank {
  race: RaceGender;
  rank?: number;
  specialRank?: SpecialRankBadge;
}

export interface NameTagBounds {
  box: Box3;
  radius: number;
}

const SPECIAL_RANK_ICON_INDEX: Record<SpecialRankBadge, number> = {
  owner: 27,
  vip: 28,
  dev: 29,
  mod: 30,
  gm: 31,
};
const SPECIAL_RANK_BY_NUMERIC_RANK: Record<number, SpecialRankBadge> = {
  9: 'owner',
  10: 'vip',
  11: 'dev',
  12: 'mod',
  13: 'gm',
};

let rankSheetPromise: Promise<HTMLImageElement> | null = null;

function loadRankSheet(): Promise<HTMLImageElement> {
  rankSheetPromise ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load rank sprite sheet: ${RANK_SHEET_URL}`));
    image.src = RANK_SHEET_URL;
  });
  return rankSheetPromise;
}

function normalRankIconIndex(race: RaceGender, rank: number): number | null {
  if (!Number.isInteger(rank) || rank < 1 || rank > 8) return null;
  if (race === RaceGender.Bell_Male || race === RaceGender.Bell_Female) return rank;
  if (race === RaceGender.Cora_Male || race === RaceGender.Cora_Female) return 8 + rank;
  if (race === RaceGender.Accretia) return 16 + rank;
  return null;
}

function rankIconIndex(rankInfo: NameTagRank | undefined): number | null {
  if (!rankInfo) return null;
  const specialRank = rankInfo.specialRank?.toLowerCase() as SpecialRankBadge | undefined;
  if (specialRank) return SPECIAL_RANK_ICON_INDEX[specialRank] ?? null;
  const numericSpecialRank = SPECIAL_RANK_BY_NUMERIC_RANK[rankInfo.rank ?? 0];
  if (numericSpecialRank) return SPECIAL_RANK_ICON_INDEX[numericSpecialRank];
  return normalRankIconIndex(rankInfo.race, rankInfo.rank ?? 0);
}

function drawNameTagCanvas(ctx: CanvasRenderingContext2D, name: string, canvasWidth: number, iconIndex: number | null, rankSheet?: HTMLImageElement) {
  ctx.clearRect(0, 0, canvasWidth, CANVAS_HEIGHT);
  ctx.imageSmoothingEnabled = false;

  const hasIcon = iconIndex !== null;
  const contentWidth = canvasWidth - CANVAS_PADDING_X * 2;
  const iconOffset = hasIcon ? RANK_ICON_DRAW_SIZE + RANK_ICON_GAP : 0;
  const textCenterX = CANVAS_PADDING_X + iconOffset + (contentWidth - iconOffset) / 2;

  if (hasIcon && rankSheet) {
    const spriteIndex = iconIndex;
    const sourceX = (spriteIndex % RANK_SHEET_COLUMNS) * RANK_ICON_SIZE;
    const sourceY = Math.floor(spriteIndex / RANK_SHEET_COLUMNS) * RANK_ICON_SIZE;
    ctx.drawImage(
      rankSheet,
      sourceX,
      sourceY,
      RANK_ICON_SIZE,
      RANK_ICON_SIZE,
      CANVAS_PADDING_X,
      (CANVAS_HEIGHT - RANK_ICON_DRAW_SIZE) / 2,
      RANK_ICON_DRAW_SIZE,
      RANK_ICON_DRAW_SIZE,
    );
  }

  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeText(name, textCenterX, CANVAS_HEIGHT / 2);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText(name, textCenterX, CANVAS_HEIGHT / 2);
}

function createNameTagTexture(name: string, rankInfo?: NameTagRank): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  ctx.font = FONT;
  const textWidth = ctx.measureText(name).width;
  const iconIndex = rankIconIndex(rankInfo);
  const iconWidth = iconIndex !== null ? RANK_ICON_DRAW_SIZE + RANK_ICON_GAP : 0;
  canvas.width = Math.ceil(textWidth) + iconWidth + CANVAS_PADDING_X * 2;
  canvas.height = CANVAS_HEIGHT;
  // Resizing a canvas resets its 2D context state, font included - re-set
  // before drawing.
  drawNameTagCanvas(ctx, name, canvas.width, iconIndex);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  if (iconIndex !== null) {
    void loadRankSheet()
      .then((rankSheet) => {
        drawNameTagCanvas(ctx, name, canvas.width, iconIndex, rankSheet);
        texture.needsUpdate = true;
      })
      .catch((err: unknown) => console.error(err));
  }
  return { texture, aspect: canvas.width / canvas.height };
}

export function nameTagYOffsetFromBounds(bounds: NameTagBounds, rootY = 0): number {
  return bounds.box.max.y - rootY + bounds.radius * ROOT_CLEARANCE_RADIUS_FACTOR;
}

/**
 * A floating, always-camera-facing name label above a character's head area -
 * three.js's Sprite is inherently billboarded (no manual look-at-camera
 * math needed). One per character, local player or remote (see
 * OnlineScene/RemoteEntityController), repositioned every frame from the
 * character's root group plus a fixed mounted-bounds offset. It follows the
 * character through world movement, but does not inherit animated head-bone
 * bobbing.
 */
export class NameTag {
  private readonly sprite: Sprite;
  private readonly rootWorldPosition = new Vector3();
  private readonly yOffset: number;

  /** `radius` is the same CharacterBounds.radius returned by CharacterController.mount(); `yOffset` is a fixed root-relative height from those same mount bounds. */
  constructor(scene: Scene, name: string, radius: number, yOffset: number, rankInfo?: NameTagRank) {
    const { texture, aspect } = createNameTagTexture(name, rankInfo);
    const height = radius * SPRITE_HEIGHT_RADIUS_FACTOR;
    // depthWrite off so the tag never occludes anything behind it in the
    // depth buffer; depthTest stays on (default) so it's still properly
    // hidden behind real geometry (a wall, another player) in front of it.
    this.sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    this.sprite.scale.set(height * aspect, height, 1);
    this.yOffset = yOffset;
    scene.add(this.sprite);
  }

  /** Repositions the tag above the given character root group. No-op if `root` is null (e.g. mid-load). */
  update(root: Object3D | null): void {
    if (!root) return;
    root.updateWorldMatrix(true, false);
    root.getWorldPosition(this.rootWorldPosition);
    this.sprite.position.copy(this.rootWorldPosition);
    this.sprite.position.y += this.yOffset;
  }

  dispose(scene: Scene): void {
    scene.remove(this.sprite);
    this.sprite.material.map?.dispose();
    this.sprite.material.dispose();
  }
}
