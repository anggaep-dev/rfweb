import { decodeDdsPixels } from './texture';
import { ICON_SHEET_BY_SLOT, ModelType } from './items';

const ICON_BASE = '/game-assets/gfx/item_icon';
/** Every sheet in gfx/item_icon/ is a flat DXT1 atlas of 64x64 cells (verified against every ICON_SHEET_BY_SLOT entry's real DDS header) - no per-sheet variation to account for. */
const ICON_CELL_SIZE = 64;

interface IconSheet {
  /** The whole decoded sheet, already painted to a canvas once - getItemIconUrl crops out of this instead of re-decoding per icon. */
  canvas: HTMLCanvasElement;
  cols: number;
  rows: number;
}

const sheetCache = new Map<string, Promise<IconSheet | null>>();
/** Keyed by `${fileName}:${iconIndex}` - a cropped 64x64 data URL is cheap but not free, and the same icon is drawn repeatedly (every bag slot holding a stack of the same item, re-renders, ...). */
const iconUrlCache = new Map<string, string | null>();

async function fetchAndDecodeSheet(fileName: string): Promise<IconSheet | null> {
  try {
    const res = await fetch(`${ICON_BASE}/${fileName}`);
    if (!res.ok) throw new Error(`Failed to fetch ${fileName}: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const { data, width, height } = decodeDdsPixels(buffer);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

    return { canvas, cols: Math.floor(width / ICON_CELL_SIZE), rows: Math.floor(height / ICON_CELL_SIZE) };
  } catch (err) {
    console.error(`Failed to load item icon sheet ${fileName}:`, err);
    return null;
  }
}

function loadIconSheet(fileName: string): Promise<IconSheet | null> {
  let cached = sheetCache.get(fileName);
  if (!cached) {
    cached = fetchAndDecodeSheet(fileName);
    sheetCache.set(fileName, cached);
  }
  return cached;
}

/**
 * Kicks off fetch+decode for every sheet ICON_SHEET_BY_SLOT references
 * (deduplicated - fine as a Set even though none currently repeat), ahead of
 * any actual getItemIconUrl call. Call once on entering the world (see
 * OnlineScene.mount) so InventoryWindow's first real open doesn't stall on
 * decoding a handful of 2048x2048 DXT1 atlases - fire-and-forget, since
 * loadIconSheet's own cache means this is purely a head start, not a
 * requirement (a getItemIconUrl call before a sheet finishes preloading just
 * awaits the same in-flight promise; a sheet that fails to preload gets the
 * exact same null-returning degrade path either way).
 */
export function preloadItemIconSheets(): void {
  const fileNames = new Set(Object.values(ICON_SHEET_BY_SLOT));
  for (const fileName of fileNames) {
    if (fileName) void loadIconSheet(fileName);
  }
}

/**
 * A real per-item icon as a data: URL, cropped from that slot's DDS sprite
 * sheet at `iconIndex` (ItemDefinition.icon, row-major - see
 * ICON_SHEET_BY_SLOT's own doc comment) - or null when this slot has no
 * icon sheet, the sheet failed to load, or `iconIndex` falls outside its
 * grid. Callers should fall back to a generic placeholder icon on null, not
 * treat it as an error - a missing/unmapped icon is an expected, common
 * case (see ICON_SHEET_BY_SLOT/findItemDefinitionByCode's own doc comments).
 */
export async function getItemIconUrl(modelType: ModelType, iconIndex: number): Promise<string | null> {
  const fileName = ICON_SHEET_BY_SLOT[modelType];
  if (!fileName) return null;

  const cacheKey = `${fileName}:${iconIndex}`;
  if (iconUrlCache.has(cacheKey)) return iconUrlCache.get(cacheKey) ?? null;

  const sheet = await loadIconSheet(fileName);
  let url: string | null = null;
  if (sheet) {
    const col = iconIndex % sheet.cols;
    const row = Math.floor(iconIndex / sheet.cols);
    if (row < sheet.rows) {
      const out = document.createElement('canvas');
      out.width = ICON_CELL_SIZE;
      out.height = ICON_CELL_SIZE;
      const ctx = out.getContext('2d');
      if (ctx) {
        ctx.drawImage(
          sheet.canvas,
          col * ICON_CELL_SIZE,
          row * ICON_CELL_SIZE,
          ICON_CELL_SIZE,
          ICON_CELL_SIZE,
          0,
          0,
          ICON_CELL_SIZE,
          ICON_CELL_SIZE,
        );
        url = out.toDataURL();
      }
    }
  }
  iconUrlCache.set(cacheKey, url);
  return url;
}
