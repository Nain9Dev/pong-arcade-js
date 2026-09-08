import * as THREE from 'three';

/**
 * A pooled storm of tumbling paper rectangles.
 *
 * One `InstancedBufferGeometry` holds every piece in the game, so hundreds of
 * them cost a single draw call. Each piece is integrated in the vertex shader
 * from its spawn state with a closed-form drag solution, which keeps confetti
 * floaty rather than meteoric and — more importantly — means the CPU touches a
 * piece exactly once, when it is born.
 *
 * Pieces tumble around a random axis. Because a quad seen edge-on collapses to
 * nothing and its back face is drawn darker, the field flickers the way real
 * confetti does; that flicker is what makes it read as paper instead of sparks.
 */
export interface ConfettiSpec {
  /** Centre of the spawn box. */
  readonly origin: THREE.Vector3;
  /** Half-extents of the spawn box around `origin`. */
  readonly spawnSpread: THREE.Vector3;
  /** Mean launch velocity, units per second. */
  readonly velocity: THREE.Vector3;
  /** Per-axis random jitter added to `velocity`. */
  readonly velocitySpread: THREE.Vector3;
  /**
   * Palette picked from at random. The array and its colours may be mutated
   * between calls — nothing is retained past the call.
   */
  readonly colors: readonly THREE.Color[];
  readonly count: number;
  readonly life: number;
  /** Longest edge of a piece, in world units. */
  readonly size: number;
  readonly time: number;
}

interface Uniform<T> {
  value: T;
}

/** Used when a caller hands over an empty palette; never rendered in practice. */
const FALLBACK_COLOR = new THREE.Color(0xffffff);

/** Share of pieces that spawn as long streamers instead of square chips. */
const STREAMER_CHANCE = 0.18;

const CONFETTI_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute vec3 aColor;
attribute vec2 aSize;
attribute vec4 aSpin;
attribute float aSpawn;
attribute float aLife;
attribute float aSeed;

uniform float uTime;
uniform vec3 uGravity;
uniform float uDrag;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

vec3 rotateAxis(vec3 v, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

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

  // Exact solution of dv/dt = g - k*v: the launch impulse dies away and the
  // piece settles onto a gentle terminal velocity instead of accelerating away.
  float k = max(uDrag, 0.01);
  float decay = (1.0 - exp(-k * age)) / k;
  vec3 terminal = uGravity / k;
  vec3 centre = aOrigin + terminal * age + (aVelocity - terminal) * decay;

  // Paper does not fall straight down: it slips sideways as it flips.
  float flutter = 3.4 + aSeed * 5.6;
  vec3 drift = vec3(
    sin(age * flutter + aSeed * 11.0),
    0.0,
    cos(age * flutter * 0.78 + aSeed * 7.0)
  );
  centre += drift * decay * 0.9;

  vec3 axis = normalize(aSpin.xyz + vec3(0.0001, 0.0002, 0.0));
  vec3 local = rotateAxis(
    vec3(position.x * aSize.x, position.y * aSize.y, 0.0),
    axis,
    aSpin.w * age
  );

  vFade = 1.0 - smoothstep(0.74, 1.0, t);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + local, 1.0);
}
`;

const CONFETTI_FRAGMENT = /* glsl */ `
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  float alpha = vFade * uOpacity;
  if (alpha < 0.004) discard;

  // The back of a sheet of paper sits in shadow; that contrast is the flicker.
  float facing = gl_FrontFacing ? 1.0 : 0.34;
  float sheen = 0.78 + 0.4 * vUv.y;

  gl_FragColor = vec4(vColor * facing * sheen, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ConfettiField {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private budget: number;
  private cursor = 0;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly origins: THREE.InstancedBufferAttribute;
  private readonly velocities: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly sizes: THREE.InstancedBufferAttribute;
  private readonly spins: THREE.InstancedBufferAttribute;
  private readonly spawns: THREE.InstancedBufferAttribute;
  private readonly lives: THREE.InstancedBufferAttribute;
  private readonly seeds: THREE.InstancedBufferAttribute;

  private readonly uTime: Uniform<number>;
  private readonly uOpacity: Uniform<number>;

  constructor(capacity: number, gravity: number, drag: number) {
    this.capacity = Math.max(16, Math.floor(capacity));
    this.budget = this.capacity;

    const instanced = (components: number): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.capacity * components),
        components,
      );

    this.origins = instanced(3);
    this.velocities = instanced(3);
    this.colors = instanced(3);
    this.sizes = instanced(2);
    this.spins = instanced(4);
    this.spawns = instanced(1);
    this.lives = instanced(1);
    this.seeds = instanced(1);
    for (let i = 0; i < this.capacity; i++) {
      this.spawns.setX(i, -1e4);
      this.lives.setX(i, 1);
      this.spins.setXYZW(i, 0, 1, 0, 0);
    }

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.instanceCount = this.budget;
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    this.geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry.setAttribute('aOrigin', this.origins);
    this.geometry.setAttribute('aVelocity', this.velocities);
    this.geometry.setAttribute('aColor', this.colors);
    this.geometry.setAttribute('aSize', this.sizes);
    this.geometry.setAttribute('aSpin', this.spins);
    this.geometry.setAttribute('aSpawn', this.spawns);
    this.geometry.setAttribute('aLife', this.lives);
    this.geometry.setAttribute('aSeed', this.seeds);

    const uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uGravity: { value: new THREE.Vector3(0, -Math.abs(gravity), 0) },
      uDrag: { value: Math.max(0.05, drag) },
    };
    this.uTime = uniforms.uTime;
    this.uOpacity = uniforms.uOpacity;

    this.material = new THREE.ShaderMaterial({
      vertexShader: CONFETTI_VERTEX,
      fragmentShader: CONFETTI_FRAGMENT,
      uniforms,
      transparent: true,
      // Paper is opaque, so it is blended normally rather than added — otherwise
      // a dense storm turns into a white sheet the moment bloom touches it.
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 8;
  }

  /** Caps how many pieces may exist at once, so 'low' quality throws less. */
  setBudget(pieces: number): void {
    this.budget = Math.max(16, Math.min(this.capacity, Math.floor(pieces)));
    this.geometry.instanceCount = this.budget;
    this.cursor %= this.budget;
  }

  burst(spec: ConfettiSpec): void {
    const count = Math.min(Math.max(0, Math.round(spec.count)), this.budget);
    if (count === 0) return;

    const palette = spec.colors.length > 0 ? spec.colors : null;

    for (let i = 0; i < count; i++) {
      const slot = this.cursor;
      this.cursor = (this.cursor + 1) % this.budget;

      const color =
        palette === null
          ? FALLBACK_COLOR
          : (palette[Math.floor(Math.random() * palette.length)] ?? FALLBACK_COLOR);

      this.origins.setXYZ(
        slot,
        spec.origin.x + (Math.random() * 2 - 1) * spec.spawnSpread.x,
        spec.origin.y + (Math.random() * 2 - 1) * spec.spawnSpread.y,
        spec.origin.z + (Math.random() * 2 - 1) * spec.spawnSpread.z,
      );
      this.velocities.setXYZ(
        slot,
        spec.velocity.x + (Math.random() * 2 - 1) * spec.velocitySpread.x,
        spec.velocity.y + (Math.random() * 2 - 1) * spec.velocitySpread.y,
        spec.velocity.z + (Math.random() * 2 - 1) * spec.velocitySpread.z,
      );
      this.colors.setXYZ(slot, color.r, color.g, color.b);

      const width = spec.size * (0.5 + Math.random() * 0.5);
      const streamer = Math.random() < STREAMER_CHANCE;
      const height = streamer
        ? spec.size * (1.8 + Math.random() * 1.6)
        : spec.size * (0.3 + Math.random() * 0.5);
      this.sizes.setXY(slot, width, height);

      // Random tumble axis on the unit sphere, plus a random spin rate.
      const theta = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const rate = (3 + Math.random() * 9) * (Math.random() < 0.5 ? -1 : 1);
      this.spins.setXYZW(slot, r * Math.cos(theta), r * Math.sin(theta), z, rate);

      this.spawns.setX(slot, spec.time);
      this.lives.setX(slot, Math.max(0.2, spec.life * (0.7 + Math.random() * 0.6)));
      this.seeds.setX(slot, Math.random());
    }

    this.origins.needsUpdate = true;
    this.velocities.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.sizes.needsUpdate = true;
    this.spins.needsUpdate = true;
    this.spawns.needsUpdate = true;
    this.lives.needsUpdate = true;
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
