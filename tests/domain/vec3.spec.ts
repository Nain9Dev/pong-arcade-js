import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  add,
  addScaled,
  clamp,
  cross,
  dot,
  isFinite3,
  length,
  lengthSq,
  lerp,
  normalize,
  reflectAxis,
  scale,
  sub,
  vec3,
  withLength,
  ZERO,
} from '../../app/src/domain/math/vec3';
import { finite, vec3Arb } from '../support/fixtures';

const RUNS = { numRuns: 300, seed: 0xc0ffee } as const;
const AXES = ['x', 'y', 'z'] as const;

describe('vec3 algebra', () => {
  it('exposes ZERO as the additive identity', () => {
    fc.assert(
      fc.property(vec3Arb(1e6), (v) => {
        expect(add(v, ZERO)).toEqual(v);
        expect(sub(v, ZERO)).toEqual(v);
      }),
      RUNS,
    );
  });

  it('addScaled agrees with add + scale', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), vec3Arb(1e3), finite(1e3), (a, b, k) => {
        const fused = addScaled(a, b, k);
        const naive = add(a, scale(b, k));
        expect(fused.x).toBeCloseTo(naive.x, 9);
        expect(fused.y).toBeCloseTo(naive.y, 9);
        expect(fused.z).toBeCloseTo(naive.z, 9);
      }),
      RUNS,
    );
  });

  it('length is the square root of lengthSq', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), (v) => {
        expect(length(v)).toBeCloseTo(Math.sqrt(lengthSq(v)), 9);
      }),
      RUNS,
    );
  });

  it('cross is orthogonal to both operands', () => {
    fc.assert(
      fc.property(vec3Arb(100), vec3Arb(100), (a, b) => {
        const c = cross(a, b);
        // Scale the tolerance with the magnitudes: the cancellation error of a
        // cross product grows with the size of its inputs.
        const tolerance = 1e-9 * (1 + length(a) * length(b) * length(c));
        expect(Math.abs(dot(c, a))).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(dot(c, b))).toBeLessThanOrEqual(tolerance);
      }),
      RUNS,
    );
  });
});

describe('normalize', () => {
  it('returns a unit vector, or ZERO for degenerate input', () => {
    fc.assert(
      fc.property(vec3Arb(1e4), (v) => {
        const unit = normalize(v);
        if (length(v) > 1e-9) {
          expect(length(unit)).toBeCloseTo(1, 12);
        } else {
          expect(unit).toEqual(ZERO);
        }
      }),
      RUNS,
    );
  });

  it('preserves direction', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), (v) => {
        fc.pre(length(v) > 1e-3);
        const unit = normalize(v);
        // A vector and its normalisation are colinear and co-oriented.
        expect(dot(unit, v)).toBeCloseTo(length(v), 6);
      }),
      RUNS,
    );
  });

  it('maps ZERO to ZERO', () => {
    expect(normalize(ZERO)).toEqual(ZERO);
    expect(normalize(vec3(1e-12, 0, 0))).toEqual(ZERO);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), (v) => {
        const once = normalize(v);
        const twice = normalize(once);
        expect(twice.x).toBeCloseTo(once.x, 12);
        expect(twice.y).toBeCloseTo(once.y, 12);
        expect(twice.z).toBeCloseTo(once.z, 12);
      }),
      RUNS,
    );
  });
});

describe('withLength', () => {
  it('rescales to exactly the requested length', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), fc.double({ min: 1e-3, max: 1e3, noNaN: true }), (v, target) => {
        fc.pre(length(v) > 1e-6);
        expect(length(withLength(v, target))).toBeCloseTo(target, 9);
      }),
      RUNS,
    );
  });

  it('keeps degenerate vectors at ZERO whatever the target', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e3, max: 1e3, noNaN: true }), (target) => {
        const result = withLength(ZERO, target);
        // Compared through length: a negative target multiplies into signed
        // zeroes, which are numerically identical but not structurally equal.
        expect(length(result)).toBe(0);
        expect(isFinite3(result)).toBe(true);
      }),
      RUNS,
    );
  });

  it('flips the direction for a negative target', () => {
    const v = vec3(3, 0, 4);
    const flipped = withLength(v, -10);
    expect(flipped.x).toBeCloseTo(-6, 12);
    expect(flipped.z).toBeCloseTo(-8, 12);
    expect(length(flipped)).toBeCloseTo(10, 12);
  });
});

describe('reflectAxis', () => {
  it('is an involution on every axis', () => {
    fc.assert(
      fc.property(vec3Arb(1e6), fc.constantFrom(...AXES), (v, axis) => {
        expect(reflectAxis(reflectAxis(v, axis), axis)).toEqual(v);
      }),
      RUNS,
    );
  });

  it('negates only the chosen component and preserves length', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), fc.constantFrom(...AXES), (v, axis) => {
        const r = reflectAxis(v, axis);
        expect(length(r)).toBeCloseTo(length(v), 12);
        for (const other of AXES) {
          if (other === axis) expect(r[other]).toBe(-v[other]);
          else expect(r[other]).toBe(v[other]);
        }
      }),
      RUNS,
    );
  });
});

describe('scalar helpers', () => {
  it('clamp always lands inside the interval and is the identity inside it', () => {
    fc.assert(
      fc.property(finite(1e4), finite(1e4), finite(1e4), (value, a, b) => {
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        const result = clamp(value, min, max);
        expect(result).toBeGreaterThanOrEqual(min);
        expect(result).toBeLessThanOrEqual(max);
        if (value >= min && value <= max) expect(result).toBe(value);
      }),
      RUNS,
    );
  });

  it('lerp interpolates the endpoints exactly', () => {
    fc.assert(
      fc.property(vec3Arb(1e3), vec3Arb(1e3), (a, b) => {
        expect(lerp(a, b, 0)).toEqual(a);
        const end = lerp(a, b, 1);
        expect(end.x).toBeCloseTo(b.x, 9);
        expect(end.y).toBeCloseTo(b.y, 9);
        expect(end.z).toBeCloseTo(b.z, 9);
      }),
      RUNS,
    );
  });

  it('isFinite3 rejects any non-finite component', () => {
    expect(isFinite3(vec3(1, 2, 3))).toBe(true);
    expect(isFinite3(vec3(Number.NaN, 0, 0))).toBe(false);
    expect(isFinite3(vec3(0, Number.POSITIVE_INFINITY, 0))).toBe(false);
    expect(isFinite3(vec3(0, 0, Number.NEGATIVE_INFINITY))).toBe(false);
  });
});
