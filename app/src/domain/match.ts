import type { Arena, Side } from './arena';
import { DEFAULT_ARENA, opposite, paddlePlaneZ, sideSign } from './arena';
import type { BallState, PaddleIntent, PaddleState } from './entities';
import { createPaddle, NEUTRAL_INTENT } from './entities';
import type { DomainEvent } from './events';
import { advanceBall, advancePaddle } from './physics';
import type { Vec3 } from './math/vec3';
import { length, vec3, ZERO } from './math/vec3';
import type { Rng } from './rng';
import type { MatchRules } from './rules';
import { DEFAULT_MATCH_RULES, resolveWinner } from './rules';

/**
 * Lifecycle of a single match.
 *
 * `serving` freezes the ball at the centre while players reposition, `rally` is
 * live play, `over` is terminal.
 */
export type MatchPhase = 'serving' | 'rally' | 'over';

export interface Score {
  readonly near: number;
  readonly far: number;
}

/**
 * An immutable view of the world for one simulation tick. The renderer keeps the
 * previous and current snapshot and interpolates between them, which decouples
 * the 120 Hz simulation from whatever refresh rate the display runs at.
 */
export interface MatchSnapshot {
  readonly ball: BallState;
  readonly ballSpeed: number;
  readonly paddles: Readonly<Record<Side, PaddleState>>;
  readonly score: Score;
  readonly phase: MatchPhase;
  readonly rally: number;
  readonly longestRally: number;
  readonly winner: Side | null;
  /** Seconds left before the next serve; `0` outside the `serving` phase. */
  readonly serveCountdown: number;
  /** Side the pending serve will travel towards. */
  readonly serveTowards: Side;
  readonly elapsed: number;
}

export interface MatchOptions {
  readonly rules?: MatchRules;
  readonly arena?: Arena;
}

/**
 * The aggregate root. Owns all mutable match state and is the only place where
 * the rules of the game are decided.
 *
 * Everything it needs from the outside world — randomness, control intents,
 * elapsed time — is injected, so the whole class is testable without a browser
 * and a match is reproducible from `(seed, intent trace)`.
 */
export class Match {
  readonly rules: MatchRules;
  readonly arena: Arena;

  private readonly rng: Rng;
  private ball: BallState;
  private paddles: Record<Side, PaddleState>;
  private score: Score = { near: 0, far: 0 };
  private phase: MatchPhase = 'serving';
  private rally = 0;
  private longestRally = 0;
  private winner: Side | null = null;
  private serveCountdown: number;
  private serveTowards: Side;
  private elapsed = 0;

  constructor(rng: Rng, options: MatchOptions = {}) {
    this.rng = rng;
    this.rules = options.rules ?? DEFAULT_MATCH_RULES;
    this.arena = options.arena ?? DEFAULT_ARENA;
    this.paddles = { near: createPaddle('near'), far: createPaddle('far') };
    this.ball = { position: ZERO, velocity: ZERO, spin: ZERO };
    this.serveCountdown = this.rules.serveDelay;
    this.serveTowards = this.rng.bool() ? 'near' : 'far';
  }

  /** Restarts the match, keeping the same rules, arena and RNG stream. */
  reset(): void {
    this.paddles = { near: createPaddle('near'), far: createPaddle('far') };
    this.ball = { position: ZERO, velocity: ZERO, spin: ZERO };
    this.score = { near: 0, far: 0 };
    this.phase = 'serving';
    this.rally = 0;
    this.longestRally = 0;
    this.winner = null;
    this.serveCountdown = this.rules.serveDelay;
    this.serveTowards = this.rng.bool() ? 'near' : 'far';
    this.elapsed = 0;
  }

  /**
   * Advances the simulation by exactly `dt` seconds.
   *
   * Callers must drive this with a fixed timestep — variable steps would make
   * the physics frame-rate dependent and break determinism.
   */
  step(dt: number, intents: Readonly<Record<Side, PaddleIntent>>): readonly DomainEvent[] {
    if (this.phase === 'over') return [];

    this.elapsed += dt;
    const events: DomainEvent[] = [];

    for (const side of ['near', 'far'] as const) {
      this.paddles[side] = advancePaddle(
        this.arena,
        this.rules.paddle,
        this.paddles[side],
        intents[side] ?? NEUTRAL_INTENT,
        dt,
      );
    }

    if (this.phase === 'serving') {
      this.serveCountdown -= dt;
      // Hold the ball at the centre, gently drifting, until the countdown ends.
      this.ball = { position: ZERO, velocity: ZERO, spin: ZERO };
      if (this.serveCountdown <= 0) {
        events.push(this.serve());
      }
      return events;
    }

    const result = advanceBall(this.arena, this.rules, this.ball, this.paddles, dt, this.rally);
    this.ball = result.ball;
    events.push(...result.events);

    if (result.returns > 0) {
      this.rally += result.returns;
      if (this.rally > this.longestRally) this.longestRally = this.rally;
    }

    if (result.conceded !== null) {
      events.push(...this.awardPoint(opposite(result.conceded), result.conceded));
    }

    return events;
  }

  private serve(): DomainEvent {
    const rules = this.rules.ball;
    const towards = this.serveTowards;
    const sign = sideSign(towards);
    // A shallow random cone so no two serves are identical, but never so wide
    // that the ball starts by grinding along a wall.
    const yaw = this.rng.range(-0.32, 0.32);
    const pitch = this.rng.range(-0.22, 0.22);
    const direction = vec3(Math.sin(yaw), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch) * sign);
    const speed = rules.serveSpeed;
    const magnitude = length(direction);
    const velocity: Vec3 = vec3(
      (direction.x / magnitude) * speed,
      (direction.y / magnitude) * speed,
      (direction.z / magnitude) * speed,
    );

    this.ball = { position: ZERO, velocity, spin: ZERO };
    this.phase = 'rally';
    this.rally = 0;
    this.serveCountdown = 0;
    return { type: 'serve', towards, speed };
  }

  private awardPoint(scorer: Side, conceded: Side): DomainEvent[] {
    const score: Score =
      scorer === 'near'
        ? { near: this.score.near + 1, far: this.score.far }
        : { near: this.score.near, far: this.score.far + 1 };
    this.score = score;

    const events: DomainEvent[] = [
      { type: 'point-scored', scorer, conceded, score, rally: this.rally },
    ];

    const winner = resolveWinner(this.rules, score.near, score.far);
    if (winner !== null) {
      this.winner = winner;
      this.phase = 'over';
      this.ball = { position: ZERO, velocity: ZERO, spin: ZERO };
      events.push({ type: 'match-won', winner, score });
      return events;
    }

    // The player who conceded receives the next serve.
    this.serveTowards = conceded;
    this.serveCountdown = this.rules.serveDelay;
    this.phase = 'serving';
    this.rally = 0;
    this.ball = { position: ZERO, velocity: ZERO, spin: ZERO };
    return events;
  }

  snapshot(): MatchSnapshot {
    return {
      ball: this.ball,
      ballSpeed: length(this.ball.velocity),
      paddles: { near: this.paddles.near, far: this.paddles.far },
      score: this.score,
      phase: this.phase,
      rally: this.rally,
      longestRally: this.longestRally,
      winner: this.winner,
      serveCountdown: Math.max(0, this.serveCountdown),
      serveTowards: this.serveTowards,
      elapsed: this.elapsed,
    };
  }

  /** Absolute `z` of the plane the paddles sweep — needed to place the camera. */
  get paddleZ(): number {
    return paddlePlaneZ(this.arena);
  }

  /** Read-only access for the AI, which must not mutate match state. */
  get state(): { ball: BallState; paddles: Readonly<Record<Side, PaddleState>>; phase: MatchPhase } {
    return { ball: this.ball, paddles: this.paddles, phase: this.phase };
  }
}
