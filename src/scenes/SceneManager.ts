import { Timer } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { AppScene } from './AppScene';

/** Matches `--surface-base` (src/styles/tokens.css) - the page's own background behind the canvas, see the constructor's `alpha: false` doc comment for why this needs to match. */
const CANVAS_CLEAR_COLOR = 0x0a0e15;

/**
 * Owns the single renderer/canvas and render loop shared by every screen of
 * the app (login, character select, viewer, ...) and swaps which AppScene
 * is currently mounted/rendered/receiving pointer input. Reusing one
 * persistent renderer/context - rather than tearing down and recreating one
 * per screen - avoids context-loss/recreation cost on every login ->
 * character-select -> viewer transition.
 *
 * `WebGPURenderer` (falls back to WebGL2 automatically per-browser at
 * runtime - no explicit choice needed here) instead of the old
 * `WebGLRenderer`: standard materials (everything except particleSystem.ts's
 * GPU particle shader and glowEffect.ts's onBeforeCompile glow injection -
 * see this project's own WebGPU migration notes) are converted to node
 * materials automatically, so this swap alone should already carry most of
 * the app.
 */
export class SceneManager {
  readonly renderer: WebGPURenderer;

  private readonly container: HTMLElement;
  private current: AppScene | null = null;
  /** Bumped on every setScene()/dispose() call, so a stale in-flight mount() can't win a race against a newer one. */
  private mountToken = 0;
  private disposed = false;
  private animationFrame = 0;
  private readonly timer = new Timer();

  private readonly handlePointerDown = (event: PointerEvent) => this.current?.onPointerDown?.(event);
  private readonly handlePointerUp = (event: PointerEvent) => this.current?.onPointerUp?.(event);

  private constructor(container: HTMLElement) {
    this.container = container;

    // `alpha: false` - THREE.Renderer (the base WebGPURenderer/WebGLRenderer
    // share) defaults `alpha: true` (a genuinely different default than the
    // old WebGLRenderer-only code this project used to run had implicitly,
    // since that one defaulted `alpha: false`), making the canvas'
    // framebuffer transparent and letting the browser composite it over
    // this page's own dark background per-pixel. That compositing is where
    // this project's "black/dark rectangular background around textured
    // particles" WebGPU-migration regression actually came from - nothing
    // to do with particle texture decoding, TSL, or blending math: additive
    // blending's alpha output isn't attenuated by its own blend factors the
    // way its RGB is (WebGPUPipelineUtils' AdditiveBlending case uses
    // srcAlpha/one for RGB but one/one for alpha), so a texture with
    // opaque-everywhere alpha (the common "additive-only, rely on a true-
    // black background for transparency" convention most of this project's
    // real weapon-glow assets use) still pushes the canvas' own alpha
    // toward 1 across a whole particle quad even where its RGB correctly
    // stays near black - and a near-(0,0,0)-RGB, near-1-alpha canvas pixel
    // composites as solid black over the page background, hiding whatever
    // was behind it (confirmed live: forcing an opaque clearColor here,
    // with no other change, removed the artifact outright). Set `alpha:
    // false` instead of leaving every additive-blended material to
    // individually route around this - it restores the pre-migration
    // "canvas is its own opaque surface" behavior, and CANVAS_CLEAR_COLOR
    // keeps its empty-pixel color matching the page behind it so the swap
    // stays visually seamless.
    this.renderer = new WebGPURenderer({ antialias: true, alpha: false });
    this.renderer.setClearColor(CANVAS_CLEAR_COLOR, 1);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
  }

  /**
   * Replaces `new SceneManager(container)` - unlike the old `WebGLRenderer`,
   * `WebGPURenderer` needs an async `init()` (adapter/device negotiation,
   * WebGL2-fallback detection) before it can render anything, so
   * construction alone isn't enough to start the render loop. If `dispose()`
   * is called on the returned promise's caller before this resolves (e.g. a
   * fast unmount), the half-initialized renderer is torn down unused instead
   * of leaking - same "stale async result loses" pattern this codebase
   * already uses for setScene()/RemoteEntityController.spawn().
   */
  static async create(container: HTMLElement): Promise<SceneManager> {
    const manager = new SceneManager(container);
    await manager.renderer.init();
    if (manager.disposed) return manager;
    manager.loop();
    return manager;
  }

  getCurrentScene(): AppScene | null {
    return this.current;
  }

  /**
   * Mounts `next` and, once it's ready, disposes whatever scene was active
   * and swaps `next` in. If a newer setScene() call (or dispose()) starts
   * before `next.mount()` resolves, `next` is disposed unused instead of
   * clobbering whatever the newer call produced - the same "stale load
   * loses" pattern AssetController uses for race switches.
   */
  async setScene(next: AppScene): Promise<void> {
    const token = ++this.mountToken;
    await next.mount();
    if (this.disposed || token !== this.mountToken) {
      next.dispose();
      return;
    }
    this.current?.dispose();
    this.current = next;
    next.resize(this.container.clientWidth / this.container.clientHeight);
  }

  /** Call on window resize - resizes the shared canvas and forwards the new aspect to whichever scene is active. */
  resize(): void {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.current?.resize(this.container.clientWidth / this.container.clientHeight);
  }

  private readonly loop = (): void => {
    this.animationFrame = requestAnimationFrame(this.loop);
    this.timer.update();
    const delta = this.timer.getDelta();
    if (this.current) {
      const updateStart = performance.now();
      this.current.update(delta);
      const renderStart = performance.now();
      this.renderer.render(this.current.scene, this.current.getCamera());
      this.current.reportFrameTiming?.(renderStart - updateStart, performance.now() - renderStart);
    }
  };

  dispose(): void {
    this.disposed = true;
    this.mountToken += 1;
    cancelAnimationFrame(this.animationFrame);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.current?.dispose();
    this.current = null;
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
