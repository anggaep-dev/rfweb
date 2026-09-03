import { Timer, WebGLRenderer } from 'three';
import type { AppScene } from './AppScene';

/**
 * Owns the single renderer/canvas and render loop shared by every screen of
 * the app (login, character select, viewer, ...) and swaps which AppScene
 * is currently mounted/rendered/receiving pointer input. Reusing one
 * persistent WebGL context - rather than tearing down and recreating a
 * renderer per screen - avoids context-loss/recreation cost on every
 * login -> character-select -> viewer transition.
 */
export class SceneManager {
  readonly renderer: WebGLRenderer;

  private readonly container: HTMLElement;
  private current: AppScene | null = null;
  /** Bumped on every setScene()/dispose() call, so a stale in-flight mount() can't win a race against a newer one. */
  private mountToken = 0;
  private disposed = false;
  private animationFrame = 0;
  private readonly timer = new Timer();

  private readonly handlePointerDown = (event: PointerEvent) => this.current?.onPointerDown?.(event);
  private readonly handlePointerUp = (event: PointerEvent) => this.current?.onPointerUp?.(event);

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);

    this.loop();
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
      this.current.update(delta);
      this.renderer.render(this.current.scene, this.current.getCamera());
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
