/**
 * Deterministic pseudo-random number generator (mulberry32).
 *
 * The domain never touches `Math.random`: every stochastic decision flows through
 * this port so that a match is fully reproducible from `(seed, input trace)`.
 * That property is what makes the physics testable with `fast-check` and what
 * would make replay sharing or server-side verification possible later.
 */
export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform in `[min, max)`. */
  range(min: number, max: number): number;
  /** Uniformly `true` or `false`. */
  bool(): boolean;
  /** Current internal state — enough to resume the exact same stream. */
  readonly state: number;
}

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    bool: () => next() < 0.5,
    get state() {
      return state;
    },
  };
};

/** Seed derived from wall-clock time — used only at the composition root. */
export const randomSeed = (): number => (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
