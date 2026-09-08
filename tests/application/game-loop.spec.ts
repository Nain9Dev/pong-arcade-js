import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LoopOptions } from '../../app/src/application/game-loop';
import { GameLoop } from '../../app/src/application/game-loop';
import { FIXED_TIMESTEP } from '../../app/src/domain/rules';

interface Recorder {
  readonly loop: GameLoop;
  readonly updates: number[];
  readonly renders: { alpha: number; delta: number; elapsed: number }[];
}

const recorder = (options: LoopOptions = {}): Recorder => {
  const updates: number[] = [];
  const renders: { alpha: number; delta: number; elapsed: number }[] = [];
  const loop = new GameLoop(
    {
      update: (dt) => updates.push(dt),
      render: (alpha, delta, elapsed) => renders.push({ alpha, delta, elapsed }),
    },
    options,
  );
  return { loop, updates, renders };
};

describe('GameLoop', () => {
  it('does nothing until it is started', () => {
    const { loop, updates, renders } = recorder();
    loop.frame(1, 1);
    expect(loop.isRunning).toBe(false);
    expect(updates).toHaveLength(0);
    expect(renders).toHaveLength(0);
  });

  it('always advances the simulation in exact fixed steps', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 0.2, noNaN: true }), { minLength: 1, maxLength: 60 }),
        (frames) => {
          const { loop, updates } = recorder();
          loop.start();
          let elapsed = 0;
          for (const delta of frames) {
            elapsed += delta;
            loop.frame(delta, elapsed);
          }
          expect(updates.every((dt) => dt === FIXED_TIMESTEP)).toBe(true);
        },
      ),
      { numRuns: 100, seed: 0x100f },
    );
  });

  it('reports an interpolation alpha inside [0, 1)', () => {
    const { loop, renders } = recorder();
    loop.start();
    let elapsed = 0;
    for (let i = 0; i < 200; i++) {
      const delta = 1 / 60 + (i % 7) * 0.0003;
      elapsed += delta;
      loop.frame(delta, elapsed);
    }
    expect(renders).toHaveLength(200);
    for (const frame of renders) {
      expect(frame.alpha).toBeGreaterThanOrEqual(0);
      expect(frame.alpha).toBeLessThan(1);
    }
  });

  it('clamps a long stall instead of spiralling', () => {
    const { loop, updates } = recorder({ maxFrameTime: 0.25 });
    loop.start();
    loop.frame(30, 30);
    // 0.25 s of catch-up at 1/120 s per step.
    expect(updates.length).toBeLessThanOrEqual(Math.ceil(0.25 / FIXED_TIMESTEP));
    expect(updates.length).toBeGreaterThan(0);
  });

  it('honours a custom timestep', () => {
    const { loop, updates } = recorder({ timestep: 0.01 });
    loop.start();
    loop.frame(0.055, 0.055);
    expect(updates).toEqual([0.01, 0.01, 0.01, 0.01, 0.01]);
  });

  it('drops the accumulator on restart and stops on demand', () => {
    const { loop, updates } = recorder();
    loop.start();
    loop.frame(0.004, 0.004);
    expect(updates).toHaveLength(0);

    loop.start();
    expect(loop.isRunning).toBe(true);
    loop.frame(0.004, 0.008);
    expect(updates).toHaveLength(0);

    loop.stop();
    loop.frame(1, 1);
    expect(loop.isRunning).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
