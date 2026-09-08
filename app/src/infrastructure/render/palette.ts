import type { Side } from '../../domain/arena';
import type { QualityLevel } from '../../application/ports';

/**
 * The visual identity of the game in one place.
 *
 * Colours are plain hex numbers rather than `THREE.Color` instances so this
 * module stays free of any renderer dependency and can be read by the HUD or a
 * future WebGPU adapter without dragging Three.js in.
 */
export interface SideTheme {
  /** Primary neon, used for emissive surfaces and particles. */
  readonly core: number;
  /** Lighter tint for halos and additive glows, so bloom does not clip to white. */
  readonly glow: number;
  /** Deep tint used where the colour has to survive against the black arena. */
  readonly deep: number;
}

export const SIDE_THEME: Readonly<Record<Side, SideTheme>> = {
  near: { core: 0x22d3ee, glow: 0x99f6ff, deep: 0x083344 },
  far: { core: 0xf43f5e, glow: 0xffc0cb, deep: 0x4c0519 },
};

export const PALETTE = {
  background: 0x03040c,
  /** Base tone of the tunnel walls between the grid lines. */
  wall: 0x05061a,
  gridMajor: 0x3b6fd8,
  gridMinor: 0x1b2a6b,
  edge: 0x67e8f9,
  ball: 0xfefeff,
  ballHalo: 0xbae6fd,
  spark: 0xf8fafc,
} as const;

export interface QualityProfile {
  readonly bloom: boolean;
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
  /** Upper bound on particles alive at once. */
  readonly particleBudget: number;
  /** Particles spawned per unit of burst intensity. */
  readonly burstScale: number;
  readonly trailSamples: number;
  readonly ballLight: boolean;
  /** Hard cap applied on top of the device pixel ratio. */
  readonly maxPixelRatio: number;
  /** Enables the secondary (fine) grid and the wall ripple response. */
  readonly gridDetail: boolean;
  /** Number of receding frames drawn beyond each goal. */
  readonly goalRings: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityLevel, QualityProfile>> = {
  low: {
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0,
    bloomThreshold: 1,
    particleBudget: 256,
    burstScale: 0.35,
    trailSamples: 10,
    ballLight: false,
    maxPixelRatio: 1,
    gridDetail: false,
    goalRings: 2,
  },
  medium: {
    bloom: true,
    bloomStrength: 0.65,
    bloomRadius: 0.5,
    bloomThreshold: 0.62,
    particleBudget: 768,
    burstScale: 0.7,
    trailSamples: 22,
    ballLight: true,
    maxPixelRatio: 1.5,
    gridDetail: true,
    goalRings: 3,
  },
  high: {
    bloom: true,
    bloomStrength: 0.95,
    bloomRadius: 0.62,
    bloomThreshold: 0.5,
    particleBudget: 2048,
    burstScale: 1,
    trailSamples: 40,
    ballLight: true,
    maxPixelRatio: 2,
    gridDetail: true,
    goalRings: 4,
  },
};

/** Largest budget any profile can ask for — buffers are sized once, at mount. */
export const MAX_PARTICLES = QUALITY_PROFILES.high.particleBudget;

export const MAX_TRAIL_SAMPLES = QUALITY_PROFILES.high.trailSamples;
