import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, randomSeed } from '../../app/src/domain/rng';

const RUNS = { numRuns: 200, seed: 0x5eed } as const;
const seedArb = fc.integer({ min: 0, max: 0xffffffff });

const draw = (seed: number, count: number): number[] => {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
};

describe('createRng determinism', () => {
  it('produces an identical stream for the same seed', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        expect(draw(seed, 256)).toEqual(draw(seed, 256));
      }),
      RUNS,
    );
  });

  it('treats the seed as an unsigned 32-bit value', () => {
    expect(draw(-1, 8)).toEqual(draw(0xffffffff, 8));
    expect(draw(0, 8)).toEqual(draw(0x100000000, 8));
  });

  it('can be resumed from an exposed state', () => {
    fc.assert(
      fc.property(seedArb, fc.integer({ min: 1, max: 64 }), (seed, warmup) => {
        const original = createRng(seed);
        for (let i = 0; i < warmup; i++) original.next();

        const resumed = createRng(original.state);
        const tail = Array.from({ length: 32 }, () => original.next());
        const replay = Array.from({ length: 32 }, () => resumed.next());
        expect(replay).toEqual(tail);
      }),
      RUNS,
    );
  });

  it('separates streams started from different seeds', () => {
    // Not a guarantee of the algorithm, but a 256-draw collision would signal a
    // broken state update rather than bad luck.
    expect(draw(1, 256)).not.toEqual(draw(2, 256));
  });
});

describe('createRng distribution', () => {
  it('next() stays in [0, 1)', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const rng = createRng(seed);
        for (let i = 0; i < 64; i++) {
          const value = rng.next();
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
      RUNS,
    );
  });

  it('range() stays within its bounds', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        (seed, a, b) => {
          const min = Math.min(a, b);
          const max = Math.max(a, b);
          const rng = createRng(seed);
          for (let i = 0; i < 32; i++) {
            const value = rng.range(min, max);
            expect(value).toBeGreaterThanOrEqual(min);
            expect(value).toBeLessThanOrEqual(max);
          }
        },
      ),
      RUNS,
    );
  });

  it('range() collapses to a point for an empty interval', () => {
    const rng = createRng(11);
    for (let i = 0; i < 16; i++) expect(rng.range(3, 3)).toBe(3);
  });

  it('is not degenerate: uniform across ten buckets', () => {
    const samples = 20000;
    const buckets = new Array<number>(10).fill(0);
    const rng = createRng(0xbadc0de);
    let sum = 0;

    for (let i = 0; i < samples; i++) {
      const value = rng.next();
      sum += value;
      const index = Math.min(9, Math.floor(value * 10));
      buckets[index] = (buckets[index] ?? 0) + 1;
    }

    expect(sum / samples).toBeCloseTo(0.5, 2);
    for (const count of buckets) {
      expect(count).toBeGreaterThan(samples * 0.08);
      expect(count).toBeLessThan(samples * 0.12);
    }
    // A degenerate generator would repeat values; 20k draws must be near-unique.
    expect(new Set(buckets).size).toBeGreaterThan(1);
  });

  it('bool() is a fair coin', () => {
    const rng = createRng(0x1234);
    let heads = 0;
    const flips = 10000;
    for (let i = 0; i < flips; i++) if (rng.bool()) heads++;
    expect(heads / flips).toBeGreaterThan(0.47);
    expect(heads / flips).toBeLessThan(0.53);
  });
});

describe('randomSeed', () => {
  it('returns an unsigned 32-bit integer', () => {
    for (let i = 0; i < 32; i++) {
      const seed = randomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
