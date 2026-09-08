import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { Pass } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import type { Arena, Side } from '../../domain/arena';
import { goalPlaneZ, SIDES, sideSign } from '../../domain/arena';
import type { DomainEvent } from '../../domain/events';
import type { MatchSnapshot } from '../../domain/match';
import type { MatchRules } from '../../domain/rules';
import type {
  CameraMode,
  QualityLevel,
  RendererPort,
  RenderFrame,
} from '../../application/ports';
import { BallVisual, PaddleVisual } from './actors';
import { ArenaMesh } from './arena-mesh';
import { CameraRig } from './camera-rig';
import { ScreenOverlay } from './overlay';
import type { QualityProfile } from './palette';
import { MAX_PARTICLES, MAX_TRAIL_SAMPLES, PALETTE, QUALITY_PROFILES, SIDE_THEME } from './palette';
import { ParticleField } from './particles';
import { createBandGlowTexture, createRadialGlowTexture } from './textures';
import { BallTrail } from './trail';

/** Everything that only exists between `mount()` and `dispose()`. */
interface Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly rig: CameraRig;
  readonly arena: Arena;
  readonly rules: MatchRules;
  readonly arenaMesh: ArenaMesh;
  readonly paddles: Readonly<Record<Side, PaddleVisual>>;
  readonly ball: BallVisual;
  readonly trail: BallTrail;
  readonly particles: ParticleField;
  readonly overlay: ScreenOverlay;
  readonly lights: THREE.Light[];
  readonly textures: THREE.Texture[];
  readonly passes: Pass[];
  composer: EffectComposer | null;
  bloom: UnrealBloomPass | null;
}

const FPS_WINDOW = 60;

/** Frame-rate independent exponential approach factor. */
const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Three.js implementation of `RendererPort`.
 *
 * The class owns no game logic whatsoever: it consumes interpolated snapshots
 * and domain events and turns them into light. Every dimension it draws is
 * derived from the `Arena` and `MatchRules` handed to `mount`, so changing the
 * box in the domain reshapes the whole visual without touching this file.
 */
class ThreeRenderer implements RendererPort {
  private stage: Stage | null = null;
  private profile: QualityProfile = QUALITY_PROFILES.high;
  private cameraMode: CameraMode = 'chase';
  private perspective: Side = 'near';

  private width = 1;
  private height = 1;
  private requestedPixelRatio = 1;

  private time = 0;
  private dim = 0;
  private scroll = 0;
  private motionScale = 1;
  /** Side that last touched the ball; tints the trail and the halo. */
  private lastHitter: Side = 'near';
  private celebration = 0;
  private celebrationCooldown = 0;
  private celebrationSide: Side = 'near';

  private readonly frameDurations = new Float64Array(FPS_WINDOW);
  private frameCursor = 0;
  private frameCount = 0;
  private frameSum = 0;
  private lastStamp = 0;
  private fpsValue = 0;

  private motionQuery: MediaQueryList | null = null;

  private readonly ballPosition = new THREE.Vector3();
  private readonly eventPosition = new THREE.Vector3();
  private readonly burstDirection = new THREE.Vector3();
  private readonly burstColor = new THREE.Color();
  private readonly tint = new THREE.Color();

  private readonly onMotionPreferenceChange = (event: MediaQueryListEvent): void => {
    this.applyMotionPreference(event.matches);
  };

  get fps(): number {
    return this.fpsValue;
  }

  mount(container: HTMLElement, arena: Arena, rules: MatchRules): void {
    if (this.stage !== null) this.dispose();

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(PALETTE.background, 1);

    const canvas = renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.display = 'block';
    canvas.style.zIndex = '0';
    // The pointer adapter steers the paddle by dragging over the arena.
    canvas.style.touchAction = 'none';
    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.background);

    this.width = Math.max(1, container.clientWidth || window.innerWidth);
    this.height = Math.max(1, container.clientHeight || window.innerHeight);
    const rig = new CameraRig(arena, this.width / this.height);
    rig.setMode(this.cameraMode);
    rig.setPerspective(this.perspective);
    // The overlay quads are children of the camera, so the camera has to be part
    // of the graph for them to be drawn.
    scene.add(rig.camera);

    const haloTexture = createRadialGlowTexture(128, 2.6);
    const bandTexture = createBandGlowTexture(128);

    const arenaMesh = new ArenaMesh(arena, rules);
    scene.add(arenaMesh.object);

    const paddles: Record<Side, PaddleVisual> = {
      near: new PaddleVisual('near', arena, rules, bandTexture),
      far: new PaddleVisual('far', arena, rules, bandTexture),
    };
    for (const side of SIDES) scene.add(paddles[side].object);

    const ball = new BallVisual(rules.ball.radius, haloTexture);
    scene.add(ball.object);

    const trail = new BallTrail(MAX_TRAIL_SAMPLES, rules.ball.radius);
    scene.add(trail.object);

    const particles = new ParticleField(MAX_PARTICLES, arena.halfHeight * 0.9);
    scene.add(particles.object);

    const lights: THREE.Light[] = [new THREE.AmbientLight(0x2a3a6b, 1.4)];
    for (const side of SIDES) {
      const light = new THREE.PointLight(SIDE_THEME[side].core, 160, arena.halfDepth * 2, 1.7);
      light.position.set(0, arena.halfHeight * 0.5, goalPlaneZ(arena, side) * 0.8);
      lights.push(light);
    }
    for (const light of lights) scene.add(light);

    const overlay = new ScreenOverlay(rig.camera);

    this.stage = {
      renderer,
      scene,
      rig,
      arena,
      rules,
      arenaMesh,
      paddles,
      ball,
      trail,
      particles,
      overlay,
      lights,
      textures: [haloTexture, bandTexture],
      passes: [],
      composer: null,
      bloom: null,
    };

    this.attachMotionQuery();
    this.applyQuality();
    this.resize(this.width, this.height, this.requestedPixelRatio);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.requestedPixelRatio = Math.max(0.5, pixelRatio);

    const stage = this.stage;
    if (stage === null) return;

    const ratio = Math.min(this.requestedPixelRatio, 2, this.profile.maxPixelRatio);
    stage.renderer.setPixelRatio(ratio);
    stage.renderer.setSize(this.width, this.height);
    stage.rig.setAspect(this.width / this.height);
    stage.particles.setPixelRatio(ratio);

    if (stage.composer !== null) {
      stage.composer.setPixelRatio(ratio);
      stage.composer.setSize(this.width, this.height);
    }
  }

  handleEvents(events: readonly DomainEvent[]): void {
    const stage = this.stage;
    if (stage === null) return;

    for (const event of events) {
      switch (event.type) {
        case 'wall-bounce': {
          this.eventPosition.set(event.position.x, event.position.y, event.position.z);
          this.burstColor.set(PALETTE.spark);
          stage.particles.burst({
            origin: this.eventPosition,
            color: this.burstColor,
            count: Math.round((6 + 14 * event.intensity) * this.profile.burstScale),
            speed: 4 + 9 * event.intensity,
            size: 0.4,
            life: 0.45,
            time: this.time,
          });
          stage.arenaMesh.ripple(
            event.position.x,
            event.position.y,
            event.position.z,
            this.time,
          );
          stage.rig.shake(0.05 + event.intensity * 0.07);
          break;
        }

        case 'paddle-hit': {
          this.lastHitter = event.side;
          const theme = SIDE_THEME[event.side];
          const speed01 = Math.min(1, event.speed / stage.rules.ball.maxSpeed);
          this.eventPosition.set(event.position.x, event.position.y, event.position.z);
          this.burstColor.set(event.edge ? theme.glow : theme.core);
          this.burstDirection.set(event.offset.x * 0.4, event.offset.y * 0.4, -sideSign(event.side));
          this.burstDirection.normalize();
          stage.particles.burst({
            origin: this.eventPosition,
            color: this.burstColor,
            count: Math.round((event.edge ? 90 : 44) * this.profile.burstScale),
            speed: 7 + speed01 * 16,
            spread: 0.7,
            direction: this.burstDirection,
            focus: 0.55,
            size: event.edge ? 0.85 : 0.6,
            life: event.edge ? 0.8 : 0.55,
            time: this.time,
          });
          stage.paddles[event.side].pulse(event.edge ? 1.1 : 0.75);
          stage.rig.shake(0.1 + speed01 * 0.32 + (event.edge ? 0.14 : 0));
          break;
        }

        case 'paddle-miss': {
          this.eventPosition.set(event.position.x, event.position.y, event.position.z);
          this.burstColor.set(SIDE_THEME[event.side].deep);
          stage.particles.burst({
            origin: this.eventPosition,
            color: this.burstColor,
            count: Math.round(14 * this.profile.burstScale),
            speed: 3.5,
            size: 0.45,
            life: 0.7,
            time: this.time,
          });
          break;
        }

        case 'point-scored': {
          const theme = SIDE_THEME[event.scorer];
          this.eventPosition.set(0, 0, goalPlaneZ(stage.arena, event.conceded));
          this.burstColor.set(theme.core);
          stage.particles.burst({
            origin: this.eventPosition,
            color: this.burstColor,
            count: Math.round(220 * this.profile.burstScale),
            speed: 14,
            spread: 0.85,
            size: 1,
            life: 1.4,
            time: this.time,
          });
          stage.overlay.pulse(theme.glow, 0.5);
          stage.rig.shake(0.55);
          stage.trail.reset();
          break;
        }

        case 'serve': {
          stage.trail.reset();
          this.lastHitter = event.towards === 'near' ? 'far' : 'near';
          this.eventPosition.set(0, 0, 0);
          this.burstColor.set(SIDE_THEME[event.towards].glow);
          stage.particles.burst({
            origin: this.eventPosition,
            color: this.burstColor,
            count: Math.round(40 * this.profile.burstScale),
            speed: 6,
            size: 0.55,
            life: 0.6,
            time: this.time,
          });
          break;
        }

        case 'match-won': {
          this.celebration = 3.2;
          this.celebrationCooldown = 0;
          this.celebrationSide = event.winner;
          stage.overlay.pulse(SIDE_THEME[event.winner].glow, 0.8);
          stage.rig.shake(0.7);
          break;
        }
      }
    }
  }

  render(frame: RenderFrame): void {
    const stage = this.stage;
    if (stage === null) return;

    this.measureFps();
    const dt = Math.min(Math.max(frame.delta, 0), 0.1);
    this.time = frame.time;
    this.dim += ((frame.dimmed ? 1 : 0) - this.dim) * approach(4.5, dt);

    const { previous, current } = frame;
    const alpha = THREE.MathUtils.clamp(frame.alpha, 0, 1);
    const teleported = this.syncBall(stage, previous, current, alpha);
    this.syncPaddles(stage, previous, current, alpha, teleported);

    const speed01 = Math.min(1, current.ballSpeed / stage.rules.ball.maxSpeed);
    const visible = 1 - this.dim * 0.75;

    stage.ball.roll(current.ball.spin, dt);
    this.tint.set(SIDE_THEME[this.lastHitter].glow);
    stage.ball.update(this.dim, speed01, this.tint);

    if (teleported) stage.trail.reset();
    stage.trail.push(this.ballPosition);

    for (const side of SIDES) stage.paddles[side].update(dt, this.dim);

    // The grid scrolls faster as the rally heats up, so speed is readable even
    // when the ball is off screen.
    const scrollSpeed = stage.arena.halfDepth * 0.1 + current.ballSpeed * 0.35;
    this.scroll -= dt * scrollSpeed * this.motionScale * (1 - this.dim * 0.7);
    stage.arenaMesh.update({
      time: frame.time,
      scroll: this.scroll,
      dim: this.dim,
      ballPosition: this.ballPosition,
      ballGlow: (0.25 + speed01 * 0.75) * visible,
    });

    const focusPaddle = current.paddles[this.perspective];
    stage.rig.update(dt, {
      paddleX: focusPaddle.x,
      paddleY: focusPaddle.y,
      ball: this.ballPosition,
      speed01,
    });

    stage.trail.update(stage.rig.camera, this.tint, visible);
    stage.particles.update(frame.time, this.dim);
    this.updateCelebration(stage, dt);
    stage.overlay.update(stage.rig.camera, dt, this.dim);

    stage.renderer.toneMappingExposure = 1 - this.dim * 0.35;

    if (this.profile.bloom) {
      const composer = this.ensureComposer(stage);
      if (stage.bloom !== null) {
        stage.bloom.strength = this.profile.bloomStrength * (1 - this.dim * 0.45);
      }
      composer.render(dt);
    } else {
      stage.renderer.render(stage.scene, stage.rig.camera);
    }
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.stage?.rig.setMode(mode);
  }

  setPerspective(side: Side): void {
    this.perspective = side;
    this.stage?.rig.setPerspective(side);
  }

  setQuality(level: QualityLevel): void {
    const profile = QUALITY_PROFILES[level];
    if (profile === this.profile) return;
    this.profile = profile;
    this.applyQuality();
    this.resize(this.width, this.height, this.requestedPixelRatio);
  }

  dispose(): void {
    this.detachMotionQuery();

    const stage = this.stage;
    if (stage === null) return;
    this.stage = null;

    this.releaseComposer(stage);
    stage.overlay.dispose();
    stage.trail.dispose();
    stage.particles.dispose();
    stage.ball.dispose();
    for (const side of SIDES) stage.paddles[side].dispose();
    stage.arenaMesh.dispose();
    for (const light of stage.lights) light.dispose();
    for (const texture of stage.textures) texture.dispose();

    stage.scene.clear();
    stage.renderer.dispose();
    stage.renderer.forceContextLoss();
    stage.renderer.domElement.remove();
  }

  private syncBall(
    stage: Stage,
    previous: MatchSnapshot,
    current: MatchSnapshot,
    alpha: number,
  ): boolean {
    const from = previous.ball.position;
    const to = current.ball.position;
    const jump = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    // A serve, a goal or a switch between the attract match and a real one moves
    // the ball much further than any single simulation step ever could.
    const teleported = previous.phase !== current.phase || jump > stage.arena.halfDepth * 0.35;

    if (teleported) this.ballPosition.set(to.x, to.y, to.z);
    else {
      this.ballPosition.set(
        lerp(from.x, to.x, alpha),
        lerp(from.y, to.y, alpha),
        lerp(from.z, to.z, alpha),
      );
    }
    stage.ball.object.position.copy(this.ballPosition);
    return teleported;
  }

  private syncPaddles(
    stage: Stage,
    previous: MatchSnapshot,
    current: MatchSnapshot,
    alpha: number,
    teleported: boolean,
  ): void {
    for (const side of SIDES) {
      const from = previous.paddles[side];
      const to = current.paddles[side];
      if (teleported) stage.paddles[side].setPosition(to.x, to.y);
      else stage.paddles[side].setPosition(lerp(from.x, to.x, alpha), lerp(from.y, to.y, alpha));
    }
  }

  private updateCelebration(stage: Stage, dt: number): void {
    if (this.celebration <= 0) return;
    this.celebration -= dt;
    this.celebrationCooldown -= dt;
    if (this.celebrationCooldown > 0) return;
    this.celebrationCooldown = 0.18;

    const theme = SIDE_THEME[this.celebrationSide];
    const { halfWidth, halfHeight, halfDepth } = stage.arena;
    this.eventPosition.set(
      (Math.random() * 2 - 1) * halfWidth * 0.85,
      (Math.random() * 2 - 1) * halfHeight * 0.85,
      (Math.random() * 2 - 1) * halfDepth * 0.7,
    );
    this.burstColor.set(Math.random() < 0.5 ? theme.core : theme.glow);
    stage.particles.burst({
      origin: this.eventPosition,
      color: this.burstColor,
      count: Math.round(60 * this.profile.burstScale),
      speed: 9,
      spread: 0.9,
      size: 0.8,
      life: 1.2,
      time: this.time,
    });
  }

  private ensureComposer(stage: Stage): EffectComposer {
    const existing = stage.composer;
    if (existing !== null) return existing;

    const composer = new EffectComposer(stage.renderer);
    const renderPass = new RenderPass(stage.scene, stage.rig.camera);
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      this.profile.bloomStrength,
      this.profile.bloomRadius,
      this.profile.bloomThreshold,
    );
    // Tone mapping and the sRGB conversion move to the end of the chain: while a
    // pass renders into a target Three.js keeps the buffer linear on purpose.
    const output = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(output);
    composer.setPixelRatio(stage.renderer.getPixelRatio());
    composer.setSize(this.width, this.height);

    stage.passes.push(renderPass, bloom, output);
    stage.composer = composer;
    stage.bloom = bloom;
    return composer;
  }

  private applyQuality(): void {
    const stage = this.stage;
    if (stage === null) return;

    stage.arenaMesh.setQuality(this.profile);
    stage.particles.setBudget(this.profile.particleBudget);
    stage.trail.setLength(this.profile.trailSamples);
    stage.ball.setLightEnabled(this.profile.ballLight);

    if (!this.profile.bloom) {
      // Dropping to 'low' happens on machines that are already struggling, so
      // give the post-processing render targets back instead of parking them.
      this.releaseComposer(stage);
      return;
    }

    const bloom = stage.bloom;
    if (bloom !== null) {
      bloom.strength = this.profile.bloomStrength;
      bloom.radius = this.profile.bloomRadius;
      bloom.threshold = this.profile.bloomThreshold;
    }
  }

  private releaseComposer(stage: Stage): void {
    for (const pass of stage.passes) pass.dispose();
    stage.passes.length = 0;
    stage.composer?.dispose();
    stage.composer = null;
    stage.bloom = null;
  }

  private attachMotionQuery(): void {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    query.addEventListener('change', this.onMotionPreferenceChange);
    this.motionQuery = query;
    this.applyMotionPreference(query.matches);
  }

  private detachMotionQuery(): void {
    this.motionQuery?.removeEventListener('change', this.onMotionPreferenceChange);
    this.motionQuery = null;
  }

  private applyMotionPreference(reduce: boolean): void {
    this.motionScale = reduce ? 0.15 : 1;
    this.stage?.rig.setMotionScale(this.motionScale);
  }

  private measureFps(): void {
    const now = performance.now();
    if (this.lastStamp > 0) {
      const duration = now - this.lastStamp;
      // Ignore stalls (tab switches, first compile) so one hiccup cannot make the
      // adaptive quality controller drop a level.
      if (duration > 0 && duration < 500) {
        const previous = this.frameDurations[this.frameCursor] ?? 0;
        this.frameSum += duration - previous;
        this.frameDurations[this.frameCursor] = duration;
        this.frameCursor = (this.frameCursor + 1) % FPS_WINDOW;
        if (this.frameCount < FPS_WINDOW) this.frameCount += 1;
        this.fpsValue = (1000 * this.frameCount) / this.frameSum;
      }
    }
    this.lastStamp = now;
  }
}

export const createThreeRenderer = (): RendererPort => new ThreeRenderer();
