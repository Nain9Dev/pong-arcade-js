import type { Side } from './arena';
import type { Vec3 } from './math/vec3';

/** The ball, expressed purely as physical state. */
export interface BallState {
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** Angular velocity vector; drives the Magnus curve and the visual roll. */
  readonly spin: Vec3;
}

/**
 * A paddle only has two degrees of freedom: it slides on the `x`/`y` plane at a
 * fixed `z`. Keeping it 2D in the domain is what lets the AI reason about the
 * problem analytically.
 */
export interface PaddleState {
  readonly side: Side;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * Normalised control input for one paddle, each axis in `[-1, 1]`.
 * Adapters (keyboard, pointer, gamepad, AI) all reduce to this single shape.
 */
export interface PaddleIntent {
  readonly x: number;
  readonly y: number;
}

export const NEUTRAL_INTENT: PaddleIntent = { x: 0, y: 0 };

export const createPaddle = (side: Side): PaddleState => ({ side, x: 0, y: 0, vx: 0, vy: 0 });
