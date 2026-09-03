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
} from 'three';
import type { Material } from 'three';

/**
 * Ground/lighting dressing reused by any AppScene that stages a character
 * on a floor: ambient + sun lighting, the ground grid/plane, and the
 * click-to-move target marker. Deliberately renderer- and camera-agnostic -
 * SceneManager owns the single shared renderer, each AppScene owns its own
 * camera(s) and calls into this for the rest of the scene graph.
 */
export class SceneController {
  readonly scene = new Scene();
  readonly grid = new GridHelper(4, 32, 0x555555, 0x333333);
  readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  readonly targetMarker: Mesh;

  constructor() {
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

  dispose(): void {
    this.grid.geometry.dispose();
    (this.grid.material as Material).dispose();
    this.targetMarker.geometry.dispose();
    (this.targetMarker.material as Material).dispose();
  }
}
