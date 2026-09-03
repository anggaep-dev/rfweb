import type { Camera, Scene } from 'three';

/**
 * A top-level "screen" the app can be in (login, character select, the
 * in-game/asset viewer, ...), each owning its own three.js Scene and
 * camera. SceneManager owns a single renderer/canvas shared by all of them
 * and swaps which one is active.
 */
export interface AppScene {
  readonly scene: Scene;
  getCamera(): Camera;

  /** Called once by SceneManager before this scene becomes active - do async setup here (it's fine to resolve immediately and keep loading in the background, updating via a constructor-supplied callback, if a blank/loading scene is an acceptable first frame). */
  mount(): Promise<void> | void;

  /** Called once per frame while this scene is active, right before it's rendered. */
  update(delta: number): void;

  /** Container aspect ratio changed - update the active camera's projection. */
  resize(aspect: number): void;

  /** Optional scene-specific pointer handling (click-to-move, click-a-character-slot, ...). Only the currently active scene receives these. */
  onPointerDown?(event: PointerEvent): void;
  onPointerUp?(event: PointerEvent): void;

  /** Releases this scene's three.js objects and listeners. Called by SceneManager right after a newer scene's mount() resolves and takes over. */
  dispose(): void;
}
