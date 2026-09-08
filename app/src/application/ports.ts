import type { Side } from '../domain/arena';
import type { Arena } from '../domain/arena';
import type { PaddleIntent } from '../domain/entities';
import type { DomainEvent } from '../domain/events';
import type { MatchSnapshot } from '../domain/match';
import type { MatchRules } from '../domain/rules';

/**
 * Driven ports — the boundary between the pure game and the browser.
 *
 * Every dependency the game has on the outside world is declared here as an
 * interface. `src/domain` imports nothing from this file; `src/infrastructure`
 * implements it; `src/main.ts` is the only place that knows both sides exist.
 */

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

export type CameraMode = 'chase' | 'cockpit' | 'broadcast';

export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'cockpit', 'broadcast'];

export type QualityLevel = 'low' | 'medium' | 'high';

/**
 * One frame's worth of state. `previous` and `current` bracket the render time;
 * `alpha` in `[0, 1]` says how far between them the display is, so the renderer
 * can interpolate and stay smooth at any refresh rate.
 */
export interface RenderFrame {
  readonly previous: MatchSnapshot;
  readonly current: MatchSnapshot;
  readonly alpha: number;
  /** Wall-clock seconds since the renderer was mounted; drives shader time. */
  readonly time: number;
  /** Real seconds elapsed since the previous rendered frame. */
  readonly delta: number;
  /** True while the match is paused or a menu covers the arena. */
  readonly dimmed: boolean;
}

export interface RendererPort {
  /** Attaches the canvas to the DOM and builds the scene graph. */
  mount(container: HTMLElement, arena: Arena, rules: MatchRules): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Reacts to gameplay: impact flashes, particle bursts, camera shake. */
  handleEvents(events: readonly DomainEvent[]): void;
  render(frame: RenderFrame): void;
  setCameraMode(mode: CameraMode): void;
  /** Which end of the arena the camera sits behind. */
  setPerspective(side: Side): void;
  setQuality(level: QualityLevel): void;
  /** Frames per second measured by the renderer, for adaptive quality. */
  readonly fps: number;
  dispose(): void;
}

// --------------------------------------------------------------------------
// Audio
// --------------------------------------------------------------------------

export interface AudioPort {
  /** Must be called from a user gesture — browsers block audio otherwise. */
  unlock(): void;
  handleEvents(events: readonly DomainEvent[]): void;
  /** Ambient pad intensity in `[0, 1]`, driven by rally tension. */
  setIntensity(value: number): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  dispose(): void;
}

// --------------------------------------------------------------------------
// Input
// --------------------------------------------------------------------------

export type ActionId =
  | 'pause'
  | 'confirm'
  | 'back'
  | 'restart'
  | 'cycle-camera'
  | 'toggle-audio';

/**
 * A sampled input state. Intents are normalised to `[-1, 1]` per axis; actions
 * are edge-triggered and reported once per press.
 */
export interface InputFrame {
  readonly near: PaddleIntent;
  readonly far: PaddleIntent;
  readonly actions: readonly ActionId[];
}

export const EMPTY_INPUT: InputFrame = {
  near: { x: 0, y: 0 },
  far: { x: 0, y: 0 },
  actions: [],
};

export interface InputPort {
  /** Returns and clears the accumulated input for this tick. */
  sample(): InputFrame;
  /** True when the player is steering with a pointer, used to hide the cursor. */
  readonly pointerActive: boolean;
  dispose(): void;
}

// --------------------------------------------------------------------------
// Clock
// --------------------------------------------------------------------------

export interface ClockPort {
  /**
   * Starts calling `onFrame(deltaSeconds, elapsedSeconds)` once per display
   * refresh. Returns a function that stops the loop.
   */
  start(onFrame: (delta: number, elapsed: number) => void): () => void;
}

// --------------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------------

export interface StoragePort {
  read<T>(key: string): T | null;
  write<T>(key: string, value: T): void;
}

// --------------------------------------------------------------------------
// Presentation shell (menus, HUD, overlays)
// --------------------------------------------------------------------------

export type ScreenId = 'menu' | 'playing' | 'paused' | 'over';

export interface HudView {
  readonly screen: ScreenId;
  readonly score: { readonly near: number; readonly far: number };
  readonly labels: { readonly near: string; readonly far: string };
  readonly rally: number;
  readonly longestRally: number;
  readonly ballSpeed: number;
  readonly pointsToWin: number;
  readonly winner: Side | null;
  readonly serveCountdown: number;
  readonly fps: number;
  readonly muted: boolean;
  readonly cameraMode: CameraMode;
}

export interface UiPort {
  render(view: HudView): void;
  /** Fired when the player picks something in a menu. */
  onIntent(handler: (intent: UiIntent) => void): void;
  dispose(): void;
}

export type UiIntent =
  | { readonly type: 'start'; readonly mode: GameModeId; readonly difficulty: string }
  | { readonly type: 'resume' }
  | { readonly type: 'pause' }
  | { readonly type: 'restart' }
  | { readonly type: 'quit-to-menu' }
  | { readonly type: 'cycle-camera' }
  | { readonly type: 'toggle-audio' };

export type GameModeId = 'single' | 'local-versus' | 'demo';
