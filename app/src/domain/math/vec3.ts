/**
 * Immutable 3D vector algebra.
 *
 * The whole domain layer is deterministic and allocation-light: vectors are plain
 * frozen-by-convention records so that snapshots can be structurally compared in
 * property-based tests without any custom equality logic.
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });

/** `a + b * k` — fused multiply-add, the hot path of every integration step. */
export const addScaled = (a: Vec3, b: Vec3, k: number): Vec3 => ({
  x: a.x + b.x * k,
  y: a.y + b.y * k,
  z: a.z + b.z * k,
});

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;

export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

/** Returns a unit vector, or `ZERO` when the input is degenerate. */
export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len) : ZERO;
};

/** Rescales `a` to exactly `target` length. Degenerate inputs stay at `ZERO`. */
export const withLength = (a: Vec3, target: number): Vec3 => scale(normalize(a), target);

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Component-wise mirror across an axis-aligned plane normal. */
export const reflectAxis = (v: Vec3, axis: 'x' | 'y' | 'z'): Vec3 =>
  axis === 'x'
    ? { x: -v.x, y: v.y, z: v.z }
    : axis === 'y'
      ? { x: v.x, y: -v.y, z: v.z }
      : { x: v.x, y: v.y, z: -v.z };

export const isFinite3 = (v: Vec3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
