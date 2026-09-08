/**
 * Difficulty presets.
 *
 * Difficulty is expressed as *human-like limitations* — reaction latency, aiming
 * error, how early the opponent commits — rather than as raw paddle speed. An
 * opponent that is merely faster feels unfair; one that reads the ball late and
 * aims imprecisely feels beatable.
 */
export type DifficultyId = 'rookie' | 'pro' | 'elite' | 'singularity';

export interface AiProfile {
  readonly id: DifficultyId;
  readonly label: string;
  readonly description: string;
  /** Fraction of the paddle's maximum speed the opponent allows itself. */
  readonly speedFactor: number;
  /** Seconds between re-evaluations of the trajectory. */
  readonly reactionDelay: number;
  /** Standard aiming error applied to the intercept, in world units. */
  readonly aimError: number;
  /** How far ahead it is willing to look, in seconds. */
  readonly horizon: number;
  /** 0 = tracks the live ball, 1 = fully trusts its prediction. */
  readonly anticipation: number;
  /** Chance per re-evaluation of simply not reacting. */
  readonly lapseChance: number;
  /** How aggressively it aims for the paddle edge to angle its return. */
  readonly aggression: number;
  /**
   * Extra aiming error per unit of *relative* ball speed.
   *
   * A prediction is only as good as the time available to act on it: at four
   * times the serve speed even a perfect solver is committing to a read it
   * cannot correct. Without this term two strong opponents rally forever once
   * the ball reaches its terminal speed — measured, not assumed.
   */
  readonly speedBlindness: number;
}

export const AI_PROFILES: Readonly<Record<DifficultyId, AiProfile>> = {
  rookie: {
    id: 'rookie',
    label: 'Rookie',
    description: 'Reacciona tarde y falla el ángulo. Ideal para aprender el control 3D.',
    speedFactor: 0.72,
    reactionDelay: 0.26,
    aimError: 1.3,
    horizon: 1.4,
    anticipation: 0.5,
    lapseChance: 0.08,
    aggression: 0.1,
    speedBlindness: 1.15,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    description: 'Lee la trayectoria y devuelve con intención. El duelo justo.',
    speedFactor: 0.88,
    reactionDelay: 0.17,
    aimError: 1.05,
    horizon: 2.2,
    anticipation: 0.78,
    lapseChance: 0.06,
    aggression: 0.35,
    speedBlindness: 0.78,
  },
  elite: {
    id: 'elite',
    label: 'Elite',
    description: 'Anticipa rebotes en pared y castiga cualquier devolución centrada.',
    speedFactor: 0.97,
    reactionDelay: 0.09,
    aimError: 0.45,
    horizon: 3.2,
    anticipation: 0.92,
    lapseChance: 0.02,
    aggression: 0.62,
    speedBlindness: 0.52,
  },
  singularity: {
    id: 'singularity',
    label: 'Singularity',
    description: 'Resuelve la trayectoria completa, incluido el efecto Magnus. Suerte.',
    speedFactor: 1,
    reactionDelay: 0.03,
    aimError: 0.08,
    horizon: 4.5,
    anticipation: 1,
    lapseChance: 0,
    aggression: 0.85,
    speedBlindness: 0.34,
  },
};

export const DIFFICULTY_ORDER: readonly DifficultyId[] = [
  'rookie',
  'pro',
  'elite',
  'singularity',
];
