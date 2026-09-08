import * as THREE from 'three';

/**
 * A single pooled, additively blended `Points` cloud for every spark in the game.
 *
 * Particles are simulated entirely in the vertex shader from their spawn state
 * (origin, velocity, birth time), so a burst costs one write into a ring buffer
 * and nothing per frame afterwards. The geometry is allocated once at mount and
 * is never grown, replaced or re-indexed.
 */
export interface BurstOptions {
  readonly origin: THREE.Vector3;
  readonly color: THREE.Color;
  readonly count: number;
  /** Mean radial speed, units per second. */
  readonly speed: number;
  /** Extra speed added at random on top of `speed`, as a fraction of it. */
  readonly spread?: number;
  /** Bias applied to the emission direction (e.g. away from a paddle). */
  readonly direction?: THREE.Vector3;
  /** How strongly `direction` dominates the random sphere, in `[0, 1]`. */
  readonly focus?: number;
  readonly size: number;
  readonly life: number;
  readonly time: number;
}

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aVelocity;
attribute vec3 aColor;
attribute float aSpawn;
attribute float aLife;
attribute float aSize;

uniform float uTime;
uniform float uPixelRatio;
uniform float uDim;
uniform vec3 uGravity;

varying vec3 vColor;
varying float vFade;

void main() {
  float age = uTime - aSpawn;
  float life = max(aLife, 0.0001);
  float t = age / life;
  float alive = step(0.0, age) * step(t, 1.0);

  vec3 displaced = position + aVelocity * age + uGravity * age * age * 0.5;
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);

  float luma = dot(aColor, vec3(0.2126, 0.7152, 0.0722));
  vColor = mix(aColor, vec3(luma) * 0.35, uDim);
  vFade = (1.0 - t) * alive;

  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uPixelRatio * (260.0 / max(-mvPosition.z, 0.5)) * (0.35 + 0.65 * vFade) * alive;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vFade;

void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float radius = dot(offset, offset) * 4.0;
  if (radius > 1.0 || vFade <= 0.0) discard;
  float falloff = (1.0 - radius) * (1.0 - radius);
  float alpha = falloff * vFade;
  gl_FragColor = vec4(vColor * (0.4 + 0.6 * falloff), alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticleField {
  readonly object: THREE.Points;

  private readonly capacity: number;
  private budget: number;
  private cursor = 0;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly origins: THREE.BufferAttribute;
  private readonly velocities: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;
  private readonly spawns: THREE.BufferAttribute;
  private readonly lives: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;

  private readonly direction = new THREE.Vector3();

  constructor(capacity: number, gravity: number) {
    this.capacity = Math.max(16, capacity);
    this.budget = this.capacity;

    const float = (components: number): THREE.BufferAttribute =>
      new THREE.BufferAttribute(new Float32Array(this.capacity * components), components);

    this.origins = float(3);
    this.velocities = float(3);
    this.colors = float(3);
    this.spawns = float(1);
    this.lives = float(1);
    this.sizes = float(1);
    // Every slot starts long-dead so nothing is drawn before the first burst.
    for (let i = 0; i < this.capacity; i++) this.spawns.setX(i, -1e4);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.origins);
    this.geometry.setAttribute('aVelocity', this.velocities);
    this.geometry.setAttribute('aColor', this.colors);
    this.geometry.setAttribute('aSpawn', this.spawns);
    this.geometry.setAttribute('aLife', this.lives);
    this.geometry.setAttribute('aSize', this.sizes);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uDim: { value: 0 },
        uGravity: { value: new THREE.Vector3(0, -gravity, 0) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
  }

  /** Caps how many slots the pool may recycle, so 'low' quality emits less. */
  setBudget(particles: number): void {
    this.budget = Math.max(16, Math.min(this.capacity, Math.floor(particles)));
    this.cursor %= this.budget;
  }

  setPixelRatio(ratio: number): void {
    const uniform = this.material.uniforms.uPixelRatio;
    if (uniform !== undefined) uniform.value = ratio;
  }

  burst(options: BurstOptions): void {
    const count = Math.min(Math.max(0, Math.round(options.count)), this.budget);
    if (count === 0) return;

    const spread = options.spread ?? 0.6;
    const focus = options.focus ?? 0;
    const bias = options.direction;

    for (let i = 0; i < count; i++) {
      const slot = this.cursor;
      this.cursor = (this.cursor + 1) % this.budget;

      // Uniform point on the unit sphere, then bent towards the bias direction.
      const theta = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      this.direction.set(r * Math.cos(theta), r * Math.sin(theta), z);
      if (bias !== undefined && focus > 0) {
        this.direction.lerp(bias, focus).normalize();
      }

      const speed = options.speed * (1 + (Math.random() - 0.5) * 2 * spread);
      this.origins.setXYZ(slot, options.origin.x, options.origin.y, options.origin.z);
      this.velocities.setXYZ(
        slot,
        this.direction.x * speed,
        this.direction.y * speed,
        this.direction.z * speed,
      );
      this.colors.setXYZ(slot, options.color.r, options.color.g, options.color.b);
      this.spawns.setX(slot, options.time);
      this.lives.setX(slot, options.life * (0.65 + Math.random() * 0.7));
      this.sizes.setX(slot, options.size * (0.6 + Math.random() * 0.8));
    }

    // The pool is small enough that a full re-upload beats tracking dirty ranges.
    this.origins.needsUpdate = true;
    this.velocities.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.spawns.needsUpdate = true;
    this.lives.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  update(time: number, dim: number): void {
    const uTime = this.material.uniforms.uTime;
    if (uTime !== undefined) uTime.value = time;
    const uDim = this.material.uniforms.uDim;
    if (uDim !== undefined) uDim.value = dim;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
