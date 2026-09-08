import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Side } from '../../app/src/domain/arena';
import { opposite } from '../../app/src/domain/arena';
import type { PaddleIntent } from '../../app/src/domain/entities';
import type { DomainEvent, PointScoredEvent, ServeEvent } from '../../app/src/domain/events';
import { Match } from '../../app/src/domain/match';
import type { MatchSnapshot } from '../../app/src/domain/match';
import { ZERO } from '../../app/src/domain/math/vec3';
import { createRng } from '../../app/src/domain/rng';
import type { MatchRules } from '../../app/src/domain/rules';
import { DEFAULT_MATCH_RULES, FIXED_TIMESTEP, resolveWinner } from '../../app/src/domain/rules';
import { MISSABLE_RULES, RULES, speed } from '../support/fixtures';

const RUNS = { numRuns: 100, seed: 0x4d47 } as const;

/** Parks both paddles in a corner, out of reach of any serve. */
const CORNER_INTENTS: Readonly<Record<Side, PaddleIntent>> = {
  near: { x: 1, y: 1 },
  far: { x: 1, y: 1 },
};

const NEUTRAL: Readonly<Record<Side, PaddleIntent>> = {
  near: { x: 0, y: 0 },
  far: { x: 0, y: 0 },
};

interface Simulation {
  readonly events: DomainEvent[];
  readonly steps: number;
}

const run = (
  match: Match,
  steps: number,
  intents: Readonly<Record<Side, PaddleIntent>> = CORNER_INTENTS,
  stop?: (event: DomainEvent) => boolean,
): Simulation => {
  const events: DomainEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const produced = match.step(FIXED_TIMESTEP, intents);
    events.push(...produced);
    if (stop !== undefined && produced.some(stop)) return { events, steps: i + 1 };
  }
  return { events, steps };
};

const intentArb = fc.record({
  x: fc.double({ min: -1, max: 1, noNaN: true }),
  y: fc.double({ min: -1, max: 1, noNaN: true }),
});

describe('Match determinism', () => {
  it('produces byte-identical snapshots from the same seed and intent trace', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.array(fc.tuple(intentArb, intentArb), { minLength: 200, maxLength: 400 }),
        (seed, trace) => {
          const a = new Match(createRng(seed));
          const b = new Match(createRng(seed));
          const eventsA: DomainEvent[] = [];
          const eventsB: DomainEvent[] = [];

          for (const [near, far] of trace) {
            eventsA.push(...a.step(FIXED_TIMESTEP, { near, far }));
            eventsB.push(...b.step(FIXED_TIMESTEP, { near, far }));
          }

          expect(a.snapshot()).toEqual(b.snapshot());
          expect(eventsA).toEqual(eventsB);
        },
      ),
      { ...RUNS, numRuns: 40 },
    );
  });

  it('diverges when the seed changes', () => {
    // The serve cone is drawn from the RNG, so two seeds must eventually differ.
    const snapshots = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const match = new Match(createRng(seed));
      run(match, 400, NEUTRAL);
      snapshots.add(JSON.stringify(match.snapshot().ball.velocity));
    }
    expect(snapshots.size).toBeGreaterThan(1);
  });

  it('reset() rewinds to the initial state and keeps the RNG stream alive', () => {
    const match = new Match(createRng(99));
    const fresh = match.snapshot();
    run(match, 600, CORNER_INTENTS);
    match.reset();
    const after = match.snapshot();

    expect(after.score).toEqual({ near: 0, far: 0 });
    expect(after.phase).toBe('serving');
    expect(after.rally).toBe(0);
    expect(after.longestRally).toBe(0);
    expect(after.winner).toBeNull();
    expect(after.elapsed).toBe(0);
    expect(after.ball).toEqual(fresh.ball);
    expect(after.paddles).toEqual(fresh.paddles);
    expect(after.serveCountdown).toBe(DEFAULT_MATCH_RULES.serveDelay);
  });
});

describe('Match serving', () => {
  it('holds the ball at the origin until the serve delay elapses', () => {
    const match = new Match(createRng(1234));
    const expectedSteps = Math.ceil(RULES.serveDelay / FIXED_TIMESTEP);
    let serveStep = -1;

    for (let i = 0; i < expectedSteps + 12; i++) {
      const before = match.snapshot();
      const events = match.step(FIXED_TIMESTEP, NEUTRAL);
      const serves = events.filter((event) => event.type === 'serve');

      if (serveStep === -1 && serves.length === 0) {
        expect(before.phase).toBe('serving');
        expect(before.ball.position).toEqual(ZERO);
        expect(before.ball.velocity).toEqual(ZERO);
        expect(before.serveCountdown).toBeGreaterThan(0);
      }
      if (serves.length > 0) {
        expect(serveStep).toBe(-1);
        serveStep = i;
      }
    }

    // The serve lands on the first tick whose accumulated time covers the delay,
    // give or take one tick: the countdown is decremented step by step, so the
    // residue of 132 subtractions of 1/120 can push it over by a single frame.
    const servedAt = (serveStep + 1) * FIXED_TIMESTEP;
    expect(servedAt).toBeGreaterThanOrEqual(RULES.serveDelay - 1e-9);
    expect(servedAt).toBeLessThanOrEqual(RULES.serveDelay + FIXED_TIMESTEP + 1e-9);
    expect(match.snapshot().phase).toBe('rally');
    expect(match.snapshot().serveCountdown).toBe(0);
  });

  it('fires exactly one serve event and launches at the configured speed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const match = new Match(createRng(seed));
        const { events } = run(match, 200, NEUTRAL);
        const serves = events.filter((event): event is ServeEvent => event.type === 'serve');

        expect(serves).toHaveLength(1);
        const serve = serves[0];
        expect(serve).toBeDefined();
        if (serve === undefined) return;

        expect(serve.speed).toBe(RULES.ball.serveSpeed);
        const snapshot = match.snapshot();
        expect(snapshot.ballSpeed).toBeGreaterThan(0);
        expect(speed(snapshot.ball.velocity)).toBeCloseTo(RULES.ball.serveSpeed, 9);
        // The ball must travel towards the side named by the event.
        expect(Math.sign(snapshot.ball.velocity.z)).toBe(serve.towards === 'far' ? 1 : -1);
      }),
      RUNS,
    );
  });

  it('starts the rally counter at zero on every serve', () => {
    const match = new Match(createRng(7), { rules: MISSABLE_RULES });
    run(match, 400, CORNER_INTENTS, (event) => event.type === 'serve');
    expect(match.snapshot().rally).toBe(0);
  });
});

describe('Match scoring', () => {
  const missableMatch = (seed: number): Match =>
    new Match(createRng(seed), { rules: MISSABLE_RULES });

  it('awards the point to the side opposite the conceded goal', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const match = missableMatch(seed);
        const { events } = run(match, 1200, CORNER_INTENTS, (e) => e.type === 'point-scored');
        const point = events.find((e): e is PointScoredEvent => e.type === 'point-scored');
        const serve = events.find((e): e is ServeEvent => e.type === 'serve');

        expect(point).toBeDefined();
        expect(serve).toBeDefined();
        if (point === undefined || serve === undefined) return;

        // The ball was served towards a corner-parked paddle, so that side loses.
        expect(point.conceded).toBe(serve.towards);
        expect(point.scorer).toBe(opposite(point.conceded));
        expect(point.score[point.scorer]).toBe(1);
        expect(point.score[point.conceded]).toBe(0);
        expect(match.snapshot().score).toEqual(point.score);
      }),
      { ...RUNS, numRuns: 25 },
    );
  });

  it('sends the next serve towards the side that conceded', () => {
    const match = missableMatch(2024);
    const first = run(match, 1200, CORNER_INTENTS, (e) => e.type === 'point-scored');
    const point = first.events.find((e): e is PointScoredEvent => e.type === 'point-scored');
    expect(point).toBeDefined();
    if (point === undefined) return;

    const snapshot = match.snapshot();
    expect(snapshot.phase).toBe('serving');
    expect(snapshot.serveTowards).toBe(point.conceded);
    expect(snapshot.serveCountdown).toBeCloseTo(RULES.serveDelay, 9);
    expect(snapshot.ball.position).toEqual(ZERO);
    expect(snapshot.ball.velocity).toEqual(ZERO);

    const second = run(match, 1200, CORNER_INTENTS, (e) => e.type === 'serve');
    const nextServe = second.events.find((e): e is ServeEvent => e.type === 'serve');
    expect(nextServe?.towards).toBe(point.conceded);
  });

  it('tracks the longest rally across the match', () => {
    const match = new Match(createRng(5));
    run(match, 2000, NEUTRAL);
    const snapshot = match.snapshot();
    expect(snapshot.longestRally).toBeGreaterThanOrEqual(snapshot.rally);
  });
});

describe('resolveWinner', () => {
  // Pinned to 7 so the table below keeps its meaning while the lead tunes the
  // shipped default.
  const winByTwo: MatchRules = { ...DEFAULT_MATCH_RULES, pointsToWin: 7, winByTwo: true };
  const suddenDeath: MatchRules = { ...winByTwo, winByTwo: false };

  it('needs a two point margin when winByTwo is on', () => {
    expect(resolveWinner(winByTwo, 7, 6)).toBeNull();
    expect(resolveWinner(winByTwo, 6, 7)).toBeNull();
    expect(resolveWinner(winByTwo, 8, 6)).toBe('near');
    expect(resolveWinner(winByTwo, 6, 8)).toBe('far');
    expect(resolveWinner(winByTwo, 12, 11)).toBeNull();
    expect(resolveWinner(winByTwo, 7, 0)).toBe('near');
  });

  it('ends on the target score when winByTwo is off', () => {
    expect(resolveWinner(suddenDeath, 7, 6)).toBe('near');
    expect(resolveWinner(suddenDeath, 6, 7)).toBe('far');
    expect(resolveWinner(suddenDeath, 7, 7)).toBeNull();
  });

  it('never declares a winner below the target score or on a tie', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        (near, far, twoPointMargin) => {
          const rules: MatchRules = { ...winByTwo, winByTwo: twoPointMargin };
          const winner = resolveWinner(rules, near, far);

          if (near === far) expect(winner).toBeNull();
          if (Math.max(near, far) < rules.pointsToWin) expect(winner).toBeNull();
          if (winner !== null) {
            const winning = winner === 'near' ? near : far;
            const losing = winner === 'near' ? far : near;
            expect(winning).toBeGreaterThan(losing);
            expect(winning).toBeGreaterThanOrEqual(rules.pointsToWin);
            if (twoPointMargin) expect(winning - losing).toBeGreaterThanOrEqual(2);
          }
        },
      ),
      { ...RUNS, numRuns: 300 },
    );
  });

  it('is symmetric under swapping the sides', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 }), (a, b) => {
        const direct = resolveWinner(winByTwo, a, b);
        const swapped = resolveWinner(winByTwo, b, a);
        const mirror = direct === null ? null : direct === 'near' ? 'far' : 'near';
        expect(swapped).toBe(mirror);
      }),
      { ...RUNS, numRuns: 300 },
    );
  });
});

describe('Match completion', () => {
  // A short target keeps the sweep quick and independent of the shipped default.
  const SWEEP_RULES: MatchRules = { ...MISSABLE_RULES, pointsToWin: 5, winByTwo: true };

  const playToTheEnd = (rules: MatchRules, seed = 31): { match: Match; events: DomainEvent[] } => {
    const match = new Match(createRng(seed), { rules });
    const { events } = run(match, 12000, CORNER_INTENTS, (e) => e.type === 'match-won');
    return { match, events };
  };

  it('emits match-won exactly once and freezes the match', () => {
    const { match, events } = playToTheEnd(SWEEP_RULES);
    const won = events.filter((event) => event.type === 'match-won');
    expect(won).toHaveLength(1);

    const winner = won[0];
    expect(winner).toBeDefined();
    if (winner?.type !== 'match-won') return;

    const firstServe = events.find((e): e is ServeEvent => e.type === 'serve');
    expect(firstServe).toBeDefined();
    // Every serve travels towards the side that conceded the previous point, so
    // the very first receiver keeps losing every rally: a clean sweep.
    expect(winner.winner).toBe(opposite(firstServe?.towards ?? 'near'));
    expect(winner.score[winner.winner]).toBe(SWEEP_RULES.pointsToWin);
    expect(winner.score[opposite(winner.winner)]).toBe(0);

    const snapshot: MatchSnapshot = match.snapshot();
    expect(snapshot.phase).toBe('over');
    expect(snapshot.winner).toBe(winner.winner);
    expect(snapshot.ball.velocity).toEqual(ZERO);
  });

  it('makes further steps inert once the match is over', () => {
    const { match } = playToTheEnd(SWEEP_RULES);
    const before = match.snapshot();

    for (let i = 0; i < 500; i++) {
      expect(match.step(FIXED_TIMESTEP, CORNER_INTENTS)).toEqual([]);
    }

    expect(match.snapshot()).toEqual(before);
  });

  it('honours a shorter target score', () => {
    const shortRules: MatchRules = { ...MISSABLE_RULES, pointsToWin: 2, winByTwo: false };
    const { events } = playToTheEnd(shortRules, 77);
    const points = events.filter((event) => event.type === 'point-scored');
    expect(points).toHaveLength(2);
    expect(events.filter((event) => event.type === 'match-won')).toHaveLength(1);
  });
});

describe('Match introspection', () => {
  it('exposes the paddle plane and a read-only state view', () => {
    const match = new Match(createRng(3));
    expect(match.paddleZ).toBeCloseTo(match.arena.halfDepth - match.arena.paddleInset, 12);

    run(match, 300, NEUTRAL);
    const state = match.state;
    const snapshot = match.snapshot();
    expect(state.ball).toEqual(snapshot.ball);
    expect(state.paddles).toEqual(snapshot.paddles);
    expect(state.phase).toBe(snapshot.phase);
  });

  it('accumulates elapsed time in exact fixed steps', () => {
    const match = new Match(createRng(3));
    run(match, 120, NEUTRAL);
    expect(match.snapshot().elapsed).toBeCloseTo(1, 9);
  });
});
