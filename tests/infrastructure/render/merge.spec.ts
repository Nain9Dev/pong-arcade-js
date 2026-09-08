import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { mergeAndDispose } from '../../../app/src/infrastructure/render/models/merge';

const triangleCount = (geometry: THREE.BufferGeometry): number =>
  (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;

describe('mergeAndDispose', () => {
  it('merges a batch that mixes indexed and non-indexed parts', () => {
    // The robot head does exactly this: bevelled slabs (RoundedBoxGeometry is
    // always non-indexed) next to the cylindrical ear vents.
    const slab = new RoundedBoxGeometry(1, 1, 1, 1, 0.1);
    const ear = new THREE.CylinderGeometry(0.24, 0.28, 0.5, 10);
    const expected = triangleCount(slab) + triangleCount(ear);

    const merged = mergeAndDispose([slab, ear]);

    expect(merged).toBeInstanceOf(THREE.BufferGeometry);
    expect(triangleCount(merged)).toBe(expected);
  });

  it('keeps the index buffer when every part is already indexed', () => {
    // The racket string bed slices this index with `setDrawRange`, so a uniform
    // batch must not be silently expanded.
    const parts = [new THREE.BoxGeometry(1, 1, 1), new THREE.SphereGeometry(0.5, 8, 6)];
    const expected = parts.reduce((total, part) => total + triangleCount(part), 0);

    const merged = mergeAndDispose(parts);

    expect(merged.index).not.toBeNull();
    expect(triangleCount(merged)).toBe(expected);
  });

  it('disposes every source part', () => {
    const parts = [new THREE.BoxGeometry(1, 1, 1), new RoundedBoxGeometry(1, 1, 1, 1, 0.1)];
    const disposed = parts.map(() => false);
    parts.forEach((part, i) => part.addEventListener('dispose', () => (disposed[i] = true)));

    mergeAndDispose(parts);

    expect(disposed).toEqual([true, true]);
  });

  it('throws when the parts carry different attribute sets', () => {
    const withUv = new THREE.BoxGeometry(1, 1, 1);
    const withoutUv = new THREE.BoxGeometry(1, 1, 1);
    withoutUv.deleteAttribute('uv');

    expect(() => mergeAndDispose([withUv, withoutUv])).toThrow(/attribute/i);
  });
});
