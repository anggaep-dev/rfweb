import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GroundHeightProvider } from './groundHeight';

function floorMesh(y: number): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        -10, y, -10,
        10, y, 10,
        10, y, -10,
        -10, y, -10,
        -10, y, 10,
        10, y, 10,
      ]),
      3,
    ),
  );
  geometry.computeBoundingSphere();
  return new Mesh(geometry, new MeshBasicMaterial());
}

function stackedProvider(): GroundHeightProvider {
  const group = new Group();
  group.add(floorMesh(0));
  group.add(floorMesh(100));
  group.updateMatrixWorld(true);
  return new GroundHeightProvider(group, new Box3().setFromObject(group));
}

describe('GroundHeightProvider', () => {
  it('chooses the stacked surface closest to the current movement Y', () => {
    const provider = stackedProvider();

    expect(provider.getGroundAt(0, 0, { mode: 'movement', referenceY: 8 })?.y).toBe(0);
    expect(provider.getGroundAt(0, 0, { mode: 'movement', referenceY: 92 })?.y).toBe(100);
  });

  it('rejects discontinuous movement jumps to another layer', () => {
    const provider = stackedProvider();

    expect(provider.getGroundAt(0, 0, { mode: 'movement', referenceY: 400 })?.y).toBeUndefined();
  });

  it('uses teleport or spawn Y as the layer hint', () => {
    const provider = stackedProvider();
    const position = new Vector3(0, 91, 0);

    expect(provider.applyToPosition(position, { mode: 'teleport', referenceY: position.y })).toBe(true);
    expect(position.y).toBe(100);
  });
});
