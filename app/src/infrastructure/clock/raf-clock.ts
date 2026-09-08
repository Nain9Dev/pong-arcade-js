import type { ClockPort } from '../../application/ports';

/**
 * `requestAnimationFrame` clock, in seconds.
 *
 * Two things make it safe to hand straight to the fixed-timestep loop: deltas
 * are clamped, and the timebase is re-established (rather than carried) whenever
 * the tab comes back from the background — so a five-minute pause resumes at a
 * normal frame delta instead of dumping five minutes of simulation into one step.
 */

/** Longest delta a single frame may report, in seconds. */
const MAX_DELTA = 0.25;

export const createRafClock = (): ClockPort => ({
  start(onFrame: (delta: number, elapsed: number) => void): () => void {
    let handle: number | null = null;
    let previous = 0;
    /** False until a frame has established the timebase; that frame emits nothing. */
    let primed = false;
    let elapsed = 0;
    let stopped = false;

    const tick = (now: number): void => {
      handle = requestAnimationFrame(tick);
      if (!primed) {
        previous = now;
        primed = true;
        return;
      }
      const delta = Math.min((now - previous) / 1000, MAX_DELTA);
      previous = now;
      elapsed += delta;
      onFrame(delta, elapsed);
    };

    const cancel = (): void => {
      if (handle === null) return;
      cancelAnimationFrame(handle);
      handle = null;
    };

    const schedule = (): void => {
      if (stopped || handle !== null) return;
      primed = false;
      handle = requestAnimationFrame(tick);
    };

    const onVisibilityChange = (): void => {
      if (document.hidden) cancel();
      else schedule();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!document.hidden) schedule();

    return (): void => {
      if (stopped) return;
      stopped = true;
      cancel();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  },
});
