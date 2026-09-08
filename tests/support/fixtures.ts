import fc from 'fast-check';
import type { Arena } from '../../app/src/domain/arena';
import { DEFAULT_ARENA } from '../../app/src/domain/arena';
import type { BallState, PaddleState } from '../../app/src/domain/entities';
import type { Vec3 } from '../../app/src/domain/math/vec3';
import { vec3, ZERO } from '../../app/src/domain/math/vec3';
import { paddleBounds } from '../../app/src/domain/physics';
import type { MatchRules, PaddleRules } from '../../app/src/domain/rules';
import { DEFAULT_MATCH_RULES, DEFAULT_PADDLE_RULES } from '../../app/src/domain/rules';

export const ARENA: Arena = DEFAULT_ARENA;
export const RULES: MatchRules = DEFAULT_MATCH_RULES;

/** Half-extents the ball *centre* can reach before the physics reflects it. */
export const BALL_LIMIT_X = ARENA.halfWidth - RULES.ball.radius;
export const BALL_LIMIT_Y = ARENA.halfHeight - RULES.ball.radius;

export const PADDLE_BOUNDS = paddleBounds(ARENA, RULES.paddle);

/**
 * Paddles small enough that a serve from the centre can never reach them once
 * they are parked in a corner, and quick enough to get there during the serve
 * delay. Lets scoring scenarios be driven without having to guess which way a
 * seeded serve will curve, and keeps them independent of gameplay tuning.
 */
const TINY_PADDLE_RULES: PaddleRules = {
  ...DEFAULT_PADDLE_RULES,
  halfWidth: 0.35,
  halfHeight: 0.35,
  maxSpeed: 26,
  acceleration: 150,
};

export const MISSABLE_RULES: MatchRules = { ...RULES, paddle: TINY_PADDLE_RULES };

export const finite = (bound: number): fc.Arbitrary<number> =>
  fc.double({ min: -bound, max: bound, noNaN: true });

export const vec3Arb = (bound: number): fc.Arbitrary<Vec3> =>
  fc.tuple(finite(bound), finite(bound), finite(bound)).map(([x, y, z]) => vec3(x, y, z));

/** A ball anywhere inside the arena, with a physically reachable velocity. */
export const ballArb = (options: { readonly maxSpin?: number } = {}): fc.Arbitrary<BallState> => {
  const maxSpin = options.maxSpin ?? 0;
  const spin = maxSpin === 0 ? fc.constant(ZERO) : vec3Arb(maxSpin);
  return fc
    .tuple(
      fc.double({ min: -BALL_LIMIT_X, max: BALL_LIMIT_X, noNaN: true }),
      fc.double({ min: -BALL_LIMIT_Y, max: BALL_LIMIT_Y, noNaN: true }),
      fc.double({ min: -ARENA.halfDepth, max: ARENA.halfDepth, noNaN: true }),
      vec3Arb(1),
      fc.double({ min: 1, max: RULES.ball.maxSpeed, noNaN: true }),
      spin,
    )
    .map(([x, y, z, direction, speed, spinValue]) => {
      const len = Math.hypot(direction.x, direction.y, direction.z);
      const unit = len > 1e-6 ? vec3(direction.x / len, direction.y / len, direction.z / len) : vec3(0, 0, 1);
      return {
        position: vec3(x, y, z),
        velocity: vec3(unit.x * speed, unit.y * speed, unit.z * speed),
        spin: spinValue,
      };
    });
};

export const paddleArb = (side: PaddleState['side']): fc.Arbitrary<PaddleState> =>
  fc
    .tuple(
      fc.double({ min: PADDLE_BOUNDS.minX, max: PADDLE_BOUNDS.maxX, noNaN: true }),
      fc.double({ min: PADDLE_BOUNDS.minY, max: PADDLE_BOUNDS.maxY, noNaN: true }),
      finite(RULES.paddle.maxSpeed),
      finite(RULES.paddle.maxSpeed),
    )
    .map(([x, y, vx, vy]) => ({ side, x, y, vx, vy }));

export const stillPaddle = (side: PaddleState['side'], x = 0, y = 0): PaddleState => ({
  side,
  x,
  y,
  vx: 0,
  vy: 0,
});

export const speed = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
