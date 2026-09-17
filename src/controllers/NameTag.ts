import { CanvasTexture, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Box3, Object3D, Scene } from 'three';
import { RaceGender } from '../rf/character';

const FONT = 'bold 64px "Tahoma", system-ui, sans-serif';
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
/** Small clearance above the static mounted character bounds, so the tag does not bob with animated head bones. */
const ROOT_CLEARANCE_RADIUS_FACTOR = 0.12;

/**
 * The gameplay camera's own vertical FOV (see CameraController's
 * `new PerspectiveCamera(50, ...)`) - needed to convert a target on-screen
 * height fraction into a `Sprite.scale.y` value once `sizeAttenuation` is
 * off (see below), since that conversion is FOV-dependent. Both call sites
 * (OnlineScene, RemoteEntityController) share this one camera, so a single
 * constant is safe here rather than threading the live FOV through.
 */
const CAMERA_VERTICAL_FOV_DEGREES = 50;
/** Target name tag height as a fraction of the viewport height - tune this (not SPRITE_SCALE_Y directly) if the tag looks too big/small on screen. */
const TARGET_SCREEN_HEIGHT_FRACTION = 0.035;
/**
 * With `sizeAttenuation: false` (see the Sprite constructor below), three.js
 * cancels the usual "shrink with distance" perspective divide, so
 * `Sprite.scale` stops meaning world units and instead maps directly to a
 * fraction of the viewport - independent of both camera distance AND
 * viewport resolution (it only cancels out to a plain fraction-of-FOV, see
 * the derivation this constant is named for), which is exactly why a
 * fixed-size-on-screen name tag no longer needs the old per-race radius
 * scaling: `scale.y = targetScreenFraction * 2 * tan(fov / 2)`.
 */
const SPRITE_SCALE_Y = TARGET_SCREEN_HEIGHT_FRACTION * 2 * Math.tan((CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 180 / 2);

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

  /** `yOffset` is a fixed root-relative height from the character's mount bounds (see nameTagYOffsetFromBounds). */
  constructor(scene: Scene, name: string, yOffset: number, rankInfo?: NameTagRank) {
    const { texture, aspect } = createNameTagTexture(name, rankInfo);
    this.sprite = new Sprite(
      new SpriteMaterial({
        map: texture,
        transparent: true,
        // Never occludes anything behind it in the depth buffer; depthTest
        // stays on (default) so it's still properly hidden behind real
        // geometry (a wall, another player) in front of it.
        depthWrite: false,
        // Keeps the tag a constant on-screen size regardless of camera
        // zoom/distance (see SPRITE_SCALE_Y's own doc comment) instead of
        // shrinking/growing like normal world-space geometry.
        sizeAttenuation: false,
        // Sprites aren't lit by scene lights to begin with (SpriteMaterial
        // has no lighting model), but fog and tone-mapping exposure are the
        // two other scene-wide "atmosphere" knobs that could otherwise dim
        // or tint it - opt out of both so the tag always renders at its
        // exact designed colors.
        fog: false,
        toneMapped: false,
      }),
    );
    this.sprite.scale.set(SPRITE_SCALE_Y * aspect, SPRITE_SCALE_Y, 1);
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
