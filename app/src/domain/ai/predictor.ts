import type { Arena, Side } from '../arena';
import { sideSign } from '../arena';
import type { BallState } from '../entities';
import { contactPlaneZ } from '../physics';
import type { MatchRules } from '../rules';
import { cross, length, scale, vec3 } from '../math/vec3';

/**
 * Where and when the ball will reach a paddle plane.
 *
 * This is the AI's "brain": rather than chasing the ball's current `y` like the
 * old 2D implementation did, the opponent solves the trajectory — including wall
 * reflections and the Magnus curve — and moves to the intercept point. That is
 * what makes a 3D opponent feel competent instead of merely fast.
 */
export interface Intercept {
  readonly x: number;
  readonly y: number;
  /** Seconds until the ball arrives. */
  readonly time: number;
  /** Number of wall reflections along the way — a proxy for "how tricky". */
  readonly bounces: number;
}

const PREDICT_STEP = 1 / 120;
const EPSILON = 1e-9;

/**
 * Forward-integrates a *copy* of the ball until it crosses `side`'s paddle plane.
 *
 * Deliberately ignores paddles: the question being answered is "if nothing
 * intervenes, where does this ball arrive?". Returns `null` when the ball is not
 * heading that way, or when it would take longer than `horizon` seconds.
 */
export const predictIntercept = (
  arena: Arena,
  rules: MatchRules,
  ball: BallState,
  side: Side,
  horizon = 4,
): Intercept | null => {
  const towards = sideSign(side);
  if (ball.velocity.z * towards <= EPSILON) return null;

  const planeZ = contactPlaneZ(arena, rules, side);
  const limitX = arena.halfWidth - rules.ball.radius;
  const limitY = arena.halfHeight - rules.ball.radius;

  let position = ball.position;
  let velocity = ball.velocity;
  let spin = ball.spin;
  let time = 0;
  let bounces = 0;

  while (time < horizon) {
    const dt = Math.min(PREDICT_STEP, horizon - time);

    const magnus = scale(cross(spin, velocity), rules.ball.spinForce);
    velocity = vec3(
      velocity.x + magnus.x * dt,
      velocity.y + magnus.y * dt,
      velocity.z + magnus.z * dt,
    );
    const speed = length(velocity);
    if (speed > rules.ball.maxSpeed) velocity = scale(velocity, rules.ball.maxSpeed / speed);
    spin = scale(spin, Math.exp(-rules.ball.spinDecay * dt));

    // Does this sub-step cross the paddle plane?
    const nextZ = position.z + velocity.z * dt;
    const crosses = towards > 0 ? nextZ >= planeZ : nextZ <= planeZ;
    if (crosses && Math.abs(velocity.z) > EPSILON) {
      const t = (planeZ - position.z) / velocity.z;
      return {
        x: position.x + velocity.x * t,
        y: position.y + velocity.y * t,
        time: time + t,
        bounces,
      };
    }

    // Walls, resolved analytically inside the sub-step.
    let x = position.x + velocity.x * dt;
    let y = position.y + velocity.y * dt;
    if (x > limitX || x < -limitX) {
      x = Math.sign(x) * (2 * limitX - Math.abs(x));
      velocity = vec3(-velocity.x, velocity.y, velocity.z);
      spin = scale(spin, 0.82);
      bounces++;
    }
    if (y > limitY || y < -limitY) {
      y = Math.sign(y) * (2 * limitY - Math.abs(y));
      velocity = vec3(velocity.x, -velocity.y, velocity.z);
      spin = scale(spin, 0.82);
      bounces++;
    }

    position = vec3(x, y, nextZ);
    time += dt;

    if (Math.abs(position.z) > arena.halfDepth + rules.ball.radius * 2) return null;
  }

  return null;
};
