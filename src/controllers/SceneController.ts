import {
  AmbientLight,
  Box3,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Mesh,
  MeshBasicMaterial,
  Plane,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Camera } from 'three';

/**
 * Owns the base three.js scene graph and renderer: lighting, the ground
 * grid/plane, the click-to-move target marker, and the render/resize
 * plumbing. Deliberately camera-agnostic - CameraController owns the
 * camera(s); this just renders whichever one it's handed.
 */
export class SceneController {
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly grid = new GridHelper(4, 32, 0x555555, 0x333333);
  readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  readonly targetMarker: Mesh;

  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.add(new AmbientLight(0xffffff, 0.6));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 3, 2);
    this.scene.add(sun);

    this.scene.add(this.grid);

    this.targetMarker = new Mesh(
      new RingGeometry(0.4, 0.55, 32),
      new MeshBasicMaterial({ color: 0x4a7dff, side: DoubleSide, transparent: true, opacity: 0.8 }),
    );
    this.targetMarker.rotation.x = -Math.PI / 2;
    this.targetMarker.visible = false;
    this.scene.add(this.targetMarker);
  }

  /** Re-fits the ground grid/plane and marker scale to a newly mounted character's bounding box. */
  frameGround(box: Box3, radius: number): void {
    this.grid.position.y = box.min.y;
    this.grid.scale.setScalar(radius * 5);
    this.groundPlane.constant = -box.min.y;
    this.targetMarker.scale.setScalar(radius * 0.25);
  }

  showTargetMarker(point: Vector3): void {
    this.targetMarker.position.set(point.x, point.y + 0.01, point.z);
    this.targetMarker.visible = true;
  }

  hideTargetMarker(): void {
    this.targetMarker.visible = false;
  }

  /** Call on window resize - the renderer's canvas size only, camera aspect is CameraController's job. */
  resize(): void {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  render(camera: Camera): void {
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
