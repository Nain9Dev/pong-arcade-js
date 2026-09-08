import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EMPTY_STATS, GameSession, MODE_LABELS, pointerIntent } from '../../app/src/application/session';
import type { GameModeId } from '../../app/src/application/ports';
import type { Side } from '../../app/src/domain/arena';
import type { PaddleIntent, PaddleState } from '../../app/src/domain/entities';
import type { DomainEvent } from '../../app/src/domain/events';
import { createRng } from '../../app/src/domain/rng';
import type { MatchRules } from '../../app/src/domain/rules';
import { FIXED_TIMESTEP } from '../../app/src/domain/rules';
import { ARENA, MISSABLE_RULES, PADDLE_BOUNDS, RULES } from '../support/fixtures';

const RUNS = { numRuns: 200, seed: 0x5e55 } as const;

const CORNER: Readonly<Record<Side, PaddleIntent>> = {
  near: { x: 1, y: 1 },
  far: { x: 1, y: 1 },
};

const NEUTRAL: Readonly<Record<Side, PaddleIntent>> = {
  near: { x: 0, y: 0 },
  far: { x: 0, y: 0 },
};

const drive = (
  session: GameSession,
  steps: number,
  intents: Readonly<Record<Side, PaddleIntent>> = NEUTRAL,
  stop?: (event: DomainEvent) => boolean,
): DomainEvent[] => {
  const seen: DomainEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const events = session.step(FIXED_TIMESTEP, intents);
    seen.push(...events);
    if (stop !== undefined && events.some(stop)) break;
  }
  return seen;
};

describe('GameSession screen state machine', () => {
  it('starts on the menu and simulates nothing until started', () => {
    const session = new GameSession(createRng(1));
    expect(session.screen).toBe('menu');
    expect(session.isLive).toBe(false);
    expect(drive(session, 500, CORNER)).toEqual([]);
    expect(session.snapshot().elapsed).toBe(0);
  });

  it('moves between playing, paused and the menu', () => {
    const session = new GameSession(createRng(1));
    session.start('local-versus', 'pro');
    expect(session.screen).toBe('playing');
    expect(session.isLive).toBe(true);

    session.pause();
    expect(session.screen).toBe('paused');
    expect(drive(session, 50, CORNER)).toEqual([]);

    session.resume();
    expect(session.screen).toBe('playing');

    session.togglePause();
    expect(session.screen).toBe('paused');
    session.togglePause();
    expect(session.screen).toBe('playing');

    session.quitToMenu();
    expect(session.screen).toBe('menu');
    expect(session.snapshot().elapsed).toBe(0);
    expect(session.snapshot().score).toEqual({ near: 0, far: 0 });
  });

  it('ignores transitions that do not apply to the current screen', () => {
    const session = new GameSession(createRng(1));
    session.resume();
    expect(session.screen).toBe('menu');
    session.pause();
    expect(session.screen).toBe('menu');
    session.togglePause();
    expect(session.screen).toBe('menu');
  });

  it('restart replays from zero without leaving the table', () => {
    const session = new GameSession(createRng(4), { rules: MISSABLE_RULES });
    session.start('local-versus', 'pro');
    drive(session, 600, CORNER);
    session.restart();

    expect(session.screen).toBe('playing');
    expect(session.snapshot().score).toEqual({ near: 0, far: 0 });
    expect(session.snapshot().elapsed).toBe(0);
  });
});

describe('GameSession control assignment', () => {
  it('lets both humans steer in local versus', () => {
    const session = new GameSession(createRng(2));
    session.start('local-versus', 'pro');
    drive(session, 300, CORNER);
    const paddles = session.snapshot().paddles;
    expect(paddles.near.x).toBeCloseTo(PADDLE_BOUNDS.maxX, 6);
    expect(paddles.far.x).toBeCloseTo(PADDLE_BOUNDS.maxX, 6);
  });

  it('overrides the far paddle with the AI in single player', () => {
    const session = new GameSession(createRng(2));
    session.start('single', 'elite');
    drive(session, 300, CORNER);
    const paddles = session.snapshot().paddles;
    // The human intent still drives the near paddle into its corner...
    expect(paddles.near.x).toBeCloseTo(PADDLE_BOUNDS.maxX, 6);
    // ...while the AI ignores it and plays its own read.
    expect(paddles.far.x).toBeLessThan(PADDLE_BOUNDS.maxX);
  });

  it('overrides both paddles in demo mode', () => {
    const session = new GameSession(createRng(2), { mode: 'demo' });
    session.start('demo', 'elite');
    drive(session, 300, CORNER);
    const paddles = session.snapshot().paddles;
    expect(paddles.near.x).toBeLessThan(PADDLE_BOUNDS.maxX);
    expect(paddles.far.x).toBeLessThan(PADDLE_BOUNDS.maxX);
  });

  it('exposes a label pair for every mode', () => {
    const modes: readonly GameModeId[] = ['single', 'local-versus', 'demo'];
    for (const mode of modes) {
      const session = new GameSession(createRng(3), { mode });
      expect(session.mode).toBe(mode);
      expect(session.labels).toEqual(MODE_LABELS[mode]);
      expect(session.labels.near.length).toBeGreaterThan(0);
      expect(session.labels.far.length).toBeGreaterThan(0);
    }
  });

  it('retunes a live opponent when the difficulty changes', () => {
    const session = new GameSession(createRng(3));
    session.start('single', 'rookie');
    expect(session.difficulty).toBe('rookie');
    session.setDifficulty('singularity');
    expect(session.difficulty).toBe('singularity');
    // Also safe when no AI is attached to any side.
    session.start('local-versus', 'pro');
    session.setDifficulty('elite');
    expect(session.difficulty).toBe('elite');
  });
});

describe('GameSession records', () => {
  const quickRules: MatchRules = { ...MISSABLE_RULES, pointsToWin: 2, winByTwo: false };

  it('starts empty and accepts restored stats', () => {
    const session = new GameSession(createRng(6));
    expect(session.currentStats).toEqual(EMPTY_STATS);
    session.setStats({ bestRally: 12, topSpeed: 40, matchesPlayed: 3 });
    expect(session.currentStats).toEqual({ bestRally: 12, topSpeed: 40, matchesPlayed: 3 });
  });

  it('keeps the best rally and the top speed ever seen', () => {
    const session = new GameSession(createRng(8));
    session.start('single', 'elite');
    const events = drive(session, 6000, NEUTRAL);
    const hits = events.filter((event) => event.type === 'paddle-hit');
    expect(hits.length).toBeGreaterThan(0);

    const bestRally = Math.max(...hits.map((hit) => (hit.type === 'paddle-hit' ? hit.rally : 0)));
    const topSpeed = Math.max(...hits.map((hit) => (hit.type === 'paddle-hit' ? hit.speed : 0)));
    expect(session.currentStats.bestRally).toBe(bestRally);
    expect(session.currentStats.topSpeed).toBeCloseTo(topSpeed, 9);
    expect(session.currentStats.topSpeed).toBeLessThanOrEqual(RULES.ball.maxSpeed + 1e-9);
  });

  it('counts a finished match and shows the game over screen', () => {
    const session = new GameSession(createRng(9), { rules: quickRules });
    session.start('local-versus', 'pro');
    drive(session, 4000, CORNER, (event) => event.type === 'match-won');

    expect(session.screen).toBe('over');
    expect(session.currentStats.matchesPlayed).toBe(1);
    // The screen is terminal: stepping it further changes nothing.
    expect(drive(session, 100, CORNER)).toEqual([]);
  });

  it('loops forever in demo mode instead of ending', () => {
    const demoRules: MatchRules = { ...MISSABLE_RULES, pointsToWin: 1, winByTwo: false };
    const session = new GameSession(createRng(10), { rules: demoRules });
    session.start('demo', 'rookie');
    drive(session, 4000, NEUTRAL, (event) => event.type === 'match-won');

    expect(session.currentStats.matchesPlayed).toBeGreaterThanOrEqual(1);
    expect(session.screen).toBe('playing');
    expect(session.snapshot().score).toEqual({ near: 0, far: 0 });
  });
});

describe('pointerIntent', () => {
  const paddleArb = fc.record({
    side: fc.constant<Side>('near'),
    x: fc.double({ min: PADDLE_BOUNDS.minX, max: PADDLE_BOUNDS.maxX, noNaN: true }),
    y: fc.double({ min: PADDLE_BOUNDS.minY, max: PADDLE_BOUNDS.maxY, noNaN: true }),
    vx: fc.constant(0),
    vy: fc.constant(0),
  });

  const targetArb = fc.record({
    x: fc.double({ min: -4, max: 4, noNaN: true }),
    y: fc.double({ min: -4, max: 4, noNaN: true }),
  });

  it('stays inside the normalised intent range', () => {
    fc.assert(
      fc.property(paddleArb, targetArb, (paddle: PaddleState, target) => {
        const intent = pointerIntent(ARENA, RULES, paddle, target);
        expect(Math.abs(intent.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(intent.y)).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });

  it('always points towards the target', () => {
    fc.assert(
      fc.property(paddleArb, targetArb, (paddle: PaddleState, target) => {
        const intent = pointerIntent(ARENA, RULES, paddle, target);
        const wantedX = Math.max(-1, Math.min(1, target.x)) * PADDLE_BOUNDS.maxX - paddle.x;
        if (intent.x !== 0) expect(Math.sign(intent.x)).toBe(Math.sign(wantedX));
      }),
      RUNS,
    );
  });

  it('settles in a dead zone on top of the cursor', () => {
    const paddle: PaddleState = { side: 'near', x: 0, y: 0, vx: 0, vy: 0 };
    expect(pointerIntent(ARENA, RULES, paddle, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('saturates for a cursor beyond the arena edge', () => {
    const paddle: PaddleState = { side: 'near', x: PADDLE_BOUNDS.minX, y: PADDLE_BOUNDS.minY, vx: 0, vy: 0 };
    expect(pointerIntent(ARENA, RULES, paddle, { x: 9, y: 9 })).toEqual({ x: 1, y: 1 });
  });
});
