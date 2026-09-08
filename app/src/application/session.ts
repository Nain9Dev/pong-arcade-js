import type { Arena, Side } from '../domain/arena';
import { DEFAULT_ARENA } from '../domain/arena';
import type { DifficultyId } from '../domain/ai/difficulty';
import { AI_PROFILES } from '../domain/ai/difficulty';
import { AiOpponent } from '../domain/ai/opponent';
import type { PaddleIntent, PaddleState } from '../domain/entities';
import { NEUTRAL_INTENT } from '../domain/entities';
import type { DomainEvent } from '../domain/events';
import type { MatchSnapshot } from '../domain/match';
import { Match } from '../domain/match';
import { clamp } from '../domain/math/vec3';
import { paddleBounds } from '../domain/physics';
import type { Rng } from '../domain/rng';
import type { MatchRules } from '../domain/rules';
import { DEFAULT_MATCH_RULES } from '../domain/rules';
import type { GameModeId, ScreenId } from './ports';

/**
 * Orchestrates one play session: which mode is running, who controls each
 * paddle, and how the screen state machine moves between menu, play, pause and
 * game over.
 *
 * It is deliberately free of any browser type. `main.ts` feeds it intents and
 * forwards the events it returns to the renderer, the audio adapter and the HUD.
 */

export interface SessionOptions {
  readonly rules?: MatchRules;
  readonly arena?: Arena;
  readonly mode?: GameModeId;
  readonly difficulty?: DifficultyId;
}

/** Which paddles the AI drives in each mode. */
const AI_SIDES: Readonly<Record<GameModeId, readonly Side[]>> = {
  single: ['far'],
  'local-versus': [],
  demo: ['near', 'far'],
};

export const MODE_LABELS: Readonly<Record<GameModeId, { near: string; far: string }>> = {
  single: { near: 'Tú', far: 'CPU' },
  'local-versus': { near: 'Jugador 1', far: 'Jugador 2' },
  demo: { near: 'CPU A', far: 'CPU B' },
};

export interface SessionStats {
  /** Longest rally ever recorded on this device. */
  readonly bestRally: number;
  /** Fastest ball speed ever reached, in world units per second. */
  readonly topSpeed: number;
  readonly matchesPlayed: number;
}

export const EMPTY_STATS: SessionStats = { bestRally: 0, topSpeed: 0, matchesPlayed: 0 };

export class GameSession {
  readonly arena: Arena;
  readonly rules: MatchRules;

  private readonly rng: Rng;
  private readonly match: Match;
  private opponents: Partial<Record<Side, AiOpponent>> = {};
  private screenState: ScreenId = 'menu';
  private modeState: GameModeId;
  private difficultyState: DifficultyId;
  private stats: SessionStats = EMPTY_STATS;

  constructor(rng: Rng, options: SessionOptions = {}) {
    this.rng = rng;
    this.arena = options.arena ?? DEFAULT_ARENA;
    this.rules = options.rules ?? DEFAULT_MATCH_RULES;
    this.modeState = options.mode ?? 'single';
    this.difficultyState = options.difficulty ?? 'pro';
    this.match = new Match(rng, { rules: this.rules, arena: this.arena });
    this.configureOpponents();
  }

  get screen(): ScreenId {
    return this.screenState;
  }

  get mode(): GameModeId {
    return this.modeState;
  }

  get difficulty(): DifficultyId {
    return this.difficultyState;
  }

  get labels(): { near: string; far: string } {
    return MODE_LABELS[this.modeState];
  }

  /** True while the simulation should keep running (play or attract mode). */
  get isLive(): boolean {
    return this.screenState === 'playing';
  }

  setStats(stats: SessionStats): void {
    this.stats = stats;
  }

  get currentStats(): SessionStats {
    return this.stats;
  }

  setDifficulty(difficulty: DifficultyId): void {
    this.difficultyState = difficulty;
    const profile = AI_PROFILES[difficulty];
    for (const opponent of Object.values(this.opponents)) opponent?.setProfile(profile);
  }

  start(mode: GameModeId, difficulty: DifficultyId): void {
    this.modeState = mode;
    this.difficultyState = difficulty;
    this.configureOpponents();
    this.match.reset();
    this.screenState = 'playing';
  }

  restart(): void {
    this.match.reset();
    this.screenState = 'playing';
  }

  pause(): void {
    if (this.screenState === 'playing') this.screenState = 'paused';
  }

  resume(): void {
    if (this.screenState === 'paused') this.screenState = 'playing';
  }

  togglePause(): void {
    if (this.screenState === 'playing') this.pause();
    else if (this.screenState === 'paused') this.resume();
  }

  quitToMenu(): void {
    this.screenState = 'menu';
    this.match.reset();
  }

  /**
   * Advances the session by one fixed step.
   *
   * `intents` carries the *human* input only; AI-controlled sides are filled in
   * here, which is why demo mode needs no special casing anywhere else.
   */
  step(dt: number, intents: Readonly<Record<Side, PaddleIntent>>): readonly DomainEvent[] {
    if (this.screenState !== 'playing') return [];

    const resolved: Record<Side, PaddleIntent> = {
      near: this.intentFor('near', intents.near, dt),
      far: this.intentFor('far', intents.far, dt),
    };

    const events = this.match.step(dt, resolved);
    this.absorb(events);
    return events;
  }

  private intentFor(side: Side, human: PaddleIntent | undefined, dt: number): PaddleIntent {
    const opponent = this.opponents[side];
    if (!opponent) return human ?? NEUTRAL_INTENT;
    const { ball, paddles } = this.match.state;
    return opponent.intent(ball, paddles[side], dt);
  }

  /** Updates records and the screen state from the events just produced. */
  private absorb(events: readonly DomainEvent[]): void {
    for (const event of events) {
      if (event.type === 'paddle-hit') {
        this.stats = {
          ...this.stats,
          bestRally: Math.max(this.stats.bestRally, event.rally),
          topSpeed: Math.max(this.stats.topSpeed, event.speed),
        };
      } else if (event.type === 'match-won') {
        this.stats = { ...this.stats, matchesPlayed: this.stats.matchesPlayed + 1 };
        // Demo mode loops forever instead of showing a game-over screen.
        if (this.modeState === 'demo') this.match.reset();
        else this.screenState = 'over';
      }
    }
  }

  snapshot(): MatchSnapshot {
    return this.match.snapshot();
  }

  private configureOpponents(): void {
    const profile = AI_PROFILES[this.difficultyState];
    const sides = AI_SIDES[this.modeState];
    const next: Partial<Record<Side, AiOpponent>> = {};
    for (const side of sides) {
      next[side] = new AiOpponent(side, this.arena, this.rules, profile, this.rng);
    }
    this.opponents = next;
  }
}

/**
 * Converts an absolute pointer target (normalised to `[-1, 1]` over the arena
 * cross-section) into a paddle intent.
 *
 * Pointer steering is positional while the physics is velocity based, so we run
 * a proportional controller with a dead-zone: the paddle accelerates towards the
 * cursor and settles instead of jittering on top of it.
 */
export const pointerIntent = (
  arena: Arena,
  rules: MatchRules,
  paddle: PaddleState,
  target: { readonly x: number; readonly y: number },
): PaddleIntent => {
  const bounds = paddleBounds(arena, rules.paddle);
  const targetX = clamp(target.x, -1, 1) * bounds.maxX;
  const targetY = clamp(target.y, -1, 1) * bounds.maxY;
  const gain = 1.1;
  const deadZone = 0.05;
  const dx = targetX - paddle.x;
  const dy = targetY - paddle.y;
  return {
    x: Math.abs(dx) < deadZone ? 0 : clamp(dx * gain, -1, 1),
    y: Math.abs(dy) < deadZone ? 0 : clamp(dy * gain, -1, 1),
  };
};
