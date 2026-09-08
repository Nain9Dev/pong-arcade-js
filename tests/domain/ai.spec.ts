import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Side } from '../../app/src/domain/arena';
import type { AiProfile } from '../../app/src/domain/ai/difficulty';
import { AI_PROFILES, DIFFICULTY_ORDER } from '../../app/src/domain/ai/difficulty';
import { AiOpponent } from '../../app/src/domain/ai/opponent';
import { predictIntercept } from '../../app/src/domain/ai/predictor';
import type { BallState, PaddleIntent } from '../../app/src/domain/entities';
import { Match } from '../../app/src/domain/match';
import { vec3, ZERO } from '../../app/src/domain/math/vec3';
import { contactPlaneZ } from '../../app/src/domain/physics';
import { createRng } from '../../app/src/domain/rng';
import type { MatchRules } from '../../app/src/domain/rules';
import { FIXED_TIMESTEP } from '../../app/src/domain/rules';
import { ARENA, ballArb, PADDLE_BOUNDS, RULES } from '../support/fixtures';

const RUNS = { numRuns: 200, seed: 0xa11ce } as const;

/**
 * The predictor integrates at 1/120 s and solves the plane crossing from the
 * start of the sub-step it happens in, so the reported intercept can sit up to
 * one sub-step of lateral travel beyond the wall the ball is about to hit.
 */
const PREDICT_STEP = 1 / 120;
const LOOKAHEAD_SLACK = RULES.ball.maxSpeed * PREDICT_STEP;

const FAR_PLANE = contactPlaneZ(ARENA, RULES, 'far');
const NEAR_PLANE = contactPlaneZ(ARENA, RULES, 'near');

describe('predictIntercept analytic accuracy', () => {
  it('matches the closed-form answer on a straight, spin-free path', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -4, max: 4, noNaN: true }),
        fc.double({ min: -4, max: 4, noNaN: true }),
        fc.double({ min: 20, max: 60, noNaN: true }),
        fc.double({ min: -0.1, max: 0.1, noNaN: true }),
        fc.double({ min: -0.02, max: 0.02, noNaN: true }),
        (x0, y0, vz, slopeX, slopeY) => {
          const ball: BallState = {
            position: vec3(x0, y0, NEAR_PLANE),
            velocity: vec3(vz * slopeX, vz * slopeY, vz),
            spin: ZERO,
          };
          const intercept = predictIntercept(ARENA, RULES, ball, 'far', 5);
          expect(intercept).not.toBeNull();
          if (intercept === null) return;

          const time = (FAR_PLANE - NEAR_PLANE) / vz;
          expect(intercept.time).toBeCloseTo(time, 3);
          expect(intercept.x).toBeCloseTo(x0 + ball.velocity.x * time, 3);
          expect(intercept.y).toBeCloseTo(y0 + ball.velocity.y * time, 3);
          expect(intercept.bounces).toBe(0);
        },
      ),
      RUNS,
    );
  });

  it('mirrors correctly for the near side', () => {
    const ball: BallState = {
      position: vec3(1, -0.5, FAR_PLANE),
      velocity: vec3(2, 1, -30),
      spin: ZERO,
    };
    const intercept = predictIntercept(ARENA, RULES, ball, 'near', 5);
    expect(intercept).not.toBeNull();
    if (intercept === null) return;

    const time = (NEAR_PLANE - FAR_PLANE) / -30;
    expect(intercept.time).toBeCloseTo(time, 3);
    expect(intercept.x).toBeCloseTo(1 + 2 * time, 3);
    expect(intercept.y).toBeCloseTo(-0.5 + 1 * time, 3);
  });

  it('counts the wall reflections on the way', () => {
    // Aimed hard at the +x wall: the ball must rebound before reaching the plane.
    const ball: BallState = {
      position: vec3(0, 0, NEAR_PLANE),
      velocity: vec3(30, 0, 25),
      spin: ZERO,
    };
    const intercept = predictIntercept(ARENA, RULES, ball, 'far', 5);
    expect(intercept).not.toBeNull();
    expect(intercept?.bounces).toBeGreaterThan(0);
  });
});

describe('predictIntercept rejections', () => {
  it('returns null when the ball travels away from that side', () => {
    fc.assert(
      fc.property(ballArb(), fc.constantFrom<Side>('near', 'far'), (ball, side) => {
        const towards = side === 'far' ? 1 : -1;
        fc.pre(ball.velocity.z * towards <= 0);
        expect(predictIntercept(ARENA, RULES, ball, side, 4)).toBeNull();
      }),
      RUNS,
    );
  });

  it('returns null for a ball frozen on the z axis', () => {
    const ball: BallState = { position: ZERO, velocity: vec3(10, 5, 0), spin: ZERO };
    expect(predictIntercept(ARENA, RULES, ball, 'far')).toBeNull();
    expect(predictIntercept(ARENA, RULES, ball, 'near')).toBeNull();
  });

  it('returns null when the arrival falls beyond the horizon', () => {
    const ball: BallState = { position: vec3(0, 0, NEAR_PLANE), velocity: vec3(0, 0, 22), spin: ZERO };
    expect(predictIntercept(ARENA, RULES, ball, 'far', 0.25)).toBeNull();
    expect(predictIntercept(ARENA, RULES, ball, 'far', 5)).not.toBeNull();
  });
});

describe('predictIntercept containment', () => {
  it('always lands inside the arena cross-section', () => {
    fc.assert(
      fc.property(ballArb({ maxSpin: 2 }), fc.constantFrom<Side>('near', 'far'), (ball, side) => {
        // Only ask about balls that have not already crossed the plane: see the
        // `it.fails` case below for what happens when they have.
        const plane = side === 'far' ? FAR_PLANE : NEAR_PLANE;
        fc.pre(side === 'far' ? ball.position.z < plane : ball.position.z > plane);

        const intercept = predictIntercept(ARENA, RULES, ball, side, 4);
        fc.pre(intercept !== null);
        if (intercept === null) return;

        expect(Number.isFinite(intercept.x)).toBe(true);
        expect(Number.isFinite(intercept.y)).toBe(true);
        expect(Math.abs(intercept.x)).toBeLessThanOrEqual(ARENA.halfWidth + LOOKAHEAD_SLACK);
        expect(Math.abs(intercept.y)).toBeLessThanOrEqual(ARENA.halfHeight + LOOKAHEAD_SLACK);
        expect(intercept.time).toBeGreaterThanOrEqual(0);
        expect(intercept.time).toBeLessThanOrEqual(4);
        expect(intercept.bounces).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  /**
   * KNOWN DEFECT (reported to the lead, src/domain/ai/predictor.ts:70-79).
   *
   * A ball that has already flown past the paddle plane still satisfies the
   * `crosses` test, so the solver extrapolates *backwards*: it answers with a
   * negative `time` and a point far outside the arena. Marked `it.fails` so the
   * suite stays green while the behaviour is pinned.
   */
  it.fails('does not extrapolate backwards once the ball is past the plane', () => {
    const ball: BallState = {
      position: vec3(0, 0, FAR_PLANE + 2),
      velocity: vec3(50, 0, 5),
      spin: ZERO,
    };
    const intercept = predictIntercept(ARENA, RULES, ball, 'far', 4);
    if (intercept === null) return;
    expect(intercept.time).toBeGreaterThanOrEqual(0);
    expect(Math.abs(intercept.x)).toBeLessThanOrEqual(ARENA.halfWidth + LOOKAHEAD_SLACK);
  });
});

describe('AiOpponent', () => {
  const profileArb = fc.constantFrom(...DIFFICULTY_ORDER).map((id) => AI_PROFILES[id]);

  it('emits intents bounded by the profile speed factor', () => {
    fc.assert(
      fc.property(profileArb, ballArb({ maxSpin: 1 }), fc.integer({ min: 1, max: 30 }), (profile, ball, ticks) => {
        const opponent = new AiOpponent('far', ARENA, RULES, profile, createRng(17));
        let paddle = { side: 'far' as const, x: 0, y: 0, vx: 0, vy: 0 };

        for (let i = 0; i < ticks; i++) {
          const intent: PaddleIntent = opponent.intent(ball, paddle, FIXED_TIMESTEP);
          expect(Math.abs(intent.x)).toBeLessThanOrEqual(profile.speedFactor + 1e-12);
          expect(Math.abs(intent.y)).toBeLessThanOrEqual(profile.speedFactor + 1e-12);
          expect(Number.isFinite(intent.x)).toBe(true);
          expect(Number.isFinite(intent.y)).toBe(true);
          paddle = { ...paddle, x: paddle.x + intent.x * 0.1, y: paddle.y + intent.y * 0.1 };
        }
      }),
      RUNS,
    );
  });

  it('is deterministic for a given seed and re-plans after setProfile', () => {
    const ball: BallState = { position: ZERO, velocity: vec3(3, 1, 30), spin: ZERO };
    const paddle = { side: 'far' as const, x: 0, y: 0, vx: 0, vy: 0 };

    const sample = (): PaddleIntent[] => {
      const opponent = new AiOpponent('far', ARENA, RULES, AI_PROFILES.pro, createRng(5));
      const out: PaddleIntent[] = [];
      for (let i = 0; i < 40; i++) out.push(opponent.intent(ball, paddle, FIXED_TIMESTEP));
      opponent.setProfile(AI_PROFILES.elite);
      for (let i = 0; i < 40; i++) out.push(opponent.intent(ball, paddle, FIXED_TIMESTEP));
      return out;
    };

    expect(sample()).toEqual(sample());
  });

  it('drifts back towards the centre when the ball is heading away', () => {
    const opponent = new AiOpponent('far', ARENA, RULES, AI_PROFILES.singularity, createRng(9));
    const ball: BallState = { position: vec3(6, 3, 5), velocity: vec3(0, 0, -40), spin: ZERO };
    let paddle = { side: 'far' as const, x: 6.5, y: 3.5, vx: 0, vy: 0 };

    for (let i = 0; i < 400; i++) {
      const intent = opponent.intent(ball, paddle, FIXED_TIMESTEP);
      paddle = { ...paddle, x: paddle.x + intent.x * 0.05, y: paddle.y + intent.y * 0.05 };
    }
    // The defensive rest position is 18% of the ball's offset, not the corner.
    expect(Math.abs(paddle.x)).toBeLessThan(2);
    expect(Math.abs(paddle.y)).toBeLessThan(2);
  });
});

/**
 * A flawless returner used as the opposing wall: it always knows where the ball
 * will arrive and never lapses, so the only variable in the rally is the profile
 * being measured.
 */
const WALL_PROFILE: AiProfile = {
  // Derived from the toughest preset so that tuning knobs added later keep a
  // sensible default here instead of breaking the comparison.
  ...AI_PROFILES.singularity,
  label: 'Wall',
  description: 'Referencia determinista para las pruebas.',
  speedFactor: 1,
  reactionDelay: 0.03,
  aimError: 0,
  horizon: 6,
  anticipation: 1,
  lapseChance: 0,
  aggression: 0,
};

interface RallyStats {
  readonly returns: number;
  readonly conceded: number;
}

/** No target score, so every profile gets the same amount of simulated time. */
const ENDLESS_RULES: MatchRules = { ...RULES, pointsToWin: Number.MAX_SAFE_INTEGER };

const SEEDS = [11, 4242, 7, 99, 20260818] as const;
const SIMULATED_SECONDS = 90;

/** Plays a fixed amount of match time and reports how the far paddle coped. */
const measure = (profile: AiProfile, seed: number): RallyStats => {
  const match = new Match(createRng(seed), { rules: ENDLESS_RULES });
  const wall = new AiOpponent('near', ARENA, ENDLESS_RULES, WALL_PROFILE, createRng(seed + 1));
  const opponent = new AiOpponent('far', ARENA, ENDLESS_RULES, profile, createRng(seed + 2));

  let returns = 0;
  let conceded = 0;
  const steps = Math.round(SIMULATED_SECONDS / FIXED_TIMESTEP);

  for (let i = 0; i < steps; i++) {
    const state = match.state;
    const near = wall.intent(state.ball, state.paddles.near, FIXED_TIMESTEP);
    const far = opponent.intent(state.ball, state.paddles.far, FIXED_TIMESTEP);
    for (const event of match.step(FIXED_TIMESTEP, { near, far })) {
      if (event.type === 'paddle-hit' && event.side === 'far') returns++;
      if (event.type === 'point-scored' && event.conceded === 'far') conceded++;
    }
  }

  return { returns, conceded };
};

const measureAll = (profile: AiProfile): RallyStats =>
  SEEDS.reduce<RallyStats>(
    (total, seed) => {
      const stats = measure(profile, seed);
      return { returns: total.returns + stats.returns, conceded: total.conceded + stats.conceded };
    },
    { returns: 0, conceded: 0 },
  );

describe('difficulty ordering', () => {
  it('singularity returns far more balls than rookie', () => {
    const rookie = measureAll(AI_PROFILES.rookie);
    const pro = measureAll(AI_PROFILES.pro);
    const singularity = measureAll(AI_PROFILES.singularity);

    expect(rookie.returns).toBeGreaterThan(0);
    expect(rookie.conceded).toBeGreaterThan(0);
    // Thresholds are deliberately looser than the measured gap (about 1.9x the
    // returns and 10x the concessions) so that gameplay re-tuning does not turn
    // a difficulty ladder that is still correct into a red suite.
    expect(singularity.returns).toBeGreaterThan(rookie.returns * 1.4);
    // And it loses the point far less often against the same perfect returner.
    expect(singularity.conceded * 3).toBeLessThan(rookie.conceded);
    // Pro sits between the two extremes on both metrics.
    expect(pro.returns).toBeGreaterThan(rookie.returns);
    expect(pro.conceded).toBeLessThan(rookie.conceded);
  });

  it('exposes a coherent ladder of profiles', () => {
    let previous: AiProfile | null = null;
    for (const id of DIFFICULTY_ORDER) {
      const profile = AI_PROFILES[id];
      expect(profile.id).toBe(id);
      expect(profile.speedFactor).toBeGreaterThan(0);
      expect(profile.speedFactor).toBeLessThanOrEqual(1);
      expect(profile.lapseChance).toBeGreaterThanOrEqual(0);
      expect(profile.lapseChance).toBeLessThanOrEqual(1);
      expect(profile.anticipation).toBeGreaterThanOrEqual(0);
      expect(profile.anticipation).toBeLessThanOrEqual(1);
      expect(profile.horizon).toBeGreaterThan(0);
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(0);

      if (previous !== null) {
        // Every step up the ladder must be at least as capable on every axis.
        expect(profile.speedFactor).toBeGreaterThanOrEqual(previous.speedFactor);
        expect(profile.aimError).toBeLessThanOrEqual(previous.aimError);
        expect(profile.reactionDelay).toBeLessThanOrEqual(previous.reactionDelay);
        expect(profile.lapseChance).toBeLessThanOrEqual(previous.lapseChance);
        expect(profile.horizon).toBeGreaterThanOrEqual(previous.horizon);
        expect(profile.anticipation).toBeGreaterThanOrEqual(previous.anticipation);
      }
      previous = profile;
    }
  });
});

describe('AiOpponent stays inside its reachable area', () => {
  it('never aims outside the paddle travel bounds', () => {
    const opponent = new AiOpponent('far', ARENA, RULES, AI_PROFILES.singularity, createRng(21));
    const match = new Match(createRng(21));
    let paddle = match.state.paddles.far;

    for (let i = 0; i < 2400; i++) {
      const state = match.state;
      const intent = opponent.intent(state.ball, state.paddles.far, FIXED_TIMESTEP);
      match.step(FIXED_TIMESTEP, { near: { x: 0, y: 0 }, far: intent });
      paddle = match.state.paddles.far;
      expect(paddle.x).toBeGreaterThanOrEqual(PADDLE_BOUNDS.minX - 1e-9);
      expect(paddle.x).toBeLessThanOrEqual(PADDLE_BOUNDS.maxX + 1e-9);
      expect(paddle.y).toBeGreaterThanOrEqual(PADDLE_BOUNDS.minY - 1e-9);
      expect(paddle.y).toBeLessThanOrEqual(PADDLE_BOUNDS.maxY + 1e-9);
    }
  });
});
