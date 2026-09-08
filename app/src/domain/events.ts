import type { Side } from './arena';
import type { Vec3 } from './math/vec3';

/**
 * Domain events emitted by `Match.step`.
 *
 * They are the only channel through which the presentation layer learns that
 * something happened: the renderer spawns particles from them, the audio adapter
 * synthesises sounds from them, the HUD updates from them. Nothing outside the
 * domain reads physics state to decide "did we just bounce?".
 */
export type DomainEvent =
  | WallBounceEvent
  | PaddleHitEvent
  | PaddleMissEvent
  | PointScoredEvent
  | ServeEvent
  | MatchWonEvent;

export interface WallBounceEvent {
  readonly type: 'wall-bounce';
  /** Which arena face was hit. */
  readonly axis: 'x' | 'y';
  readonly position: Vec3;
  /** Impact strength normalised against the ball's speed, in `[0, 1]`. */
  readonly intensity: number;
}

export interface PaddleHitEvent {
  readonly type: 'paddle-hit';
  readonly side: Side;
  readonly position: Vec3;
  /** Offset from the paddle centre, normalised to `[-1, 1]` on both axes. */
  readonly offset: { readonly x: number; readonly y: number };
  /** Ball speed after the impulse. */
  readonly speed: number;
  /** Consecutive hits in the current rally, starting at 1. */
  readonly rally: number;
  /** True when the contact happened within the outer 15% of the paddle. */
  readonly edge: boolean;
}

export interface PaddleMissEvent {
  readonly type: 'paddle-miss';
  readonly side: Side;
  readonly position: Vec3;
  /** How far outside the paddle bounds the ball passed, in world units. */
  readonly distance: number;
}

export interface PointScoredEvent {
  readonly type: 'point-scored';
  /** The side that won the point. */
  readonly scorer: Side;
  /** The side whose goal was crossed. */
  readonly conceded: Side;
  readonly score: { readonly near: number; readonly far: number };
  readonly rally: number;
}

export interface ServeEvent {
  readonly type: 'serve';
  /** The side the ball is travelling towards. */
  readonly towards: Side;
  readonly speed: number;
}

export interface MatchWonEvent {
  readonly type: 'match-won';
  readonly winner: Side;
  readonly score: { readonly near: number; readonly far: number };
}
