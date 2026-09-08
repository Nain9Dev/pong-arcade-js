import { FIXED_TIMESTEP } from '../domain/rules';

/**
 * Fixed-timestep loop with render interpolation.
 *
 * The old implementation ran physics inside `requestAnimationFrame` and gated it
 * on elapsed milliseconds, which makes the simulation drift with the display
 * refresh rate — a 144 Hz monitor played a different game than a 60 Hz one.
 * Here the simulation always advances in exact `FIXED_TIMESTEP` increments and
 * the leftover time becomes an interpolation factor for the renderer.
 */
export interface LoopCallbacks {
  /** Advances the simulation by exactly `dt`. Called 0..n times per frame. */
  readonly update: (dt: number) => void;
  /** Draws the world, interpolated `alpha` of the way into the pending step. */
  readonly render: (alpha: number, delta: number, elapsed: number) => void;
}

export interface LoopOptions {
  readonly timestep?: number;
  /**
   * Longest real interval a single frame may simulate. Prevents the "spiral of
   * death" after a tab is backgrounded, at the cost of slowing time down.
   */
  readonly maxFrameTime?: number;
}

export class GameLoop {
  private readonly timestep: number;
  private readonly maxFrameTime: number;
  private accumulator = 0;
  private running = false;

  constructor(
    private readonly callbacks: LoopCallbacks,
    options: LoopOptions = {},
  ) {
    this.timestep = options.timestep ?? FIXED_TIMESTEP;
    this.maxFrameTime = options.maxFrameTime ?? 0.25;
  }

  /** Feeds one real frame into the loop. Drive this from a `ClockPort`. */
  frame(delta: number, elapsed: number): void {
    if (!this.running) return;

    this.accumulator += Math.min(delta, this.maxFrameTime);

    let steps = 0;
    const maxSteps = Math.ceil(this.maxFrameTime / this.timestep);
    while (this.accumulator >= this.timestep && steps < maxSteps) {
      this.callbacks.update(this.timestep);
      this.accumulator -= this.timestep;
      steps++;
    }

    const alpha = this.accumulator / this.timestep;
    this.callbacks.render(alpha, delta, elapsed);
  }

  start(): void {
    this.running = true;
    this.accumulator = 0;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
