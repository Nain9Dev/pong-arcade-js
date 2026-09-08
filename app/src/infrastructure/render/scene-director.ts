import type * as THREE from 'three';
import type { Side } from '../../domain/arena';
import { SIDES } from '../../domain/arena';
import type { DomainEvent } from '../../domain/events';
import type { QualityLevel } from '../../application/ports';
import type { CharacterModule, Emote, FrameContext, ReactiveModule, SceneModule } from './models/contract';

/**
 * Composes the cast of the arena and turns gameplay into performance.
 *
 * The renderer owns pixels; this owns *staging*. It holds the visual modules,
 * fans the frame context and the domain events out to them, and — the part that
 * gives the game its character — decides which emote each robot plays in
 * response to what just happened. Keeping that decision here means a module
 * never has to know the rules of the match, and the match never has to know a
 * robot exists.
 */

export interface Performer {
  readonly character: CharacterModule;
  /** Seconds remaining before the character falls back to its idle loop. */
  hold: number;
}

export interface SceneCast {
  readonly robots: Readonly<Record<Side, CharacterModule>>;
  readonly modules: readonly SceneModule[];
  readonly reactive: readonly ReactiveModule[];
}

/** How long each one-shot performance holds before returning to idle. */
const EMOTE_HOLD: Readonly<Record<Emote, number>> = {
  idle: 0,
  ready: 0.6,
  swing: 0.45,
  flinch: 1.1,
  celebrate: 2.4,
  defeat: 3.2,
  taunt: 1.6,
  dizzy: 1.8,
};

export class SceneDirector {
  private readonly performers: Record<Side, Performer>;
  private readonly modules: SceneModule[] = [];
  private readonly reactive: ReactiveModule[] = [];

  constructor(cast: SceneCast) {
    this.performers = {
      near: { character: cast.robots.near, hold: 0 },
      far: { character: cast.robots.far, hold: 0 },
    };
    this.modules.push(...cast.modules);
    this.reactive.push(...cast.reactive);
  }

  /** Every root node the renderer must add to the scene. */
  roots(): THREE.Object3D[] {
    return this.modules.map((module) => module.object3D);
  }

  /**
   * Translates domain events into performances.
   *
   * The mapping is where the comedy lives: the robot that concedes is the one
   * that reacts, the one that scored gloats, and a hit near the edge of the
   * racket reads as a scramble rather than a clean return.
   */
  handleEvents(events: readonly DomainEvent[]): void {
    for (const module of this.reactive) module.handleEvents(events);

    for (const event of events) {
      switch (event.type) {
        case 'paddle-hit':
          this.play(event.side, 'swing');
          // A hit taken on the very edge of the racket looks like a save, so the
          // opponent gets a beat of surprise instead of a confident stance.
          if (event.edge) this.play(event.side === 'near' ? 'far' : 'near', 'dizzy');
          break;
        case 'paddle-miss':
          this.play(event.side, 'flinch');
          break;
        case 'point-scored':
          this.play(event.scorer, 'celebrate');
          this.play(event.conceded, 'flinch');
          break;
        case 'match-won':
          this.play(event.winner, 'celebrate');
          this.play(event.winner === 'near' ? 'far' : 'near', 'defeat');
          break;
        case 'serve':
          for (const side of SIDES) this.play(side, 'ready');
          break;
        case 'wall-bounce':
          break;
      }
    }
  }

  update(ctx: FrameContext): void {
    for (const side of SIDES) {
      const performer = this.performers[side];
      if (performer.hold > 0) {
        performer.hold -= ctx.dt;
        if (performer.hold <= 0) performer.character.play('idle');
      }
    }
    for (const module of this.modules) module.update(ctx);
  }

  setQuality(level: QualityLevel): void {
    for (const module of this.modules) module.setQuality(level);
  }

  dispose(): void {
    for (const module of this.modules) module.dispose();
    this.modules.length = 0;
    this.reactive.length = 0;
  }

  /** Plays an emote, refusing to interrupt a more important one already running. */
  private play(side: Side, emote: Emote): void {
    const performer = this.performers[side];
    const incoming = EMOTE_HOLD[emote];
    // A celebration or a defeat outranks the twitchy per-hit reactions, so a
    // point's reaction is never cut short by the swing that produced it.
    if (performer.hold > incoming && incoming < EMOTE_HOLD.celebrate) return;
    performer.character.play(emote);
    performer.hold = incoming;
  }
}
