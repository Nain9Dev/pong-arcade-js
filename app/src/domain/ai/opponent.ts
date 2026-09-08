import type { Arena, Side } from '../arena';
import type { BallState, PaddleIntent, PaddleState } from '../entities';
import { clamp, length } from '../math/vec3';
import { paddleBounds } from '../physics';
import type { Rng } from '../rng';
import type { MatchRules } from '../rules';
import type { AiProfile } from './difficulty';
import { predictIntercept } from './predictor';

/**
 * A computer opponent, modelled as an input source rather than as a special case
 * inside the physics.
 *
 * It produces the exact same `PaddleIntent` a keyboard or a gamepad produces, so
 * the engine cannot tell a human from a machine — which is also what makes
 * CPU-vs-CPU attract mode free.
 */
export class AiOpponent {
  private readonly side: Side;
  private readonly arena: Arena;
  private readonly rules: MatchRules;
  private readonly rng: Rng;
  private profile: AiProfile;

  private targetX = 0;
  private targetY = 0;
  private sinceDecision = Number.POSITIVE_INFINITY;
  private lapsed = false;

  constructor(side: Side, arena: Arena, rules: MatchRules, profile: AiProfile, rng: Rng) {
    this.side = side;
    this.arena = arena;
    this.rules = rules;
    this.profile = profile;
    this.rng = rng;
  }

  setProfile(profile: AiProfile): void {
    this.profile = profile;
    this.sinceDecision = Number.POSITIVE_INFINITY;
  }

  /**
   * Produces the intent for this tick.
   *
   * Re-planning only happens every `reactionDelay` seconds; in between the
   * opponent commits to its decision, which is what creates the human-looking
   * "it read that one wrong" moments.
   */
  intent(ball: BallState, paddle: PaddleState, dt: number): PaddleIntent {
    const profile = this.profile;
    this.sinceDecision += dt;

    if (this.sinceDecision >= profile.reactionDelay) {
      this.sinceDecision = 0;
      this.lapsed = this.rng.next() < profile.lapseChance;
      this.plan(ball);
    }

    if (this.lapsed) return { x: 0, y: 0 };

    const bounds = paddleBounds(this.arena, this.rules.paddle);
    const targetX = clamp(this.targetX, bounds.minX, bounds.maxX);
    const targetY = clamp(this.targetY, bounds.minY, bounds.maxY);

    // Proportional controller with a dead-zone, so the paddle settles instead of
    // oscillating around the target.
    const deadZone = 0.12;
    const gain = 0.9;
    const dx = targetX - paddle.x;
    const dy = targetY - paddle.y;

    return {
      x: Math.abs(dx) < deadZone ? 0 : clamp(dx * gain, -1, 1) * profile.speedFactor,
      y: Math.abs(dy) < deadZone ? 0 : clamp(dy * gain, -1, 1) * profile.speedFactor,
    };
  }

  private plan(ball: BallState): void {
    const profile = this.profile;
    const intercept = predictIntercept(this.arena, this.rules, ball, this.side, profile.horizon);

    if (intercept === null) {
      // Ball is heading away: drift back towards a defensive centre, biased
      // slightly towards wherever the ball currently is.
      this.targetX = ball.position.x * 0.18;
      this.targetY = ball.position.y * 0.18;
      return;
    }

    // Reading a ball travelling at four times the serve speed is materially
    // harder than reading a fresh serve, for a machine as much as for a person.
    const speed = length(ball.velocity);
    const relativeSpeed = Math.max(0, speed / this.rules.ball.serveSpeed - 1);
    const error = profile.aimError + relativeSpeed * profile.speedBlindness;
    const jitterX = this.rng.range(-error, error);
    const jitterY = this.rng.range(-error, error);

    // Blend between the live ball position and the predicted intercept: weaker
    // profiles effectively "follow" the ball, stronger ones commit to the read.
    const blend = profile.anticipation;
    const aimX = ball.position.x + (intercept.x - ball.position.x) * blend + jitterX;
    const aimY = ball.position.y + (intercept.y - ball.position.y) * blend + jitterY;

    // Aggressive profiles offset the paddle so the ball strikes off-centre and
    // leaves at an angle, instead of returning it flat down the middle.
    const offset = profile.aggression * this.rules.paddle.halfWidth * 0.55;
    const attackX = -Math.sign(aimX || 1) * offset;
    const attackY = -Math.sign(aimY || 1) * offset * 0.6;

    this.targetX = aimX + attackX;
    this.targetY = aimY + attackY;
  }
}
