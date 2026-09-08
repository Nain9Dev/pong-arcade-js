import type * as THREE from 'three';

import type { Arena, Side } from '../../domain/arena';
import { SIDES } from '../../domain/arena';
import type { DomainEvent } from '../../domain/events';
import type { MatchRules } from '../../domain/rules';
import type { QualityLevel } from '../../application/ports';
import type { FrameContext, ReactiveModule, SceneModule } from './models/contract';
import type { EffectsModule } from './models/fx';
import { createEffects } from './models/fx';
import type { RacketModule } from './models/racket';
import { createRacket } from './models/racket';
import { createRobot } from './models/robot';
import { createBallCharacter } from './models/ball-character';
import { createCrowd } from './models/crowd';
import { createDrones } from './models/drones';
import { Jumbotron } from './models/scoreboard';
import { SceneDirector } from './scene-director';

/**
 * Assembles the arena's cast and hands the renderer a single thing to drive.
 *
 * Keeping the wiring here rather than inside the renderer means the renderer
 * stays about pixels — canvas, camera, bloom, frame timing — while this file
 * owns *who is on stage*. Adding a performer is a change to one list.
 */
export interface Cast {
  readonly director: SceneDirector;
  readonly effects: EffectsModule;
  readonly jumbotron: Jumbotron;
  /** Root nodes the renderer must add to the scene. */
  readonly roots: readonly THREE.Object3D[];
  handleEvents(events: readonly DomainEvent[]): void;
  update(ctx: FrameContext): void;
  setQuality(level: QualityLevel): void;
  dispose(): void;
}

export const createCast = (arena: Arena, rules: MatchRules): Cast => {
  // 'chispa' is the small eager one on the player's side; 'tornillo' is the
  // taller, dented, faintly smug opponent.
  const robots = {
    near: createRobot({ side: 'near', variant: 'chispa', arena, rules }),
    far: createRobot({ side: 'far', variant: 'tornillo', arena, rules }),
  } as const;

  const rackets: Record<Side, RacketModule> = {
    near: createRacket({ side: 'near', rules }),
    far: createRacket({ side: 'far', rules }),
  };

  // The rackets stop driving their own transform and become children of the
  // robots' hands, so a swing moves the hitbox visual for real.
  for (const side of SIDES) {
    rackets[side].setAutoFollow(false);
    robots[side].racketAnchor.add(rackets[side].object3D);
  }

  const ball = createBallCharacter({ rules });
  const crowd = createCrowd({ arena });
  const drones = createDrones({ arena });
  const effects = createEffects({ arena, rules });
  const jumbotron = new Jumbotron(arena, rules);

  const modules: SceneModule[] = [
    robots.near,
    robots.far,
    rackets.near,
    rackets.far,
    ball,
    crowd,
    drones,
    effects,
  ];
  const reactive: ReactiveModule[] = [robots.near, robots.far, ball, crowd, effects];

  const director = new SceneDirector({ robots, modules, reactive });

  // Racket subtrees hang off the robots, so only the robots' roots are added.
  const roots: THREE.Object3D[] = [
    robots.near.object3D,
    robots.far.object3D,
    ball.object3D,
    crowd.object3D,
    drones.object3D,
    effects.object3D,
    jumbotron.object,
  ];

  return {
    director,
    effects,
    jumbotron,
    roots,

    handleEvents(events) {
      director.handleEvents(events);
      for (const event of events) {
        if (event.type === 'paddle-hit') {
          // The string bed rings where the ball actually struck it.
          rackets[event.side].impact(
            Math.min(1, event.speed / rules.ball.maxSpeed + 0.35),
            event.offset.x,
            event.offset.y,
          );
          rackets[event.side].swing(event.edge ? 1 : 0.6);
        } else if (event.type === 'point-scored') {
          jumbotron.setScore(event.score.near, event.score.far);
          jumbotron.celebrate(event.scorer, 1);
        }
      }
    },

    update(ctx) {
      director.update(ctx);
      jumbotron.update(ctx.time, ctx.dt, ctx.dimmed ? 1 : 0, ctx.reducedMotion);
    },

    setQuality(level) {
      director.setQuality(level);
      jumbotron.setQuality(level);
    },

    dispose() {
      director.dispose();
      jumbotron.dispose();
    },
  };
};
