import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  containsPoint,
  goalPlaneZ,
  opposite,
  paddlePlaneZ,
  SIDES,
  sideSign,
} from '../../app/src/domain/arena';
import { vec3 } from '../../app/src/domain/math/vec3';
import { ARENA, vec3Arb } from '../support/fixtures';

const RUNS = { numRuns: 200, seed: 0xa2e4 } as const;

describe('arena geometry', () => {
  it('pairs the two sides as opposites', () => {
    expect(SIDES).toEqual(['near', 'far']);
    for (const side of SIDES) {
      expect(opposite(opposite(side))).toBe(side);
      expect(opposite(side)).not.toBe(side);
      expect(Math.abs(sideSign(side))).toBe(1);
      expect(sideSign(opposite(side))).toBe(-sideSign(side));
    }
  });

  it('places each goal behind its own paddle plane', () => {
    const plane = paddlePlaneZ(ARENA);
    expect(plane).toBeCloseTo(ARENA.halfDepth - ARENA.paddleInset, 12);
    for (const side of SIDES) {
      const goal = goalPlaneZ(ARENA, side);
      expect(Math.sign(goal)).toBe(sideSign(side));
      expect(Math.abs(goal)).toBe(ARENA.halfDepth);
      expect(Math.abs(goal)).toBeGreaterThan(plane);
    }
  });

  it('containsPoint agrees with the box half-extents', () => {
    fc.assert(
      fc.property(vec3Arb(30), (point) => {
        const inside =
          Math.abs(point.x) <= ARENA.halfWidth &&
          Math.abs(point.y) <= ARENA.halfHeight &&
          Math.abs(point.z) <= ARENA.halfDepth;
        expect(containsPoint(ARENA, point)).toBe(inside);
      }),
      RUNS,
    );
  });

  it('containsPoint inflates the box by the margin', () => {
    const justOutside = vec3(ARENA.halfWidth + 0.5, 0, 0);
    expect(containsPoint(ARENA, justOutside)).toBe(false);
    expect(containsPoint(ARENA, justOutside, 0.5)).toBe(true);
    expect(containsPoint(ARENA, vec3(0, 0, 0))).toBe(true);
  });
});
