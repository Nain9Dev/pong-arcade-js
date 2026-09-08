import type { Vec3 } from './math/vec3';

/**
 * The play volume: an axis-aligned box centred on the origin.
 *
 * Axes follow the renderer convention — `x` is lateral, `y` is vertical and `z`
 * runs from the near goal (negative, human player) to the far goal (positive).
 * Goals sit on the `z = ±halfDepth` planes; paddles float `paddleInset` in front
 * of them so a defeated ball visibly crosses the goal line before scoring.
 */
export interface Arena {
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly halfDepth: number;
  readonly paddleInset: number;
}

export const DEFAULT_ARENA: Arena = {
  halfWidth: 9,
  halfHeight: 5.5,
  halfDepth: 22,
  paddleInset: 1.6,
};

/** Absolute `z` of the plane a paddle sweeps. */
export const paddlePlaneZ = (arena: Arena): number => arena.halfDepth - arena.paddleInset;

/** `z` of the goal plane for a given side. */
export const goalPlaneZ = (arena: Arena, side: Side): number =>
  side === 'near' ? -arena.halfDepth : arena.halfDepth;

/**
 * Which end of the arena an actor defends. `near` is the camera-side end and is
 * always the human player in single-player mode.
 */
export type Side = 'near' | 'far';

export const SIDES: readonly Side[] = ['near', 'far'] as const;

export const opposite = (side: Side): Side => (side === 'near' ? 'far' : 'near');

/** Unit `z` direction pointing from the arena centre towards the given side. */
export const sideSign = (side: Side): number => (side === 'near' ? -1 : 1);

/** True when a point lies inside the arena box, inflated by `margin`. */
export const containsPoint = (arena: Arena, p: Vec3, margin = 0): boolean =>
  Math.abs(p.x) <= arena.halfWidth + margin &&
  Math.abs(p.y) <= arena.halfHeight + margin &&
  Math.abs(p.z) <= arena.halfDepth + margin;
