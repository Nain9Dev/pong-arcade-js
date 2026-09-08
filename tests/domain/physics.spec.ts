import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Side } from '../../app/src/domain/arena';
import { sideSign } from '../../app/src/domain/arena';
import type { BallState, PaddleState } from '../../app/src/domain/entities';
import type { DomainEvent, PaddleHitEvent } from '../../app/src/domain/events';
import { isFinite3, vec3, ZERO } from '../../app/src/domain/math/vec3';
import { advanceBall, advancePaddle, contactPlaneZ, paddleBounds } from '../../app/src/domain/physics';
import { FIXED_TIMESTEP } from '../../app/src/domain/rules';
import {
  ARENA,
  BALL_LIMIT_X,
  BALL_LIMIT_Y,
  ballArb,
  paddleArb,
  PADDLE_BOUNDS,
  RULES,
  speed,
  stillPaddle,
} from '../support/fixtures';

const RUNS = { numRuns: 200, seed: 0x9a11 } as const;
const SIDES = ['near', 'far'] as const;
const BALL = RULES.ball;

const clampTo = (value: number, limit: number): number => Math.min(limit, Math.max(-limit, value));

const hits = (events: readonly DomainEvent[]): PaddleHitEvent[] =>
  events.filter((event): event is PaddleHitEvent => event.type === 'paddle-hit');

const countOf = (events: readonly DomainEvent[], type: DomainEvent['type']): number =>
  events.filter((event) => event.type === type).length;

/**
 * A ball flying dead straight at a paddle, positioned so that the contact plane
 * falls strictly inside a single fixed timestep — the exact configuration a
 * discrete collision test would tunnel through.
 */
interface HeadOn {
  readonly side: Side;
  readonly ball: BallState;
  readonly paddles: Readonly<Record<Side, PaddleState>>;
  readonly approachSpeed: number;
}

const headOnArb = (minSpeed: number, maxSpeed: number, movingPaddle: boolean) =>
  fc
    .tuple(
      fc.constantFrom<Side>(...SIDES),
      fc.double({ min: PADDLE_BOUNDS.minX, max: PADDLE_BOUNDS.maxX, noNaN: true }),
      fc.double({ min: PADDLE_BOUNDS.minY, max: PADDLE_BOUNDS.maxY, noNaN: true }),
      fc.double({ min: -RULES.paddle.halfWidth, max: RULES.paddle.halfWidth, noNaN: true }),
      fc.double({ min: -RULES.paddle.halfHeight, max: RULES.paddle.halfHeight, noNaN: true }),
      fc.double({ min: minSpeed, max: maxSpeed, noNaN: true }),
      fc.double({ min: 0.05, max: 0.95, noNaN: true }),
      fc.double({ min: -RULES.paddle.maxSpeed, max: RULES.paddle.maxSpeed, noNaN: true }),
      fc.double({ min: -RULES.paddle.maxSpeed, max: RULES.paddle.maxSpeed, noNaN: true }),
    )
    .map(([side, px, py, offX, offY, approachSpeed, fraction, pvx, pvy]): HeadOn => {
      const towards = sideSign(side);
      const planeZ = contactPlaneZ(ARENA, RULES, side);
      const travel = approachSpeed * FIXED_TIMESTEP * fraction;
      const ball: BallState = {
        position: vec3(
          clampTo(px + offX, BALL_LIMIT_X),
          clampTo(py + offY, BALL_LIMIT_Y),
          planeZ - towards * travel,
        ),
        velocity: vec3(0, 0, towards * approachSpeed),
        spin: ZERO,
      };
      const defender: PaddleState = {
        side,
        x: px,
        y: py,
        vx: movingPaddle ? pvx : 0,
        vy: movingPaddle ? pvy : 0,
      };
      const paddles =
        side === 'near'
          ? { near: defender, far: stillPaddle('far') }
          : { near: stillPaddle('near'), far: defender };
      return { side, ball, paddles, approachSpeed };
    });

describe('advanceBall containment', () => {
  it('never leaves the arena on x/y, whatever the state and step size', () => {
    fc.assert(
      fc.property(
        ballArb({ maxSpin: 3 }),
        paddleArb('near'),
        paddleArb('far'),
        fc.double({ min: 1e-4, max: 0.05, noNaN: true }),
        (ball, near, far, dt) => {
          const result = advanceBall(ARENA, RULES, ball, { near, far }, dt, 0);
          expect(Math.abs(result.ball.position.x)).toBeLessThanOrEqual(BALL_LIMIT_X + 1e-9);
          expect(Math.abs(result.ball.position.y)).toBeLessThanOrEqual(BALL_LIMIT_Y + 1e-9);
        },
      ),
      RUNS,
    );
  });

  it('keeps every component finite and the speed capped', () => {
    fc.assert(
      fc.property(
        ballArb({ maxSpin: 3 }),
        paddleArb('near'),
        paddleArb('far'),
        fc.double({ min: 1e-4, max: 0.05, noNaN: true }),
        (ball, near, far, dt) => {
          const result = advanceBall(ARENA, RULES, ball, { near, far }, dt, 0);
          expect(isFinite3(result.ball.position)).toBe(true);
          expect(isFinite3(result.ball.velocity)).toBe(true);
          expect(isFinite3(result.ball.spin)).toBe(true);
          expect(speed(result.ball.velocity)).toBeLessThanOrEqual(BALL.maxSpeed + 1e-6);
        },
      ),
      RUNS,
    );
  });

  it('stays inside across a long unattended simulation', () => {
    let ball: BallState = {
      position: ZERO,
      velocity: vec3(6, 4, BALL.maxSpeed),
      spin: vec3(0.4, -0.7, 0.2),
    };
    const paddles = { near: stillPaddle('near'), far: stillPaddle('far') };

    for (let i = 0; i < 4000; i++) {
      const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
      ball = result.ball;
      expect(Math.abs(ball.position.x)).toBeLessThanOrEqual(BALL_LIMIT_X + 1e-9);
      expect(Math.abs(ball.position.y)).toBeLessThanOrEqual(BALL_LIMIT_Y + 1e-9);
      if (result.conceded !== null) {
        // Reflect the ball back into play and keep hammering the walls.
        ball = { ...ball, position: ZERO, velocity: vec3(-ball.velocity.x, -ball.velocity.y, -ball.velocity.z) };
      }
    }
  });
});

describe('advanceBall paddle collision', () => {
  it('never tunnels through a covering paddle in a single fixed step', () => {
    fc.assert(
      fc.property(headOnArb(BALL.serveSpeed, BALL.maxSpeed, false), ({ side, ball, paddles }) => {
        const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);

        expect(hits(result.events)).toHaveLength(1);
        expect(countOf(result.events, 'paddle-miss')).toBe(0);
        expect(result.returns).toBe(1);
        expect(result.conceded).toBeNull();

        // The return must send the ball back towards the middle of the arena.
        expect(Math.sign(result.ball.velocity.z)).toBe(-sideSign(side));
        expect(Math.sign(ball.velocity.z)).toBe(sideSign(side));
      }),
      RUNS,
    );
  });

  it('never tunnels at the maximum speed, including grazing contacts', () => {
    fc.assert(
      fc.property(headOnArb(BALL.maxSpeed, BALL.maxSpeed, true), ({ side, ball, paddles }) => {
        const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
        expect(hits(result.events)).toHaveLength(1);
        expect(Math.sign(result.ball.velocity.z)).toBe(-sideSign(side));
      }),
      RUNS,
    );
  });

  it('reports the contact offset and the rally counter', () => {
    fc.assert(
      fc.property(
        headOnArb(BALL.serveSpeed, BALL.maxSpeed, false),
        fc.integer({ min: 0, max: 40 }),
        ({ side, ball, paddles }, rally) => {
          const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, rally);
          const hit = hits(result.events)[0];
          expect(hit).toBeDefined();
          if (hit === undefined) return;

          expect(hit.side).toBe(side);
          expect(hit.rally).toBe(rally + 1);
          expect(Math.abs(hit.offset.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(hit.offset.y)).toBeLessThanOrEqual(1);
          expect(hit.edge).toBe(Math.max(Math.abs(hit.offset.x), Math.abs(hit.offset.y)) > 0.85);
        },
      ),
      RUNS,
    );
  });

  it('gains speed by exactly rallyGain, saturating at maxSpeed', () => {
    fc.assert(
      fc.property(headOnArb(4, BALL.maxSpeed, true), ({ ball, paddles, approachSpeed }) => {
        const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
        const expected = Math.min(approachSpeed * BALL.rallyGain, BALL.maxSpeed);
        const hit = hits(result.events)[0];
        expect(hit).toBeDefined();
        if (hit === undefined) return;

        expect(hit.speed).toBeCloseTo(expected, 6);
        // Any wall bounce inside the same step must not alter the speed either.
        expect(speed(result.ball.velocity)).toBeCloseTo(expected, 6);
      }),
      RUNS,
    );
  });

  it('keeps the minimum axial fraction after every return', () => {
    fc.assert(
      fc.property(headOnArb(4, BALL.maxSpeed, true), ({ ball, paddles }) => {
        const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
        expect(hits(result.events)).toHaveLength(1);

        const v = result.ball.velocity;
        const total = speed(v);
        expect(total).toBeGreaterThan(0);
        expect(Math.abs(v.z) / total).toBeGreaterThanOrEqual(BALL.minAxialFraction - 1e-9);
      }),
      RUNS,
    );
  });

  it('resolves at most one contact per paddle per step', () => {
    fc.assert(
      fc.property(headOnArb(BALL.serveSpeed, BALL.maxSpeed, true), ({ side, ball, paddles }) => {
        // A generous step gives the ball time to reach the far plane as well;
        // neither paddle may be resolved twice.
        const result = advanceBall(ARENA, RULES, ball, paddles, 0.5, 0);
        const perSide = hits(result.events).filter((hit) => hit.side === side);
        expect(perSide.length).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });
});

describe('advanceBall paddle miss', () => {
  /** A ball aimed at the paddle plane but laterally out of the paddle's reach. */
  const missArb = fc
    .tuple(
      fc.constantFrom<Side>(...SIDES),
      fc.double({ min: PADDLE_BOUNDS.minX, max: PADDLE_BOUNDS.maxX, noNaN: true }),
      fc.double({ min: PADDLE_BOUNDS.minY, max: PADDLE_BOUNDS.maxY, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: BALL.serveSpeed, max: BALL.maxSpeed, noNaN: true }),
      fc.double({ min: 0.05, max: 0.95, noNaN: true }),
    )
    .map(([side, px, py, spread, approachSpeed, fraction]): HeadOn => {
      // The gap must exceed the paddle half-width plus the (private) forgiveness
      // margin. Escaping towards the far wall keeps the choice always feasible.
      const clearance = RULES.paddle.halfWidth + 1;
      const ballX =
        px > 0
          ? -BALL_LIMIT_X + spread * (px - clearance + BALL_LIMIT_X)
          : px + clearance + spread * (BALL_LIMIT_X - px - clearance);
      const towards = sideSign(side);
      const planeZ = contactPlaneZ(ARENA, RULES, side);
      const defender = stillPaddle(side, px, py);
      return {
        side,
        approachSpeed,
        ball: {
          position: vec3(ballX, py, planeZ - towards * approachSpeed * FIXED_TIMESTEP * fraction),
          velocity: vec3(0, 0, towards * approachSpeed),
          spin: ZERO,
        },
        paddles:
          side === 'near'
            ? { near: defender, far: stillPaddle('far') }
            : { near: stillPaddle('near'), far: defender },
      };
    });

  it('emits a single paddle-miss and concedes the point to the other side', () => {
    fc.assert(
      fc.property(missArb, ({ side, ball, paddles }) => {
        let state = ball;
        let misses = 0;
        let conceded: Side | null = null;

        for (let i = 0; i < 400 && conceded === null; i++) {
          const result = advanceBall(ARENA, RULES, state, paddles, FIXED_TIMESTEP, 0);
          state = result.ball;
          misses += countOf(result.events, 'paddle-miss');
          expect(countOf(result.events, 'paddle-hit')).toBe(0);
          conceded = result.conceded;
        }

        expect(conceded).toBe(side);
        expect(misses).toBe(1);
      }),
      { ...RUNS, numRuns: 120 },
    );
  });

  it('reports how far outside the paddle the ball passed', () => {
    const paddles = { near: stillPaddle('near'), far: stillPaddle('far') };
    const planeZ = contactPlaneZ(ARENA, RULES, 'far');
    const missAt = (x: number): number => {
      const ball: BallState = { position: vec3(x, 0, planeZ - 0.1), velocity: vec3(0, 0, 40), spin: ZERO };
      const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
      const miss = result.events.find((event) => event.type === 'paddle-miss');
      expect(miss?.type).toBe('paddle-miss');
      return miss?.type === 'paddle-miss' ? miss.distance : Number.NaN;
    };

    const near = missAt(7);
    const far = missAt(8);
    expect(near).toBeGreaterThan(0);
    // The reported distance is measured from the paddle edge, so it must track
    // the lateral offset one-for-one whatever the forgiveness margin is.
    expect(far - near).toBeCloseTo(1, 9);
    expect(far).toBeLessThan(8 - RULES.paddle.halfWidth);
  });
});

describe('advanceBall wall bounces', () => {
  /**
   * A ball placed just short of a wall and moving fast enough to reach it inside
   * one fixed step, but too slowly on `z` to interact with a paddle plane.
   */
  const wallBounceArb = fc
    .tuple(
      fc.constantFrom<'x' | 'y'>('x', 'y'),
      fc.boolean(),
      fc.double({ min: 0, max: 0.15, noNaN: true }),
      fc.double({ min: 20, max: 55, noNaN: true }),
      fc.double({ min: -5, max: 5, noNaN: true }),
      fc.double({ min: -10, max: 10, noNaN: true }),
      fc.double({ min: -2, max: 2, noNaN: true }),
    )
    .map(([axis, positive, gap, lateralSpeed, vz, z, other]): BallState => {
      const sign = positive ? 1 : -1;
      const limit = axis === 'x' ? BALL_LIMIT_X : BALL_LIMIT_Y;
      const along = sign * (limit - gap);
      const velocityAlong = sign * lateralSpeed;
      return {
        position: axis === 'x' ? vec3(along, other, z) : vec3(other, along, z),
        velocity: axis === 'x' ? vec3(velocityAlong, 0, vz) : vec3(0, velocityAlong, vz),
        spin: ZERO,
      };
    });

  it('preserves the speed exactly', () => {
    fc.assert(
      fc.property(wallBounceArb, (ball) => {
        const paddles = { near: stillPaddle('near'), far: stillPaddle('far') };
        const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);

        expect(countOf(result.events, 'wall-bounce')).toBeGreaterThan(0);
        expect(countOf(result.events, 'paddle-hit')).toBe(0);
        expect(speed(result.ball.velocity)).toBeCloseTo(speed(ball.velocity), 9);
      }),
      RUNS,
    );
  });

  it('preserves the speed across a burst of reflections', () => {
    fc.assert(
      fc.property(wallBounceArb, fc.double({ min: 0.02, max: 0.2, noNaN: true }), (ball, dt) => {
        const paddles = { near: stillPaddle('near'), far: stillPaddle('far') };
        const result = advanceBall(ARENA, RULES, ball, paddles, dt, 0);
        fc.pre(countOf(result.events, 'paddle-hit') === 0);
        expect(speed(result.ball.velocity)).toBeCloseTo(speed(ball.velocity), 9);
      }),
      RUNS,
    );
  });

  it('reflects the component normal to the wall and reports the intensity', () => {
    const paddles = { near: stillPaddle('near'), far: stillPaddle('far') };
    const ball: BallState = {
      position: vec3(BALL_LIMIT_X - 0.05, 0, 0),
      velocity: vec3(30, 0, 10),
      spin: ZERO,
    };
    const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
    const bounce = result.events.find((event) => event.type === 'wall-bounce');
    expect(bounce).toBeDefined();
    if (bounce?.type !== 'wall-bounce') return;

    expect(bounce.axis).toBe('x');
    expect(result.ball.velocity.x).toBeLessThan(0);
    expect(result.ball.velocity.z).toBeCloseTo(10, 12);
    expect(bounce.intensity).toBeCloseTo(30 / Math.hypot(30, 10), 9);
    expect(bounce.intensity).toBeGreaterThanOrEqual(0);
    expect(bounce.intensity).toBeLessThanOrEqual(1);
  });

  it('bleeds spin on contact', () => {
    const paddles = { near: stillPaddle('near'), far: stillPaddle('far') };
    const ball: BallState = {
      position: vec3(0, BALL_LIMIT_Y - 0.05, 0),
      velocity: vec3(0, 30, 0),
      spin: vec3(0, 0, 2),
    };
    const result = advanceBall(ARENA, RULES, ball, paddles, FIXED_TIMESTEP, 0);
    expect(countOf(result.events, 'wall-bounce')).toBe(1);
    expect(Math.abs(result.ball.spin.z)).toBeLessThan(2);
  });
});

describe('contactPlaneZ', () => {
  it('sits in front of the goal on both sides', () => {
    const far = contactPlaneZ(ARENA, RULES, 'far');
    const near = contactPlaneZ(ARENA, RULES, 'near');
    expect(far).toBeCloseTo(20.4 - RULES.paddle.thickness / 2 - BALL.radius, 12);
    expect(near).toBeCloseTo(-far, 12);
    expect(Math.abs(far)).toBeLessThan(ARENA.halfDepth);
  });
});

describe('advancePaddle', () => {
  const intentArb = fc.record({
    x: fc.double({ min: -2, max: 2, noNaN: true }),
    y: fc.double({ min: -2, max: 2, noNaN: true }),
  });

  it('never leaves paddleBounds', () => {
    fc.assert(
      fc.property(
        paddleArb('near'),
        intentArb,
        fc.double({ min: 1e-4, max: 1 / 30, noNaN: true }),
        (paddle, intent, dt) => {
          const next = advancePaddle(ARENA, RULES.paddle, paddle, intent, dt);
          expect(next.x).toBeGreaterThanOrEqual(PADDLE_BOUNDS.minX);
          expect(next.x).toBeLessThanOrEqual(PADDLE_BOUNDS.maxX);
          expect(next.y).toBeGreaterThanOrEqual(PADDLE_BOUNDS.minY);
          expect(next.y).toBeLessThanOrEqual(PADDLE_BOUNDS.maxY);
          expect(next.side).toBe('near');
        },
      ),
      RUNS,
    );
  });

  it('pulls an out-of-bounds paddle back inside in one step', () => {
    const stray: PaddleState = { side: 'far', x: 50, y: -50, vx: 12, vy: -12 };
    const next = advancePaddle(ARENA, RULES.paddle, stray, { x: 0, y: 0 }, FIXED_TIMESTEP);
    expect(next.x).toBe(PADDLE_BOUNDS.maxX);
    expect(next.y).toBe(PADDLE_BOUNDS.minY);
  });

  it('cannot store momentum against a wall', () => {
    fc.assert(
      fc.property(
        paddleArb('far'),
        intentArb,
        fc.double({ min: 1e-4, max: 1 / 30, noNaN: true }),
        (paddle, intent, dt) => {
          const next = advancePaddle(ARENA, RULES.paddle, paddle, intent, dt);
          if (next.x === PADDLE_BOUNDS.minX) expect(next.vx).toBeGreaterThanOrEqual(0);
          if (next.x === PADDLE_BOUNDS.maxX) expect(next.vx).toBeLessThanOrEqual(0);
          if (next.y === PADDLE_BOUNDS.minY) expect(next.vy).toBeGreaterThanOrEqual(0);
          if (next.y === PADDLE_BOUNDS.maxY) expect(next.vy).toBeLessThanOrEqual(0);
        },
      ),
      RUNS,
    );
  });

  it('zeroes the velocity on the axis it is pressed against', () => {
    let paddle: PaddleState = { side: 'near', x: 0, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 240; i++) {
      paddle = advancePaddle(ARENA, RULES.paddle, paddle, { x: 1, y: -1 }, FIXED_TIMESTEP);
    }
    expect(paddle.x).toBe(PADDLE_BOUNDS.maxX);
    expect(paddle.y).toBe(PADDLE_BOUNDS.minY);
    expect(paddle.vx).toBe(0);
    expect(paddle.vy).toBe(0);
  });

  it('never exceeds the configured maximum speed under sustained input', () => {
    let paddle: PaddleState = { side: 'near', x: 0, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 60; i++) {
      paddle = advancePaddle(ARENA, RULES.paddle, paddle, { x: 4, y: 4 }, FIXED_TIMESTEP);
      // The intent is clamped to [-1, 1] before it becomes a target velocity.
      expect(Math.abs(paddle.vx)).toBeLessThanOrEqual(RULES.paddle.maxSpeed + 1e-9);
      expect(Math.abs(paddle.vy)).toBeLessThanOrEqual(RULES.paddle.maxSpeed + 1e-9);
    }
  });

  it('damps towards zero under a neutral intent', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -RULES.paddle.maxSpeed, max: RULES.paddle.maxSpeed, noNaN: true }),
        fc.double({ min: -RULES.paddle.maxSpeed, max: RULES.paddle.maxSpeed, noNaN: true }),
        (vx, vy) => {
          let paddle: PaddleState = { side: 'near', x: 0, y: 0, vx, vy };
          let previous = Math.hypot(paddle.vx, paddle.vy);

          for (let i = 0; i < 200; i++) {
            paddle = advancePaddle(ARENA, RULES.paddle, paddle, { x: 0, y: 0 }, FIXED_TIMESTEP);
            const current = Math.hypot(paddle.vx, paddle.vy);
            expect(current).toBeLessThanOrEqual(previous + 1e-12);
            previous = current;
          }

          expect(Math.abs(paddle.vx)).toBeLessThan(1e-3);
          expect(Math.abs(paddle.vy)).toBeLessThan(1e-3);
        },
      ),
      { ...RUNS, numRuns: 60 },
    );
  });

  it('ignores dead-zone input below the activation threshold', () => {
    const paddle: PaddleState = { side: 'near', x: 0, y: 0, vx: 10, vy: 0 };
    const next = advancePaddle(ARENA, RULES.paddle, paddle, { x: 1e-5, y: 0 }, FIXED_TIMESTEP);
    // Below 1e-4 the axis is treated as inactive, so damping applies instead.
    expect(next.vx).toBeLessThan(10);
  });
});

describe('paddleBounds', () => {
  it('keeps the whole paddle inside the arena', () => {
    const bounds = paddleBounds(ARENA, RULES.paddle);
    expect(bounds.maxX + RULES.paddle.halfWidth).toBeCloseTo(ARENA.halfWidth, 12);
    expect(bounds.maxY + RULES.paddle.halfHeight).toBeCloseTo(ARENA.halfHeight, 12);
    expect(bounds.minX).toBe(-bounds.maxX);
    expect(bounds.minY).toBe(-bounds.maxY);
  });
});
