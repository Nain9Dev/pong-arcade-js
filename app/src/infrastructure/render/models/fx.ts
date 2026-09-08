import * as THREE from 'three';

import type { Arena, Side } from '../../../domain/arena';
import { goalPlaneZ, sideSign } from '../../../domain/arena';
import type {
  DomainEvent,
  PaddleHitEvent,
  PaddleMissEvent,
  PointScoredEvent,
  ServeEvent,
  WallBounceEvent,
} from '../../../domain/events';
import type { MatchRules } from '../../../domain/rules';
import { resolveWinner } from '../../../domain/rules';
import type { QualityLevel } from '../../../application/ports';
import { PALETTE, SIDE_THEME } from '../palette';
import type { FrameContext, ReactiveModule } from './contract';
import { ConfettiField } from './confetti';
import type { ConfettiSpec } from './confetti';
import { ShockwaveField } from './shockwave';
import type { ShockwaveSpec } from './shockwave';

/**
 * The impact and celebration layer: everything that happens *because* something
 * was hit, missed or won.
 *
 * The module owns five pooled systems — expanding shockwave rings, comic star
 * flashes, dust sparks, manga speed lines and a confetti storm — and every one
 * of them is a single instanced draw call whose animation is derived in the
 * vertex shader from the state captured at spawn time. The only per-frame CPU
 * work is a handful of uniform writes, and nothing is allocated after mount.
 *
 * It deliberately owns **no** camera and **no** clock. Shake and slow-motion are
 * published as read-only scalars ({@link EffectsModule.shake} and
 * {@link EffectsModule.slowMotion}) for the renderer to apply, so the camera
 * stays owned by exactly one module and the time base by exactly one loop.
 */
export interface EffectsModule extends ReactiveModule {
  /**
   * Camera trauma for the current frame, in `[0, 1]`.
   *
   * It is already an envelope: impacts push it up, and it decays on its own
   * every frame, so the consumer just reads it — never accumulates it. It is
   * also already damped when `FrameContext.reducedMotion` is set.
   *
   * The camera rig should treat this as the authoritative amplitude for the
   * frame, e.g. `rig.setTrauma(effects.shake)` or `Math.max(own, effects.shake)`.
   * This module never touches the camera itself.
   */
  readonly shake: number;
  /**
   * Time-scale multiplier the renderer should apply, in `(0, 1]`.
   *
   * `1` is real time. It dips towards `0.38` for a beat when a point puts a side
   * on match point and again on the winning hit, then eases back to `1`. Feed it
   * into the simulation timestep — **not** into `RenderFrame.delta`, which this
   * module needs to stay real so its own envelopes decay in wall-clock time.
   */
  readonly slowMotion: number;
  /**
   * The raw dramatic-moment envelope in `[0, 1]` that drives `slowMotion`:
   * `0` on an ordinary rally, `1` at the peak of a match-winning moment. Handy
   * for anything else that should swell at the same time (audio, bloom, HUD).
   */
  readonly drama: number;
}

export interface EffectsOptions {
  readonly arena: Arena;
  readonly rules: MatchRules;
}

// --------------------------------------------------------------------------
// Tuning
// --------------------------------------------------------------------------

/** Trauma lost per second; roughly matches the camera rig's own decay. */
const SHAKE_DECAY = 1.9;
/** Drama lost per second once its hold window has expired. */
const DRAMA_DECAY = 1.4;
/** Slowest the game ever runs, at `drama === 1`. */
const MIN_TIME_SCALE = 0.38;
/** How much of the motion budget reduced-motion users get. */
const REDUCED_MOTION_SCALE = 0.18;
/** Speed ratio at which the ball starts drawing streaks behind it. */
const SPEED_LINE_THRESHOLD = 0.58;
/** Gold, the third colour in every celebration. */
const CONFETTI_GOLD = 0xfacc15;

interface FxProfile {
  readonly shockwaves: number;
  readonly flashes: number;
  readonly sparks: number;
  readonly speedLines: number;
  readonly confetti: number;
  /** Enables the secondary shader detail (echo rings, cross flares). */
  readonly detail: boolean;
  /** Scales every spawn count, so 'low' emits a fraction of the pieces. */
  readonly burstScale: number;
}

const FX_PROFILES: Readonly<Record<QualityLevel, FxProfile>> = {
  low: {
    shockwaves: 8,
    flashes: 6,
    sparks: 48,
    speedLines: 8,
    confetti: 144,
    detail: false,
    burstScale: 0.4,
  },
  medium: {
    shockwaves: 16,
    flashes: 12,
    sparks: 112,
    speedLines: 16,
    confetti: 384,
    detail: true,
    burstScale: 0.7,
  },
  high: {
    shockwaves: 28,
    flashes: 20,
    sparks: 224,
    speedLines: 28,
    confetti: 768,
    detail: true,
    burstScale: 1,
  },
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Frame-rate independent exponential approach factor. */
const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

// --------------------------------------------------------------------------
// Impact flashes — comic star bursts at the contact point
// --------------------------------------------------------------------------

interface Uniform<T> {
  value: T;
}

interface FlashSpec {
  origin: THREE.Vector3;
  color: THREE.Color;
  size: number;
  life: number;
  time: number;
}

const QUAD_POSITIONS = new Float32Array([
  -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
]);
const QUAD_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_INDICES = [0, 1, 2, 0, 2, 3];

/** Builds the shared unit quad every pooled system instances. */
const createQuadGeometry = (instanceCount: number): THREE.InstancedBufferGeometry => {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.instanceCount = instanceCount;
  geometry.setAttribute('position', new THREE.BufferAttribute(QUAD_POSITIONS.slice(), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(QUAD_UVS.slice(), 2));
  geometry.setIndex(QUAD_INDICES.slice());
  return geometry;
};

const FLASH_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aColor;
attribute float aSpawn;
attribute float aLife;
attribute float aSize;
attribute float aSeed;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vPhase;

void main() {
  float life = max(aLife, 0.0001);
  float t = (uTime - aSpawn) / life;

  vUv = uv;
  vColor = aColor;
  vPhase = aSeed * 6.2831853;

  if (t < 0.0 || t > 1.0) {
    vFade = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // Cartoon timing: snap open in the first couple of frames, then linger.
  float grow = 1.0 - pow(1.0 - t, 4.0);
  float scale = aSize * (0.30 + 0.85 * grow);
  vFade = pow(1.0 - t, 1.7);

  // Billboarding done in view space, so the module never needs the camera.
  float angle = vPhase + t * 1.1;
  vec2 p = position.xy * scale * 2.0;
  vec2 spun = vec2(
    p.x * cos(angle) - p.y * sin(angle),
    p.x * sin(angle) + p.y * cos(angle)
  );

  vec4 mv = modelViewMatrix * vec4(aOrigin, 1.0);
  mv.xy += spun;
  gl_Position = projectionMatrix * mv;
}
`;

const FLASH_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float uDetail;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vPhase;

void main() {
  if (vFade <= 0.001) discard;

  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  float a = atan(p.y, p.x);

  // Six-pointed impact star: the radius itself is modulated by the angle.
  float star = 0.38 + 0.62 * pow(abs(cos(a * 3.0 + vPhase)), 0.7);
  float body = smoothstep(star, star * 0.32, d);
  float core = smoothstep(0.42, 0.0, d);
  // Anime cross flare, horizontal and vertical.
  float flare = (exp(-abs(p.y) * 26.0) + exp(-abs(p.x) * 26.0)) * exp(-d * 1.6) * uDetail;

  float alpha = (body * 0.7 + core + flare * 0.5) * vFade * uOpacity;
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(vColor * (0.5 + 0.9 * core + 0.4 * body + 0.6 * flare), alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class FlashField {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private budget: number;
  private cursor = 0;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly origins: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly spawns: THREE.InstancedBufferAttribute;
  private readonly lives: THREE.InstancedBufferAttribute;
  private readonly sizes: THREE.InstancedBufferAttribute;
  private readonly seeds: THREE.InstancedBufferAttribute;
  private readonly uTime: Uniform<number>;
  private readonly uOpacity: Uniform<number>;
  private readonly uDetail: Uniform<number>;

  constructor(capacity: number) {
    this.capacity = Math.max(4, Math.floor(capacity));
    this.budget = this.capacity;

    const instanced = (components: number): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * components), components);

    this.origins = instanced(3);
    this.colors = instanced(3);
    this.spawns = instanced(1);
    this.lives = instanced(1);
    this.sizes = instanced(1);
    this.seeds = instanced(1);
    for (let i = 0; i < this.capacity; i++) {
      this.spawns.setX(i, -1e4);
      this.lives.setX(i, 1);
    }

    this.geometry = createQuadGeometry(this.budget);
    this.geometry.setAttribute('aOrigin', this.origins);
    this.geometry.setAttribute('aColor', this.colors);
    this.geometry.setAttribute('aSpawn', this.spawns);
    this.geometry.setAttribute('aLife', this.lives);
    this.geometry.setAttribute('aSize', this.sizes);
    this.geometry.setAttribute('aSeed', this.seeds);

    const uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uDetail: { value: 1 },
    };
    this.uTime = uniforms.uTime;
    this.uOpacity = uniforms.uOpacity;
    this.uDetail = uniforms.uDetail;

    this.material = new THREE.ShaderMaterial({
      vertexShader: FLASH_VERTEX,
      fragmentShader: FLASH_FRAGMENT,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 7;
  }

  setBudget(flashes: number): void {
    this.budget = Math.max(4, Math.min(this.capacity, Math.floor(flashes)));
    this.geometry.instanceCount = this.budget;
    this.cursor %= this.budget;
  }

  setDetail(enabled: boolean): void {
    this.uDetail.value = enabled ? 1 : 0;
  }

  spawn(spec: FlashSpec): void {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.budget;

    this.origins.setXYZ(slot, spec.origin.x, spec.origin.y, spec.origin.z);
    this.colors.setXYZ(slot, spec.color.r, spec.color.g, spec.color.b);
    this.spawns.setX(slot, spec.time);
    this.lives.setX(slot, Math.max(0.05, spec.life));
    this.sizes.setX(slot, Math.max(0.01, spec.size));
    this.seeds.setX(slot, Math.random());

    this.origins.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.spawns.needsUpdate = true;
    this.lives.needsUpdate = true;
    this.sizes.needsUpdate = true;
    this.seeds.needsUpdate = true;
  }

  update(time: number, opacity: number): void {
    this.uTime.value = time;
    this.uOpacity.value = opacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --------------------------------------------------------------------------
// Sparks — small, fast dust streaks kicked off the walls
// --------------------------------------------------------------------------

interface SparkSpec {
  origin: THREE.Vector3;
  /** Direction the spray is biased towards, usually the surface normal. */
  direction: THREE.Vector3;
  color: THREE.Color;
  count: number;
  /** Mean speed, units per second. */
  speed: number;
  /** Width of a speck, in world units; length follows from its speed. */
  size: number;
  life: number;
  time: number;
}

const SPARK_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute vec3 aColor;
attribute float aSpawn;
attribute float aLife;
attribute float aSize;

uniform float uTime;
uniform vec3 uGravity;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  float life = max(aLife, 0.0001);
  float age = uTime - aSpawn;
  float t = age / life;

  vUv = uv;
  vColor = aColor;

  if (t < 0.0 || t > 1.0) {
    vFade = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec3 pos = aOrigin + aVelocity * age + uGravity * age * age * 0.5;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);

  // Stretch each speck along its own screen-space heading: a spark that does
  // not smear reads as a dot, and dots read as dirt on the lens.
  vec3 viewVelocity = (modelViewMatrix * vec4(aVelocity, 0.0)).xyz;
  float planar = length(viewVelocity.xy);
  vec2 axis = planar > 0.0001 ? viewVelocity.xy / planar : vec2(0.0, 1.0);
  vec2 perp = vec2(-axis.y, axis.x);

  float stretch = aSize * (1.4 + min(planar * 0.09, 3.0));
  mv.xy += axis * (position.y * stretch * 2.0) + perp * (position.x * aSize * 2.0);

  vFade = pow(1.0 - t, 1.4);
  gl_Position = projectionMatrix * mv;
}
`;

const SPARK_FRAGMENT = /* glsl */ `
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  if (vFade <= 0.001) discard;

  float u = abs(vUv.x - 0.5) * 2.0;
  float lateral = 1.0 - u * u;
  float taper = sin(vUv.y * 3.14159265);
  float alpha = lateral * lateral * taper * vFade * uOpacity;
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(vColor * (0.6 + 0.7 * lateral), alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class SparkField {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private budget: number;
  private cursor = 0;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly origins: THREE.InstancedBufferAttribute;
  private readonly velocities: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly spawns: THREE.InstancedBufferAttribute;
  private readonly lives: THREE.InstancedBufferAttribute;
  private readonly sizes: THREE.InstancedBufferAttribute;
  private readonly uTime: Uniform<number>;
  private readonly uOpacity: Uniform<number>;

  private readonly scratch = new THREE.Vector3();

  constructor(capacity: number, gravity: number) {
    this.capacity = Math.max(8, Math.floor(capacity));
    this.budget = this.capacity;

    const instanced = (components: number): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * components), components);

    this.origins = instanced(3);
    this.velocities = instanced(3);
    this.colors = instanced(3);
    this.spawns = instanced(1);
    this.lives = instanced(1);
    this.sizes = instanced(1);
    for (let i = 0; i < this.capacity; i++) {
      this.spawns.setX(i, -1e4);
      this.lives.setX(i, 1);
    }

    this.geometry = createQuadGeometry(this.budget);
    this.geometry.setAttribute('aOrigin', this.origins);
    this.geometry.setAttribute('aVelocity', this.velocities);
    this.geometry.setAttribute('aColor', this.colors);
    this.geometry.setAttribute('aSpawn', this.spawns);
    this.geometry.setAttribute('aLife', this.lives);
    this.geometry.setAttribute('aSize', this.sizes);

    const uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uGravity: { value: new THREE.Vector3(0, -Math.abs(gravity), 0) },
    };
    this.uTime = uniforms.uTime;
    this.uOpacity = uniforms.uOpacity;

    this.material = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERTEX,
      fragmentShader: SPARK_FRAGMENT,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
  }

  setBudget(sparks: number): void {
    this.budget = Math.max(8, Math.min(this.capacity, Math.floor(sparks)));
    this.geometry.instanceCount = this.budget;
    this.cursor %= this.budget;
  }

  burst(spec: SparkSpec): void {
    const count = Math.min(Math.max(0, Math.round(spec.count)), this.budget);
    if (count === 0) return;

    for (let i = 0; i < count; i++) {
      const slot = this.cursor;
      this.cursor = (this.cursor + 1) % this.budget;

      // Uniform point on the unit sphere, bent towards the surface normal.
      const theta = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      this.scratch.set(r * Math.cos(theta), r * Math.sin(theta), z);
      this.scratch.lerp(spec.direction, 0.62);
      const length = this.scratch.length();
      if (length > 1e-5) this.scratch.multiplyScalar(1 / length);
      else this.scratch.copy(spec.direction);

      const speed = spec.speed * (0.45 + Math.random() * 1.1);
      this.origins.setXYZ(slot, spec.origin.x, spec.origin.y, spec.origin.z);
      this.velocities.setXYZ(
        slot,
        this.scratch.x * speed,
        this.scratch.y * speed,
        this.scratch.z * speed,
      );
      this.colors.setXYZ(slot, spec.color.r, spec.color.g, spec.color.b);
      this.spawns.setX(slot, spec.time);
      this.lives.setX(slot, Math.max(0.05, spec.life * (0.6 + Math.random() * 0.8)));
      this.sizes.setX(slot, spec.size * (0.6 + Math.random() * 0.8));
    }

    this.origins.needsUpdate = true;
    this.velocities.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.spawns.needsUpdate = true;
    this.lives.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  update(time: number, opacity: number): void {
    this.uTime.value = time;
    this.uOpacity.value = opacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --------------------------------------------------------------------------
// Speed lines — the "this ball is now terrifying" layer
// --------------------------------------------------------------------------

const SPEED_VERTEX = /* glsl */ `
attribute vec4 aSeed;

uniform float uTime;
uniform vec3 uOrigin;
uniform vec3 uDir;
uniform vec3 uAxisX;
uniform vec3 uAxisY;
uniform float uIntensity;
uniform float uRadius;
uniform float uLength;
uniform float uWidth;

varying vec2 vUv;
varying float vFade;

void main() {
  vUv = uv;

  // Each streak marches from the ball towards the back of the trail and loops.
  float rate = (0.9 + 1.8 * uIntensity) * (0.6 + 0.8 * aSeed.z);
  float cycle = fract(aSeed.w + uTime * rate);
  float trail = uLength * (0.9 + 2.6 * uIntensity);

  float angle = aSeed.x * 6.2831853;
  float radius = uRadius * (0.35 + 0.85 * aSeed.y) * (1.0 + 0.9 * uIntensity);
  vec3 centre =
    uOrigin - uDir * (cycle * trail) + (uAxisX * cos(angle) + uAxisY * sin(angle)) * radius;

  float halfLength = uLength * (0.10 + 0.30 * aSeed.z) * (0.35 + 1.6 * uIntensity);

  vec4 mv = modelViewMatrix * vec4(centre, 1.0);
  vec3 viewDir = (modelViewMatrix * vec4(uDir, 0.0)).xyz;
  float planar = length(viewDir.xy);

  // When the ball flies straight at the camera its heading has no screen-space
  // direction left, so the streaks fall back to a radial zoom blur instead.
  vec2 radial = length(mv.xy) > 0.0001 ? normalize(mv.xy) : vec2(0.0, 1.0);
  vec2 heading = planar > 0.0001 ? viewDir.xy / planar : radial;
  vec2 blended = mix(radial, heading, clamp(planar * 2.5, 0.0, 1.0));
  float blendedLength = length(blended);
  vec2 axis = blendedLength > 0.0001 ? blended / blendedLength : vec2(0.0, 1.0);
  vec2 perp = vec2(-axis.y, axis.x);

  mv.xy += axis * (position.y * halfLength * 2.0) + perp * (position.x * uWidth * 2.0);

  vFade = uIntensity * smoothstep(0.0, 0.16, cycle) * (1.0 - smoothstep(0.5, 1.0, cycle));
  gl_Position = projectionMatrix * mv;
}
`;

const SPEED_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;

varying vec2 vUv;
varying float vFade;

void main() {
  if (vFade <= 0.002) discard;

  float u = abs(vUv.x - 0.5) * 2.0;
  float lateral = 1.0 - u * u;
  float taper = sin(vUv.y * 3.14159265);
  float alpha = lateral * lateral * taper * vFade * uOpacity * 0.85;
  if (alpha < 0.003) discard;

  gl_FragColor = vec4(uColor * (0.5 + 0.8 * lateral), alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Reference axes used to build a stable basis around the ball's heading. */
const REFERENCE_UP = new THREE.Vector3(0, 1, 0);
const REFERENCE_RIGHT = new THREE.Vector3(1, 0, 0);

class SpeedLines {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly uTime: Uniform<number>;
  private readonly uOrigin: Uniform<THREE.Vector3>;
  private readonly uDir: Uniform<THREE.Vector3>;
  private readonly uAxisX: Uniform<THREE.Vector3>;
  private readonly uAxisY: Uniform<THREE.Vector3>;
  private readonly uColor: Uniform<THREE.Color>;
  private readonly uIntensity: Uniform<number>;
  private readonly uOpacity: Uniform<number>;

  private readonly heading = new THREE.Vector3(0, 0, 1);
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();

  constructor(capacity: number, radius: number, length: number, width: number) {
    this.capacity = Math.max(4, Math.floor(capacity));

    const seeds = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    for (let i = 0; i < this.capacity; i++) {
      // A fixed, evenly spread ring of streaks: no spawning, no recycling.
      seeds.setXYZW(
        i,
        (i + Math.random() * 0.6) / this.capacity,
        Math.random(),
        Math.random(),
        Math.random(),
      );
    }

    this.geometry = createQuadGeometry(this.capacity);
    this.geometry.setAttribute('aSeed', seeds);

    const uniforms = {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uDir: { value: new THREE.Vector3(0, 0, 1) },
      uAxisX: { value: new THREE.Vector3(1, 0, 0) },
      uAxisY: { value: new THREE.Vector3(0, 1, 0) },
      uColor: { value: new THREE.Color(0xffffff) },
      uIntensity: { value: 0 },
      uOpacity: { value: 1 },
      uRadius: { value: radius },
      uLength: { value: length },
      uWidth: { value: width },
    };
    this.uTime = uniforms.uTime;
    this.uOrigin = uniforms.uOrigin;
    this.uDir = uniforms.uDir;
    this.uAxisX = uniforms.uAxisX;
    this.uAxisY = uniforms.uAxisY;
    this.uColor = uniforms.uColor;
    this.uIntensity = uniforms.uIntensity;
    this.uOpacity = uniforms.uOpacity;

    this.material = new THREE.ShaderMaterial({
      vertexShader: SPEED_VERTEX,
      fragmentShader: SPEED_FRAGMENT,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this.object.visible = false;
  }

  setBudget(lines: number): void {
    this.geometry.instanceCount = Math.max(4, Math.min(this.capacity, Math.floor(lines)));
  }

  update(
    time: number,
    origin: THREE.Vector3,
    velocity: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    opacity: number,
  ): void {
    const visible = intensity > 0.01 && opacity > 0.01;
    this.object.visible = visible;
    if (!visible) return;

    const speed = velocity.length();
    if (speed > 1e-4) this.heading.copy(velocity).multiplyScalar(1 / speed);

    // Any vector not parallel to the heading works as the seed of the basis.
    const reference = Math.abs(this.heading.y) > 0.9 ? REFERENCE_RIGHT : REFERENCE_UP;
    this.axisX.crossVectors(reference, this.heading).normalize();
    this.axisY.crossVectors(this.heading, this.axisX).normalize();

    this.uTime.value = time;
    this.uOrigin.value.copy(origin);
    this.uDir.value.copy(this.heading);
    this.uAxisX.value.copy(this.axisX);
    this.uAxisY.value.copy(this.axisY);
    this.uColor.value.copy(color);
    this.uIntensity.value = intensity;
    this.uOpacity.value = opacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --------------------------------------------------------------------------
// The module itself
// --------------------------------------------------------------------------

/** Mutable mirror of {@link ShockwaveSpec}, refilled on every spawn. */
interface WaveDraft {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  color: THREE.Color;
  radius: number;
  life: number;
  power: number;
  time: number;
}

/** Mutable mirror of {@link ConfettiSpec}, refilled on every burst. */
interface ConfettiDraft {
  origin: THREE.Vector3;
  spawnSpread: THREE.Vector3;
  velocity: THREE.Vector3;
  velocitySpread: THREE.Vector3;
  colors: THREE.Color[];
  count: number;
  life: number;
  size: number;
  time: number;
}

class Effects implements EffectsModule {
  readonly object3D = new THREE.Group();

  private readonly arena: Arena;
  private readonly rules: MatchRules;
  private profile: FxProfile = FX_PROFILES.high;

  private readonly shockwaves: ShockwaveField;
  private readonly flashes: FlashField;
  private readonly sparks: SparkField;
  private readonly speedLines: SpeedLines;
  private readonly confetti: ConfettiField;

  /** Effect clock in real seconds; spawn times are recorded against it. */
  private time = 0;
  private dim = 0;
  private motionScale = 1;

  private shakeValue = 0;
  private dramaValue = 0;
  private dramaHold = 0;
  private speedIntensity = 0;

  private lastHitter: Side = 'near';
  private matchPoint = false;

  /** Seconds of sustained victory storm left, and the throttle between gusts. */
  private storm = 0;
  private stormGust = 0;
  private stormSide: Side = 'near';

  // Every scratch object below is allocated once. `handleEvents` and `update`
  // run inside the frame budget and must never produce garbage.
  private readonly wave: WaveDraft = {
    origin: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    color: new THREE.Color(),
    radius: 1,
    life: 0.5,
    power: 1,
    time: 0,
  };

  private readonly flash: FlashSpec = {
    origin: new THREE.Vector3(),
    color: new THREE.Color(),
    size: 1,
    life: 0.3,
    time: 0,
  };

  private readonly spark: SparkSpec = {
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    color: new THREE.Color(),
    count: 0,
    speed: 1,
    size: 0.2,
    life: 0.4,
    time: 0,
  };

  private readonly paper: ConfettiDraft = {
    origin: new THREE.Vector3(),
    spawnSpread: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    velocitySpread: new THREE.Vector3(),
    colors: [
      new THREE.Color(),
      new THREE.Color(),
      new THREE.Color(),
      new THREE.Color(CONFETTI_GOLD),
    ],
    count: 0,
    life: 3.4,
    size: 0.42,
    time: 0,
  };

  private readonly streakColor = new THREE.Color();

  constructor(options: EffectsOptions) {
    this.arena = options.arena;
    this.rules = options.rules;

    const { halfWidth, halfHeight, halfDepth } = this.arena;
    const ballRadius = this.rules.ball.radius;

    this.shockwaves = new ShockwaveField(FX_PROFILES.high.shockwaves);
    this.flashes = new FlashField(FX_PROFILES.high.flashes);
    this.sparks = new SparkField(FX_PROFILES.high.sparks, halfHeight * 1.6);
    this.speedLines = new SpeedLines(
      FX_PROFILES.high.speedLines,
      ballRadius * 5.5,
      halfDepth * 0.22,
      ballRadius * 0.22,
    );
    // Drag chosen so a piece falls roughly the height of the arena over its
    // lifetime instead of dropping through the floor in the first second.
    this.confetti = new ConfettiField(FX_PROFILES.high.confetti, halfHeight * 0.95, 1.8);

    this.object3D.name = 'effects';
    this.object3D.add(
      this.shockwaves.object,
      this.sparks.object,
      this.speedLines.object,
      this.flashes.object,
      this.confetti.object,
    );

    this.paper.size = Math.max(0.22, halfWidth * 0.045);
  }

  get shake(): number {
    return this.shakeValue;
  }

  get slowMotion(): number {
    return 1 - this.dramaValue * (1 - MIN_TIME_SCALE);
  }

  get drama(): number {
    return this.dramaValue;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'wall-bounce':
          this.onWallBounce(event);
          break;
        case 'paddle-hit':
          this.onPaddleHit(event);
          break;
        case 'paddle-miss':
          this.onPaddleMiss(event);
          break;
        case 'point-scored':
          this.onPointScored(event);
          break;
        case 'serve':
          this.onServe(event);
          break;
        case 'match-won':
          this.onMatchWon(event.winner);
          break;
      }
    }
  }

  update(ctx: FrameContext): void {
    const dt = Math.min(Math.max(ctx.dt, 0), 0.1);
    this.time += dt;
    this.motionScale = ctx.reducedMotion ? REDUCED_MOTION_SCALE : 1;

    this.dim += ((ctx.dimmed ? 1 : 0) - this.dim) * approach(4.5, dt);
    const opacity = 1 - this.dim * 0.88;

    this.shakeValue = Math.max(0, this.shakeValue - dt * SHAKE_DECAY);
    if (this.dramaHold > 0) this.dramaHold -= dt;
    else this.dramaValue = Math.max(0, this.dramaValue - dt * DRAMA_DECAY);

    this.updateStorm(dt);
    this.updateSpeedLines(ctx, dt, opacity);

    this.shockwaves.update(this.time, opacity);
    this.flashes.update(this.time, opacity);
    this.sparks.update(this.time, opacity);
    this.confetti.update(this.time, opacity);
  }

  setQuality(level: QualityLevel): void {
    const profile = FX_PROFILES[level];
    if (profile === this.profile) return;
    this.profile = profile;

    this.shockwaves.setBudget(profile.shockwaves);
    this.shockwaves.setDetail(profile.detail);
    this.flashes.setBudget(profile.flashes);
    this.flashes.setDetail(profile.detail);
    this.sparks.setBudget(profile.sparks);
    this.speedLines.setBudget(profile.speedLines);
    this.confetti.setBudget(profile.confetti);
  }

  dispose(): void {
    this.shockwaves.dispose();
    this.flashes.dispose();
    this.sparks.dispose();
    this.speedLines.dispose();
    this.confetti.dispose();
    this.object3D.clear();
  }

  // ------------------------------------------------------------------------
  // Event reactions
  // ------------------------------------------------------------------------

  private onWallBounce(event: WallBounceEvent): void {
    const intensity = clamp01(event.intensity);
    const ballRadius = this.rules.ball.radius;

    this.wave.origin.set(event.position.x, event.position.y, event.position.z);
    // Point the ring back into the arena, away from the face that was struck.
    if (event.axis === 'x') this.wave.normal.set(event.position.x >= 0 ? -1 : 1, 0, 0);
    else this.wave.normal.set(0, event.position.y >= 0 ? -1 : 1, 0);

    this.wave.color.set(PALETTE.edge);
    this.wave.radius = ballRadius * (2.6 + intensity * 6.4);
    this.wave.life = 0.34 + intensity * 0.16;
    this.wave.power = 0.45 + intensity * 0.55;
    this.wave.time = this.time;
    this.shockwaves.spawn(this.wave);

    this.flash.origin.copy(this.wave.origin);
    this.flash.color.set(PALETTE.spark);
    this.flash.size = ballRadius * (1.5 + intensity * 2.2);
    this.flash.life = 0.16 + intensity * 0.08;
    this.flash.time = this.time;
    this.flashes.spawn(this.flash);

    this.spark.origin.copy(this.wave.origin);
    this.spark.direction.copy(this.wave.normal);
    this.spark.color.set(PALETTE.spark);
    this.spark.count = this.scaled(5 + intensity * 13);
    this.spark.speed = 5 + intensity * 12;
    this.spark.size = ballRadius * 0.16;
    this.spark.life = 0.26 + intensity * 0.14;
    this.spark.time = this.time;
    this.sparks.burst(this.spark);

    this.addShake(0.035 + intensity * 0.09);
  }

  private onPaddleHit(event: PaddleHitEvent): void {
    this.lastHitter = event.side;

    const theme = SIDE_THEME[event.side];
    const speed01 = clamp01(event.speed / this.rules.ball.maxSpeed);
    const paddle = this.rules.paddle;

    this.wave.origin.set(event.position.x, event.position.y, event.position.z);
    // The paddle plane faces the arena centre; an off-centre hit tilts the ring
    // the way the shot actually left, which reads as follow-through.
    this.wave.normal.set(event.offset.x * 0.35, event.offset.y * 0.35, -sideSign(event.side));

    this.wave.color.set(event.edge ? theme.glow : theme.core);
    this.wave.radius = paddle.halfWidth * (1.25 + speed01 * 1.7);
    this.wave.life = 0.4 + speed01 * 0.22;
    this.wave.power = 0.7 + speed01 * 0.6 + (event.edge ? 0.3 : 0);
    this.wave.time = this.time;
    this.shockwaves.spawn(this.wave);

    // An edge hit gets a second, wider ring a beat later: the comic double take.
    if (event.edge) {
      this.wave.color.set(theme.core);
      this.wave.radius *= 1.75;
      this.wave.life += 0.16;
      this.wave.power *= 0.55;
      this.wave.time = this.time + 0.07;
      this.shockwaves.spawn(this.wave);
    }

    // Long rallies escalate: past six exchanges the hit throws an extra halo.
    if (event.rally >= 6) {
      this.wave.color.set(PALETTE.edge);
      this.wave.radius = paddle.halfWidth * (2.4 + speed01 * 2.2);
      this.wave.life = 0.55;
      this.wave.power = 0.3 + speed01 * 0.35;
      this.wave.time = this.time + 0.11;
      this.shockwaves.spawn(this.wave);
    }

    this.flash.origin.copy(this.wave.origin);
    this.flash.color.set(event.edge ? theme.glow : theme.core);
    this.flash.size = paddle.halfHeight * (0.85 + speed01 * 1.35) * (event.edge ? 1.35 : 1);
    this.flash.life = 0.2 + speed01 * 0.14;
    this.flash.time = this.time;
    this.flashes.spawn(this.flash);

    this.spark.origin.copy(this.wave.origin);
    this.spark.direction.copy(this.wave.normal).normalize();
    this.spark.color.set(event.edge ? theme.glow : theme.core);
    this.spark.count = this.scaled((event.edge ? 26 : 14) + speed01 * 22);
    this.spark.speed = 8 + speed01 * 20;
    this.spark.size = this.rules.ball.radius * 0.2;
    this.spark.life = 0.32 + speed01 * 0.2;
    this.spark.time = this.time;
    this.sparks.burst(this.spark);

    this.addShake(0.08 + speed01 * 0.3 + (event.edge ? 0.13 : 0));
    // Every exchange while the match is on the line gets a sliver of slow-mo.
    if (this.matchPoint) this.pushDrama(0.45 + speed01 * 0.25, 0.14);
  }

  private onPaddleMiss(event: PaddleMissEvent): void {
    const theme = SIDE_THEME[event.side];

    // The whiff: a limp little ring and a puff of dust. No shake — nothing was
    // actually hit, and that silence is the joke.
    this.wave.origin.set(event.position.x, event.position.y, event.position.z);
    this.wave.normal.set(0, 0, -sideSign(event.side));
    this.wave.color.set(theme.core);
    this.wave.radius = this.rules.paddle.halfWidth * 0.9;
    this.wave.life = 0.6;
    this.wave.power = 0.28;
    this.wave.time = this.time;
    this.shockwaves.spawn(this.wave);

    this.spark.origin.copy(this.wave.origin);
    this.spark.direction.copy(this.wave.normal);
    this.spark.color.set(theme.deep);
    this.spark.count = this.scaled(8);
    this.spark.speed = 3;
    this.spark.size = this.rules.ball.radius * 0.22;
    this.spark.life = 0.7;
    this.spark.time = this.time;
    this.sparks.burst(this.spark);
  }

  private onPointScored(event: PointScoredEvent): void {
    const theme = SIDE_THEME[event.scorer];
    const { halfWidth, halfHeight, halfDepth } = this.arena;

    // A wall of light across the goal that was crossed.
    this.wave.origin.set(0, 0, goalPlaneZ(this.arena, event.conceded));
    this.wave.normal.set(0, 0, -sideSign(event.conceded));
    this.wave.color.set(theme.core);
    this.wave.radius = halfWidth * 2.1;
    this.wave.life = 0.85;
    this.wave.power = 1.15;
    this.wave.time = this.time;
    this.shockwaves.spawn(this.wave);

    this.wave.color.set(theme.glow);
    this.wave.radius = halfWidth * 1.3;
    this.wave.life = 0.6;
    this.wave.power = 0.8;
    this.wave.time = this.time + 0.09;
    this.shockwaves.spawn(this.wave);

    this.flash.origin.copy(this.wave.origin);
    this.flash.color.set(theme.glow);
    this.flash.size = halfHeight * 1.5;
    this.flash.life = 0.42;
    this.flash.time = this.time;
    this.flashes.spawn(this.flash);

    // Confetti erupts from behind the scorer and rides towards the centre.
    const towardsCentre = -sideSign(event.scorer);
    this.setCelebrationColors(event.scorer);
    this.paper.origin.set(0, halfHeight * 0.1, goalPlaneZ(this.arena, event.scorer) * 0.94);
    this.paper.spawnSpread.set(halfWidth * 0.85, halfHeight * 0.7, 1.2);
    this.paper.velocity.set(0, halfHeight * 2.1, towardsCentre * halfDepth * 0.42);
    this.paper.velocitySpread.set(halfWidth * 1.4, halfHeight * 1.2, halfDepth * 0.2);
    this.paper.count = this.scaled(170);
    this.paper.life = 3.4;
    this.paper.time = this.time;
    this.confetti.burst(this.paper);

    this.addShake(0.5);
    this.refreshMatchPoint(event.score.near, event.score.far);
  }

  private onServe(event: ServeEvent): void {
    const theme = SIDE_THEME[event.towards];

    // A small "here it comes" ring facing the side about to receive.
    this.wave.origin.set(0, 0, 0);
    this.wave.normal.set(0, 0, sideSign(event.towards));
    this.wave.color.set(theme.glow);
    this.wave.radius = this.rules.ball.radius * 9;
    this.wave.life = 0.55;
    this.wave.power = 0.42;
    this.wave.time = this.time;
    this.shockwaves.spawn(this.wave);

    this.flash.origin.copy(this.wave.origin);
    this.flash.color.set(theme.glow);
    this.flash.size = this.rules.ball.radius * 3.2;
    this.flash.life = 0.28;
    this.flash.time = this.time;
    this.flashes.spawn(this.flash);
  }

  private onMatchWon(winner: Side): void {
    const theme = SIDE_THEME[winner];
    const { halfWidth, halfHeight, halfDepth } = this.arena;

    this.storm = 4.6;
    this.stormGust = 0;
    this.stormSide = winner;

    // Triple boom: three rings on a deliberate off-beat down the arena.
    this.wave.normal.set(0, 0, -sideSign(winner));
    for (let i = 0; i < 3; i++) {
      this.wave.origin.set(0, 0, goalPlaneZ(this.arena, winner) * (0.9 - i * 0.35));
      this.wave.color.set(i === 1 ? theme.glow : theme.core);
      this.wave.radius = halfWidth * (1.8 + i * 0.7);
      this.wave.life = 0.9 + i * 0.15;
      this.wave.power = 1.25 - i * 0.25;
      this.wave.time = this.time + i * 0.14;
      this.shockwaves.spawn(this.wave);
    }

    this.flash.origin.set(0, halfHeight * 0.2, goalPlaneZ(this.arena, winner) * 0.85);
    this.flash.color.set(theme.glow);
    this.flash.size = halfHeight * 2.2;
    this.flash.life = 0.55;
    this.flash.time = this.time;
    this.flashes.spawn(this.flash);

    this.setCelebrationColors(winner);
    this.paper.origin.set(0, halfHeight * 1.05, goalPlaneZ(this.arena, winner) * 0.6);
    this.paper.spawnSpread.set(halfWidth * 0.9, halfHeight * 0.3, halfDepth * 0.35);
    this.paper.velocity.set(0, halfHeight * 1.7, 0);
    this.paper.velocitySpread.set(halfWidth * 1.6, halfHeight * 1.1, halfDepth * 0.35);
    this.paper.count = this.scaled(240);
    this.paper.life = 4.2;
    this.paper.time = this.time;
    this.confetti.burst(this.paper);

    this.addShake(0.85);
    this.pushDrama(1, 0.75);
    this.matchPoint = false;
  }

  // ------------------------------------------------------------------------
  // Per-frame work
  // ------------------------------------------------------------------------

  private updateStorm(dt: number): void {
    if (this.storm <= 0) return;
    this.storm -= dt;
    this.stormGust -= dt;
    if (this.stormGust > 0) return;
    this.stormGust = 0.18;

    const { halfWidth, halfHeight, halfDepth } = this.arena;
    this.setCelebrationColors(this.stormSide);
    // Sustained rain from the ceiling across the whole arena.
    this.paper.origin.set(0, halfHeight * 1.15, 0);
    this.paper.spawnSpread.set(halfWidth, halfHeight * 0.2, halfDepth * 0.85);
    this.paper.velocity.set(0, 0.8, 0);
    this.paper.velocitySpread.set(2.4, 1.4, 2.4);
    this.paper.count = this.scaled(38);
    this.paper.life = 4.6;
    this.paper.time = this.time;
    this.confetti.burst(this.paper);
  }

  private updateSpeedLines(ctx: FrameContext, dt: number, opacity: number): void {
    const ratio = ctx.ball.speedRatio;
    const raw =
      ratio > SPEED_LINE_THRESHOLD
        ? (ratio - SPEED_LINE_THRESHOLD) / (1 - SPEED_LINE_THRESHOLD)
        : 0;
    // Match point keeps a low hum of streaks alive even at a modest speed, so
    // the decisive rally already looks different before it gets fast.
    const floor = this.matchPoint && ctx.phase === 'rally' ? 0.2 : 0;
    const target = clamp01(Math.max(raw, floor)) * this.motionScale;

    this.speedIntensity += (target - this.speedIntensity) * approach(9, dt);

    this.streakColor.set(SIDE_THEME[this.lastHitter].glow);
    this.speedLines.update(
      this.time,
      ctx.ball.position,
      ctx.ball.velocity,
      this.streakColor,
      this.speedIntensity,
      opacity,
    );
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  /** Applies the quality burst scale and never returns less than one piece. */
  private scaled(count: number): number {
    return Math.max(1, Math.round(count * this.profile.burstScale));
  }

  private addShake(amount: number): void {
    this.shakeValue = Math.min(1, this.shakeValue + amount * this.motionScale);
  }

  /** Raises the drama envelope and holds it there for `hold` seconds. */
  private pushDrama(amount: number, hold: number): void {
    const scaled = amount * (this.motionScale < 1 ? 0.35 : 1);
    this.dramaValue = Math.max(this.dramaValue, clamp01(scaled));
    this.dramaHold = Math.max(this.dramaHold, hold);
  }

  /** Match point is "one more point ends it", win-by-two rule included. */
  private refreshMatchPoint(near: number, far: number): void {
    const wasMatchPoint = this.matchPoint;
    this.matchPoint =
      resolveWinner(this.rules, near + 1, far) === 'near' ||
      resolveWinner(this.rules, near, far + 1) === 'far';
    if (this.matchPoint && !wasMatchPoint) this.pushDrama(0.7, 0.35);
  }

  private setCelebrationColors(side: Side): void {
    const theme = SIDE_THEME[side];
    this.paper.colors[0]?.set(theme.core);
    this.paper.colors[1]?.set(theme.glow);
    this.paper.colors[2]?.set(PALETTE.spark);
    this.paper.colors[3]?.set(CONFETTI_GOLD);
  }
}

/**
 * Builds the impact and celebration layer.
 *
 * The renderer adds `module.object3D` to the scene, forwards domain events to
 * `handleEvents`, calls `update` once per frame, and reads `shake` / `slowMotion`
 * afterwards to drive the camera rig and the simulation timestep.
 */
export const createEffects = (options: EffectsOptions): EffectsModule => new Effects(options);

export type { ConfettiSpec, ShockwaveSpec };
