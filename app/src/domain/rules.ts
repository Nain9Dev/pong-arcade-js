/**
 * Match rules and physics tuning — the knobs that define how the game *feels*.
 *
 * Everything here is data, so difficulty presets, a future "custom match" screen
 * and the deterministic test-suite all drive the exact same engine.
 */
export interface BallRules {
  readonly radius: number;
  /** Speed of the ball at serve, in units per second. */
  readonly serveSpeed: number;
  /** Multiplicative speed gain applied on each paddle return. */
  readonly rallyGain: number;
  readonly maxSpeed: number;
  /**
   * Minimum share of the total speed that must remain on the `z` axis, so a ball
   * can never end up crawling sideways forever after a grazing hit.
   */
  readonly minAxialFraction: number;
  /** How strongly an off-centre hit deflects the ball, relative to its speed. */
  readonly deflection: number;
  /** How much of the paddle's own velocity is transferred to the ball. */
  readonly paddleVelocityTransfer: number;
  /** Magnus coefficient: lateral acceleration produced by spin. */
  readonly spinForce: number;
  /** Spin decay per second (exponential, `spin *= e^(-decay * dt)`). */
  readonly spinDecay: number;
  /** Spin generated per unit of paddle velocity at contact. */
  readonly spinTransfer: number;
}

export interface PaddleRules {
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly thickness: number;
  /** Peak speed, units per second. */
  readonly maxSpeed: number;
  /** Acceleration towards the input target, units per second squared. */
  readonly acceleration: number;
  /** Velocity damping per second applied when there is no input. */
  readonly damping: number;
}

export interface MatchRules {
  readonly pointsToWin: number;
  readonly winByTwo: boolean;
  /** Seconds of stillness between a point and the next serve. */
  readonly serveDelay: number;
  readonly ball: BallRules;
  readonly paddle: PaddleRules;
}

/**
 * These numbers are not arbitrary: they were fitted with a headless sweep over
 * simulated CPU-vs-CPU matches (see docs/adr/0007). The binding constraint is
 * that a rally must always terminate. A paddle can cross the arena in
 * `arenaWidth / paddleMaxSpeed` seconds while the ball needs
 * `arenaDepth / (minAxialFraction * speed)` seconds to arrive — so once
 * `rallyGain` pushes the speed high enough, a corner shot becomes physically
 * unreachable and the point ends. Without that inequality two competent
 * opponents rally forever, which is exactly what the first tuning pass measured.
 */
export const DEFAULT_BALL_RULES: BallRules = {
  radius: 0.45,
  serveSpeed: 24,
  rallyGain: 1.075,
  maxSpeed: 140,
  minAxialFraction: 0.62,
  deflection: 0.8,
  paddleVelocityTransfer: 0.3,
  spinForce: 1.35,
  spinDecay: 0.55,
  spinTransfer: 0.055,
};

export const DEFAULT_PADDLE_RULES: PaddleRules = {
  halfWidth: 2.6,
  halfHeight: 1.9,
  thickness: 0.35,
  maxSpeed: 16,
  acceleration: 110,
  damping: 9,
};

export const DEFAULT_MATCH_RULES: MatchRules = {
  pointsToWin: 7,
  winByTwo: true,
  serveDelay: 1.1,
  ball: DEFAULT_BALL_RULES,
  paddle: DEFAULT_PADDLE_RULES,
};

/** Fixed simulation step. The renderer interpolates between two of these. */
export const FIXED_TIMESTEP = 1 / 120;

/**
 * Decides whether a score line ends the match, honouring the win-by-two rule.
 * Returns the winning side or `null` while the match is still live.
 */
export const resolveWinner = (
  rules: MatchRules,
  near: number,
  far: number,
): 'near' | 'far' | null => {
  const leader = near > far ? 'near' : far > near ? 'far' : null;
  if (leader === null) return null;
  const high = Math.max(near, far);
  const low = Math.min(near, far);
  if (high < rules.pointsToWin) return null;
  if (rules.winByTwo && high - low < 2) return null;
  return leader;
};
