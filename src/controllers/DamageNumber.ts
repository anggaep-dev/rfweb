import { Box3, CanvasTexture, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Object3D, Scene } from 'three';

/**
 * The real in-game damage-number bitmap font: 10 digit cells, 0-9 left to
 * right, each exactly FONT_CELL_WIDTH x FONT_CELL_HEIGHT (confirmed against
 * the actual file - 200x32 total, 20x32 per cell). Drawing crops of this
 * sheet, not canvas-rendered text, is what makes the popup match the real
 * client's font instead of an arbitrary system font.
 */
const FONT_SHEET_URL = '/game-gui/effectfont_05.png';
const FONT_CELL_WIDTH = 20;
const FONT_CELL_HEIGHT = 32;

let fontSheetPromise: Promise<HTMLImageElement> | null = null;

function loadFontSheet(): Promise<HTMLImageElement> {
  fontSheetPromise ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      fontSheetPromise = null; // let a later spawn() retry instead of caching a permanent failure
      reject(new Error(`Failed to load damage number font sheet: ${FONT_SHEET_URL}`));
    };
    image.src = FONT_SHEET_URL;
  });
  return fontSheetPromise;
}

/** Same gameplay camera FOV as NameTag - see its own doc comment for why sizeAttenuation:false needs this to convert a target on-screen height into Sprite.scale. */
const CAMERA_VERTICAL_FOV_DEGREES = 50;
const TARGET_SCREEN_HEIGHT_FRACTION = 0.045;
const SPRITE_SCALE_Y = TARGET_SCREEN_HEIGHT_FRACTION * 2 * Math.tan((CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 180 / 2);

const LIFETIME_SECONDS = 1.1;
const RISE_UNITS_PER_SECOND = 0.6;
/** Fades out over the second half of LIFETIME_SECONDS, reaching 0 exactly at the end - the "become invisible" half of the requested animation. */
const FADE_START_FRACTION = 0.5;
/** The "small -> big" pop-in half - a short punchy scale-up, not a slow grow, so it reads as an impact rather than a drift. */
const POP_DURATION_SECONDS = 0.18;
const POP_START_SCALE = 0.35;
const POP_PEAK_SCALE = 1;
/** A killing blow pops slightly bigger than an ordinary hit - the only visual distinction between the two now that both use the same fixed-palette bitmap font (no per-instance recoloring of a sprite sheet crop). */
const POP_PEAK_SCALE_KILLED = 1.35;

/** Cubic ease-out-back (small overshoot then settle) - see https://easings.net/#easeOutBack. Gives the pop a bit of punch instead of a flat linear grow. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function drawDigits(image: HTMLImageElement, digits: string): { canvas: HTMLCanvasElement; aspect: number } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, digits.length) * FONT_CELL_WIDTH;
  canvas.height = FONT_CELL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false; // crisp pixel font, no blur from upscaling

  for (let i = 0; i < digits.length; i++) {
    const digit = digits.charCodeAt(i) - '0'.charCodeAt(0);
    if (digit < 0 || digit > 9) continue;
    ctx.drawImage(image, digit * FONT_CELL_WIDTH, 0, FONT_CELL_WIDTH, FONT_CELL_HEIGHT, i * FONT_CELL_WIDTH, 0, FONT_CELL_WIDTH, FONT_CELL_HEIGHT);
  }
  return { canvas, aspect: canvas.width / canvas.height };
}

interface ActiveDamageNumber {
  sprite: Sprite;
  elapsed: number;
  baseY: number;
  /** canvas.width/height once the font sheet crop resolves - 1 (a harmless square guess) until then, since the sprite stays scaled to 0 and invisible either way (see `ready`). */
  aspect: number;
  /** False until the async font-sheet load resolves and a real texture is assigned - update() holds the sprite at scale 0 (invisible) until then rather than showing an untextured white/blank quad. */
  ready: boolean;
  peakScale: number;
}

/**
 * Floating damage-number popup spawned above a monster the instant one of
 * its CombatHitEvents lands (see OnlineScene.handleCombatHit) - a purely
 * client-side flourish confirming a hit actually applied server-side, same
 * reasoning as RemoteMonsterController's own playHitReaction. Pops in small
 * -> big (see POP_DURATION_SECONDS), rises, then fades to fully invisible
 * over LIFETIME_SECONDS, then disposes itself; several can be alive for the
 * same monster at once (a fast attacker landing consecutive hits), each
 * tracked and animated independently.
 */
export class DamageNumberController {
  private readonly scene: Scene;
  private readonly active: ActiveDamageNumber[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  spawn(worldPosition: Vector3, amount: number, killed: boolean): void {
    const digits = String(Math.max(0, Math.round(amount)));
    const sprite = new Sprite(
      new SpriteMaterial({
        map: null,
        transparent: true,
        depthWrite: false,
        // Constant on-screen size regardless of camera zoom/distance - same as NameTag.
        sizeAttenuation: false,
        fog: false,
        toneMapped: false,
      }),
    );
    sprite.scale.set(0, 0, 1); // invisible until the font sheet crop is ready - see `ready` below
    sprite.position.copy(worldPosition);
    this.scene.add(sprite);

    const entry: ActiveDamageNumber = {
      sprite,
      elapsed: 0,
      baseY: worldPosition.y,
      aspect: 1,
      ready: false,
      peakScale: killed ? POP_PEAK_SCALE_KILLED : POP_PEAK_SCALE,
    };
    this.active.push(entry);

    void loadFontSheet()
      .then((image) => {
        if (!this.active.includes(entry)) return; // already expired/disposed while the (cached, so usually instant) load was in flight
        const { canvas, aspect } = drawDigits(image, digits);
        const texture = new CanvasTexture(canvas);
        texture.needsUpdate = true;
        sprite.material.map = texture;
        sprite.material.needsUpdate = true;
        entry.aspect = aspect;
        entry.ready = true;
      })
      .catch((err: unknown) => console.error('[attack] damage number font sheet load failed:', err));
  }

  /** Advances every live popup's pop/rise/fade by one frame - call once per frame regardless of whether any hit landed this frame (a no-op when `active` is empty). */
  update(delta: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i];
      entry.elapsed += delta;
      const t = entry.elapsed / LIFETIME_SECONDS;
      if (t >= 1) {
        this.disposeEntry(entry);
        this.active.splice(i, 1);
        continue;
      }

      entry.sprite.position.y = entry.baseY + RISE_UNITS_PER_SECOND * entry.elapsed;

      if (!entry.ready) continue; // stays at scale 0 (invisible) until the texture lands

      const popT = Math.min(1, entry.elapsed / POP_DURATION_SECONDS);
      const scale = POP_START_SCALE + (entry.peakScale - POP_START_SCALE) * easeOutBack(popT);
      const height = SPRITE_SCALE_Y * scale;
      entry.sprite.scale.set(height * entry.aspect, height, 1);

      const fadeT = Math.max(0, (t - FADE_START_FRACTION) / (1 - FADE_START_FRACTION));
      entry.sprite.material.opacity = 1 - fadeT;
    }
  }

  private disposeEntry(entry: ActiveDamageNumber): void {
    this.scene.remove(entry.sprite);
    entry.sprite.material.map?.dispose();
    entry.sprite.material.dispose();
  }

  /** Removes every live popup immediately - call on scene teardown (see OnlineScene's own dispose). */
  dispose(): void {
    for (const entry of this.active) this.disposeEntry(entry);
    this.active.length = 0;
  }
}

/**
 * World-space point roughly above `root`'s highest visible geometry - for
 * DamageNumberController.spawn's own worldPosition. Computed on demand (not
 * cached) since this only runs once per landed hit, not every frame.
 */
export function damageNumberAnchor(root: Object3D): Vector3 {
  // Combat hits arrive off a network packet, not necessarily right after
  // this frame's own render update - force the world matrix current first
  // (same reasoning as NameTag.update's own updateWorldMatrix call) so this
  // doesn't read a stale transform from whenever the last frame happened to
  // run.
  root.updateWorldMatrix(true, false);
  const box = new Box3().setFromObject(root);
  const anchor = new Vector3();
  root.getWorldPosition(anchor);
  if (Number.isFinite(box.max.y)) anchor.y = box.max.y;
  return anchor;
}
