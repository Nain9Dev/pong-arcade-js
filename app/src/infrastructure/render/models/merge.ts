import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Expands a batch to non-indexed form, or `null` when it is already uniform.
 *
 * Uniform batches are left alone on purpose: the racket string bed is merged
 * from indexed strands and then sliced with `setDrawRange` over that very index,
 * so dropping it would quietly break the low quality level.
 */
const expandToNonIndexed = (
  parts: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry[] | null => {
  const indexed = parts.filter((part) => part.index !== null).length;
  if (indexed === 0 || indexed === parts.length) return null;
  return parts.map((part) => (part.index === null ? part.clone() : part.toNonIndexed()));
};

/**
 * Merges parts into one buffer, disposes the sources and returns the result.
 * Every model in this folder assembles its meshes this way, so that a rib, a
 * truss module or a whole robot head costs exactly one draw call.
 *
 * `mergeGeometries` refuses a batch that mixes indexed and non-indexed parts and
 * reports it by returning `null` — which the published type hides, and which
 * only surfaces much later as `Cannot read properties of null` inside
 * `Mesh.updateMorphTargets`. Primitives are indexed while `RoundedBoxGeometry`
 * never is, so a mixed batch is easy to write by accident; this is where that
 * gets reconciled instead of at every call site.
 */
export const mergeAndDispose = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
  const expanded = expandToNonIndexed(parts);
  const merged: THREE.BufferGeometry | null = mergeGeometries(expanded ?? parts, false);

  if (expanded !== null) for (const part of expanded) part.dispose();
  for (const part of parts) part.dispose();

  if (merged === null) {
    throw new Error(
      `mergeAndDispose: three.js rejected a batch of ${parts.length} geometries. ` +
        'Every part must expose the same attribute set.',
    );
  }
  return merged;
};
