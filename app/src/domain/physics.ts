import type { Arena, Side } from './arena';
import { paddlePlaneZ, sideSign } from './arena';
import type { BallState, PaddleIntent, PaddleState } from './entities';
import type { DomainEvent } from './events';
import type { BallRules, MatchRules, PaddleRules } from './rules';
import type { Vec3 } from './math/vec3';
import { clamp, cross, length, normalize, scale, vec3 } from './math/vec3';

/**
 * Deterministic, allocation-conscious physics for the 3D arena.
 *
 * The step is *continuous*: instead of moving the ball and then asking "am I
 * inside something?", we solve the time-of-impact against every plane and
 * advance only up to the first contact. At the speeds this game reaches
 * (>60 u/s against a 0.35-thick paddle) discrete detection tunnels through the
 * paddle several times per rally — this is the single most important correctness
 * property of the engine, and it is covered by property-based tests.
 */

/** Maximum contacts resolved within one fixed step before we give up. */
const MAX_SUBSTEPS = 8;
const EPSILON = 1e-9;

/** Extra reach beyond the paddle rectangle, in units — a small mercy margin. */
const PADDLE_FORGIVENESS = 0.35;

export interface PaddleBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Travel limits for a paddle centre, so the paddle never leaves the arena. */
export const paddleBounds = (arena: Arena, rules: PaddleRules): PaddleBounds => ({
  minX: -(arena.halfWidth - rules.halfWidth),
  maxX: arena.halfWidth - rules.halfWidth,
  minY: -(arena.halfHeight - rules.halfHeight),
  maxY: arena.halfHeight - rules.halfHeight,
});

/**
 * Integrates a paddle towards its intent with acceleration, damping and hard
 * clamping at the arena walls. Hitting a wall kills the velocity on that axis so
 * momentum cannot be "stored" against the boundary.
 */
export const advancePaddle = (
  arena: Arena,
  rules: PaddleRules,
  paddle: PaddleState,
  intent: PaddleIntent,
  dt: number,
): PaddleState => {
  const bounds = paddleBounds(arena, rules);
  const ix = clamp(intent.x, -1, 1);
  const iy = clamp(intent.y, -1, 1);

  const approach = (v: number, target: number, active: boolean): number => {
    if (!active) return v * Math.exp(-rules.damping * dt);
    const delta = target - v;
    const maxDelta = rules.acceleration * dt;
    return v + clamp(delta, -maxDelta, maxDelta);
  };

  let vx = approach(paddle.vx, ix * rules.maxSpeed, Math.abs(ix) > 1e-4);
  let vy = approach(paddle.vy, iy * rules.maxSpeed, Math.abs(iy) > 1e-4);

  let x = paddle.x + vx * dt;
  let y = paddle.y + vy * dt;

  if (x <= bounds.minX) {
    x = bounds.minX;
    vx = Math.max(vx, 0);
  } else if (x >= bounds.maxX) {
    x = bounds.maxX;
    vx = Math.min(vx, 0);
  }
  if (y <= bounds.minY) {
    y = bounds.minY;
    vy = Math.max(vy, 0);
  } else if (y >= bounds.maxY) {
    y = bounds.maxY;
    vy = Math.min(vy, 0);
  }

  return { side: paddle.side, x, y, vx, vy };
};

/** The `z` at which the ball's surface touches a paddle's face. */
export const contactPlaneZ = (arena: Arena, rules: MatchRules, side: Side): number => {
  const plane = paddlePlaneZ(arena) - rules.paddle.thickness / 2 - rules.ball.radius;
  return sideSign(side) * plane;
};

/**
 * Enforces a minimum share of speed on the `z` axis. Without it, a grazing
 * return can leave the ball drifting almost parallel to the goal line, which
 * reads as a frozen game.
 */
const enforceAxialSpeed = (dir: Vec3, rules: BallRules, towardsSign: number): Vec3 => {
  const unit = normalize(dir);
  const minZ = rules.minAxialFraction;
  if (Math.abs(unit.z) >= minZ) {
    return unit.z * towardsSign > 0 ? unit : vec3(unit.x, unit.y, -unit.z);
  }
  const lateralSq = unit.x * unit.x + unit.y * unit.y;
  const targetLateral = Math.sqrt(Math.max(0, 1 - minZ * minZ));
  const k = lateralSq > EPSILON ? targetLateral / Math.sqrt(lateralSq) : 0;
  return vec3(unit.x * k, unit.y * k, minZ * towardsSign);
};

/** True when the ball centre is within the paddle rectangle at contact time. */
const withinPaddle = (
  paddle: PaddleState,
  rules: MatchRules,
  x: number,
  y: number,
): { hit: boolean; distance: number } => {
  const reachX = rules.paddle.halfWidth + PADDLE_FORGIVENESS;
  const reachY = rules.paddle.halfHeight + PADDLE_FORGIVENESS;
  const dx = Math.abs(x - paddle.x) - reachX;
  const dy = Math.abs(y - paddle.y) - reachY;
  const distance = Math.max(dx, dy);
  return { hit: distance <= 0, distance: Math.max(0, distance) };
};

/** Ball state plus everything the caller needs to know about the step. */
export interface BallStepResult {
  readonly ball: BallState;
  readonly events: readonly DomainEvent[];
  /** Set when the ball crossed a goal plane; names the side that conceded. */
  readonly conceded: Side | null;
  /** Number of paddle returns produced by this step (0 or 1). */
  readonly returns: number;
}

/**
 * Advances the ball by `dt` seconds, resolving every wall and paddle contact in
 * chronological order.
 *
 * `rally` is passed in only so the emitted `paddle-hit` event can report it.
 */
export const advanceBall = (
  arena: Arena,
  rules: MatchRules,
  ball: BallState,
  paddles: Readonly<Record<Side, PaddleState>>,
  dt: number,
  rally: number,
): BallStepResult => {
  const ballRules = rules.ball;
  const events: DomainEvent[] = [];

  // --- Magnus force + spin decay (semi-implicit Euler) ---------------------
  const magnus = scale(cross(ball.spin, ball.velocity), ballRules.spinForce);
  let velocity = vec3(
    ball.velocity.x + magnus.x * dt,
    ball.velocity.y + magnus.y * dt,
    ball.velocity.z + magnus.z * dt,
  );
  const speedNow = length(velocity);
  if (speedNow > ballRules.maxSpeed) velocity = scale(velocity, ballRules.maxSpeed / speedNow);
  const spinDecayFactor = Math.exp(-ballRules.spinDecay * dt);
  let spin = scale(ball.spin, spinDecayFactor);

  let position = ball.position;
  let remaining = dt;
  let conceded: Side | null = null;
  let returns = 0;
  const resolvedPaddles = new Set<Side>();

  const limitX = arena.halfWidth - ballRules.radius;
  const limitY = arena.halfHeight - ballRules.radius;

  for (let step = 0; step < MAX_SUBSTEPS && remaining > EPSILON; step++) {
    let bestT = remaining;
    let bestKind: 'wall-x' | 'wall-y' | 'paddle' | null = null;
    let bestSide: Side | null = null;

    // Axis-aligned wall time-of-impact.
    const wallToi = (p: number, v: number, limit: number): number | null => {
      if (v > EPSILON) return (limit - p) / v;
      if (v < -EPSILON) return (-limit - p) / v;
      return null;
    };

    const tx = wallToi(position.x, velocity.x, limitX);
    if (tx !== null && tx >= 0 && tx < bestT) {
      bestT = tx;
      bestKind = 'wall-x';
    }
    const ty = wallToi(position.y, velocity.y, limitY);
    if (ty !== null && ty >= 0 && ty < bestT) {
      bestT = ty;
      bestKind = 'wall-y';
    }

    // Paddle planes.
    for (const side of ['near', 'far'] as const) {
      if (resolvedPaddles.has(side)) continue;
      const planeZ = contactPlaneZ(arena, rules, side);
      const towards = sideSign(side);
      if (velocity.z * towards <= EPSILON) continue;
      const t = (planeZ - position.z) / velocity.z;
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestKind = 'paddle';
        bestSide = side;
      }
    }

    // Advance to the first contact (or to the end of the step).
    position = vec3(
      position.x + velocity.x * bestT,
      position.y + velocity.y * bestT,
      position.z + velocity.z * bestT,
    );
    remaining -= bestT;

    if (bestKind === null) break;

    if (bestKind === 'wall-x' || bestKind === 'wall-y') {
      const axis = bestKind === 'wall-x' ? 'x' : 'y';
      const speed = length(velocity);
      const component = axis === 'x' ? velocity.x : velocity.y;
      velocity =
        axis === 'x'
          ? vec3(-velocity.x, velocity.y, velocity.z)
          : vec3(velocity.x, -velocity.y, velocity.z);
      // A wall scrubs a little spin off the ball.
      spin = scale(spin, 0.82);
      events.push({
        type: 'wall-bounce',
        axis,
        position,
        intensity: speed > EPSILON ? Math.min(1, Math.abs(component) / speed) : 0,
      });
      continue;
    }

    // --- Paddle plane -----------------------------------------------------
    const side = bestSide as Side;
    resolvedPaddles.add(side);
    const paddle = paddles[side];
    const { hit, distance } = withinPaddle(paddle, rules, position.x, position.y);

    if (!hit) {
      events.push({ type: 'paddle-miss', side, position, distance });
      continue;
    }

    returns += 1;
    const speedBefore = length(velocity);
    const newSpeed = Math.min(speedBefore * ballRules.rallyGain, ballRules.maxSpeed);
    const offX = clamp((position.x - paddle.x) / rules.paddle.halfWidth, -1, 1);
    const offY = clamp((position.y - paddle.y) / rules.paddle.halfHeight, -1, 1);

    const deflected = vec3(
      velocity.x + offX * ballRules.deflection * speedBefore + paddle.vx * ballRules.paddleVelocityTransfer,
      velocity.y + offY * ballRules.deflection * speedBefore + paddle.vy * ballRules.paddleVelocityTransfer,
      -velocity.z,
    );
    // The ball must now travel away from the paddle it just touched.
    const awaySign = -sideSign(side);
    velocity = scale(enforceAxialSpeed(deflected, ballRules, awaySign), newSpeed);

    // Paddle surface velocity imparts spin (ω = n × v_paddle).
    const normal = vec3(0, 0, -sideSign(side));
    const paddleVelocity = vec3(paddle.vx, paddle.vy, 0);
    const impartedSpin = scale(cross(normal, paddleVelocity), ballRules.spinTransfer);
    spin = vec3(spin.x + impartedSpin.x, spin.y + impartedSpin.y, spin.z + impartedSpin.z);
    const spinLength = length(spin);
    const maxSpin = 4;
    if (spinLength > maxSpin) spin = scale(spin, maxSpin / spinLength);

    // Nudge the ball off the contact plane so the next substep starts cleanly.
    position = vec3(position.x, position.y, position.z + awaySign * 1e-4);

    events.push({
      type: 'paddle-hit',
      side,
      position,
      offset: { x: offX, y: offY },
      speed: newSpeed,
      rally: rally + 1,
      edge: Math.max(Math.abs(offX), Math.abs(offY)) > 0.85,
    });
  }

  // Numerical guard: the analytic solve keeps us inside, but floating point can
  // leave the ball a fraction of a unit outside after many reflections.
  position = vec3(
    clamp(position.x, -limitX, limitX),
    clamp(position.y, -limitY, limitY),
    position.z,
  );

  const goalLine = arena.halfDepth + ballRules.radius;
  if (position.z <= -goalLine) conceded = 'near';
  else if (position.z >= goalLine) conceded = 'far';

  return { ball: { position, velocity, spin }, events, conceded, returns };
};
