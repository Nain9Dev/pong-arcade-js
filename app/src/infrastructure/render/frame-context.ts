import * as THREE from 'three';
import type { Arena, Side } from '../../domain/arena';
import type { MatchSnapshot } from '../../domain/match';
import { paddleBounds } from '../../domain/physics';
import type { MatchRules } from '../../domain/rules';
import type { RenderFrame } from '../../application/ports';
import type { BallView, FrameContext, PaddleView } from './models/contract';

/**
 * Builds the interpolated {@link FrameContext} every visual module reads.
 *
 * The simulation runs at a fixed 120 Hz while the display runs at whatever rate
 * it likes, so each rendered frame sits *between* two snapshots and everything
 * visible is interpolated by `alpha`.
 *
 * The one case interpolation must NOT smooth is a discontinuity: when a point is
 * scored the ball is teleported back to the centre, and lerping across that jump
 * would drag it visibly through the whole arena in a single frame. We detect the
 * jump by distance and snap instead.
 */

/** Beyond this much movement in one 1/120 s step, treat it as a teleport. */
const TELEPORT_DISTANCE = 6;

interface MutableBallView {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  speed: number;
  speedRatio: number;
}

interface MutablePaddleView {
  position: THREE.Vector3;
  velocity: THREE.Vector2;
  normalised: THREE.Vector2;
}

export class FrameContextBuilder {
  private readonly arena: Arena;
  private readonly rules: MatchRules;
  private readonly paddleZ: Readonly<Record<Side, number>>;

  // Every vector below is allocated once and mutated in place: this runs on
  // every rendered frame and must not produce garbage.
  private readonly ball: MutableBallView = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    speed: 0,
    speedRatio: 0,
  };

  private readonly paddles: Record<Side, MutablePaddleView> = {
    near: {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector2(),
      normalised: new THREE.Vector2(),
    },
    far: {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector2(),
      normalised: new THREE.Vector2(),
    },
  };

  private readonly context: {
    dt: number;
    time: number;
    ball: BallView;
    paddles: Record<Side, PaddleView>;
    score: { near: number; far: number };
    rally: number;
    phase: MatchSnapshot['phase'];
    dimmed: boolean;
    reducedMotion: boolean;
  };

  constructor(arena: Arena, rules: MatchRules, paddleZ: Readonly<Record<Side, number>>) {
    this.arena = arena;
    this.rules = rules;
    this.paddleZ = paddleZ;
    this.context = {
      dt: 0,
      time: 0,
      ball: this.ball,
      paddles: this.paddles,
      score: { near: 0, far: 0 },
      rally: 0,
      phase: 'serving',
      dimmed: false,
      reducedMotion: false,
    };
  }

  build(frame: RenderFrame, reducedMotion: boolean): FrameContext {
    const { previous, current, alpha } = frame;
    const ctx = this.context;

    ctx.dt = frame.delta;
    ctx.time = frame.time;
    ctx.score.near = current.score.near;
    ctx.score.far = current.score.far;
    ctx.rally = current.rally;
    ctx.phase = current.phase;
    ctx.dimmed = frame.dimmed;
    ctx.reducedMotion = reducedMotion;

    const a = previous.ball.position;
    const b = current.ball.position;
    const jumped =
      Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z) > TELEPORT_DISTANCE;
    const t = jumped ? 1 : alpha;

    this.ball.position.set(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
    );
    this.ball.velocity.set(current.ball.velocity.x, current.ball.velocity.y, current.ball.velocity.z);
    this.ball.spin.set(current.ball.spin.x, current.ball.spin.y, current.ball.spin.z);
    this.ball.speed = current.ballSpeed;
    this.ball.speedRatio = Math.min(1, current.ballSpeed / this.rules.ball.maxSpeed);

    const bounds = paddleBounds(this.arena, this.rules.paddle);
    for (const side of ['near', 'far'] as const) {
      const from = previous.paddles[side];
      const to = current.paddles[side];
      const view = this.paddles[side];
      const x = from.x + (to.x - from.x) * alpha;
      const y = from.y + (to.y - from.y) * alpha;
      view.position.set(x, y, this.paddleZ[side]);
      view.velocity.set(to.vx, to.vy);
      view.normalised.set(
        bounds.maxX > 0 ? THREE.MathUtils.clamp(x / bounds.maxX, -1, 1) : 0,
        bounds.maxY > 0 ? THREE.MathUtils.clamp(y / bounds.maxY, -1, 1) : 0,
      );
    }

    return ctx;
  }
}
