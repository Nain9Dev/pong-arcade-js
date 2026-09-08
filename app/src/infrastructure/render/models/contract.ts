import type * as THREE from 'three';
import type { Side } from '../../../domain/arena';
import type { DomainEvent } from '../../../domain/events';
import type { MatchPhase } from '../../../domain/match';
import type { QualityLevel } from '../../../application/ports';

/**
 * The contract every visual module in the arena implements.
 *
 * The scene is assembled from independent modules — characters, stadium, crowd,
 * effects — that never reference each other. Each one owns a subtree of the
 * scene graph, reads the same read-only `FrameContext`, and reacts to the same
 * domain events. That keeps a 3D scene of this size composable: a module can be
 * rewritten, disabled at low quality, or dropped entirely without touching the
 * rest of the renderer.
 */
export interface SceneModule {
  /** The root node this module owns. The renderer adds it to the scene. */
  readonly object3D: THREE.Object3D;
  update(ctx: FrameContext): void;
  setQuality(level: QualityLevel): void;
  /** Releases every geometry, material and texture the module created. */
  dispose(): void;
}

/** A module that also reacts to gameplay. */
export interface ReactiveModule extends SceneModule {
  handleEvents(events: readonly DomainEvent[]): void;
}

/** Interpolated, render-ready view of one frame. Never mutate these vectors. */
export interface FrameContext {
  /** Real seconds since the previous rendered frame. */
  readonly dt: number;
  /** Seconds since the renderer was mounted; drives all idle animation. */
  readonly time: number;
  readonly ball: BallView;
  readonly paddles: Readonly<Record<Side, PaddleView>>;
  readonly score: { readonly near: number; readonly far: number };
  readonly rally: number;
  readonly phase: MatchPhase;
  /** True while a menu or pause overlay covers the arena. */
  readonly dimmed: boolean;
  /** Mirrors `prefers-reduced-motion`; modules must damp animation when set. */
  readonly reducedMotion: boolean;
}

export interface BallView {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly spin: THREE.Vector3;
  readonly speed: number;
  /** `speed / maxSpeed`, in `[0, 1]` — the game's tension signal. */
  readonly speedRatio: number;
}

export interface PaddleView {
  readonly position: THREE.Vector3;
  /** Lateral/vertical velocity in world units per second. */
  readonly velocity: THREE.Vector2;
  /** Normalised travel inside its own bounds, both axes in `[-1, 1]`. */
  readonly normalised: THREE.Vector2;
}

/**
 * Character performance states. The renderer decides *when* to trigger them from
 * domain events; the character module decides what they look like.
 */
export type Emote =
  | 'idle'
  | 'ready'
  | 'swing'
  | 'flinch'
  | 'celebrate'
  | 'defeat'
  | 'taunt'
  | 'dizzy';

export interface CharacterModule extends ReactiveModule {
  /** Plays a one-shot performance; overrides whatever is currently playing. */
  play(emote: Emote): void;
  /** Where this character's racket face currently is, for FX anchoring. */
  readonly racketAnchor: THREE.Object3D;
}
