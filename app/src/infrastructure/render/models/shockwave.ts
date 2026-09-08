import * as THREE from 'three';

/**
 * A pooled field of expanding impact rings.
 *
 * Every ring is one instanced quad with the annulus drawn analytically in the
 * fragment shader, so a ring costs two triangles no matter how big or how smooth
 * it looks, and the whole field is a single draw call. The animation is derived
 * entirely from the spawn state (`origin`, orientation, birth time), which means
 * spawning is a handful of writes into a ring buffer and the per-frame cost on
 * the CPU is one uniform assignment — nothing is allocated while the game runs.
 *
 * Rings are oriented by a quaternion that rotates the quad's `+Z` axis onto the
 * impact surface normal, so a ring always lies flat against the thing it hit.
 */
export interface ShockwaveSpec {
  readonly origin: THREE.Vector3;
  /** Surface normal at the contact point; the ring expands in its plane. */
  readonly normal: THREE.Vector3;
  readonly color: THREE.Color;
  /** Radius the ring reaches at the end of its life, in world units. */
  readonly radius: number;
  readonly life: number;
  /** Brightness and thickness multiplier, roughly `[0.2, 1.6]`. */
  readonly power: number;
  /**
   * Effect-clock seconds at which the ring is born. Passing a value slightly in
   * the future is legal and is how the comic "double take" double rings work.
   */
  readonly time: number;
}

interface Uniform<T> {
  value: T;
}

/** Local `+Z` of the quad, rotated onto each impact normal at spawn time. */
const QUAD_FORWARD = new THREE.Vector3(0, 0, 1);

const SHOCKWAVE_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aQuat;
attribute vec3 aColor;
attribute float aSpawn;
attribute float aLife;
attribute float aRadius;
attribute float aPower;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vPower;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  float life = max(aLife, 0.0001);
  float t = (uTime - aSpawn) / life;

  vUv = uv;
  vColor = aColor;
  vPower = aPower;
  vAge = t;

  if (t < 0.0 || t > 1.0) {
    // Dead slot: park the vertex past the far plane so it is clipped for free.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // Snappy out-ease: the ring is already wide by the time the eye finds it.
  float eased = 1.0 - pow(1.0 - t, 2.6);
  float radius = aRadius * (0.10 + 0.90 * eased);
  vec3 local = vec3(position.xy * radius * 2.0, 0.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(aOrigin + qrot(aQuat, local), 1.0);
}
`;

const SHOCKWAVE_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float uDetail;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vPower;

void main() {
  if (vAge < 0.0 || vAge > 1.0) discard;

  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  // A little wobble keeps the ring hand-drawn instead of machined.
  float wobble = 1.0 + 0.05 * cos(atan(p.y, p.x) * 7.0 + vAge * 9.0);

  float fade = pow(1.0 - vAge, 0.7);
  float width = mix(0.30, 0.045, vAge) * clamp(vPower, 0.35, 1.6);

  float ring = smoothstep(width, 0.0, abs(d - 0.84 * wobble));
  float echo = smoothstep(width * 0.65, 0.0, abs(d - 0.50 * wobble)) * 0.42 * uDetail;
  float core = smoothstep(0.85, 0.0, d) * pow(1.0 - vAge, 7.0) * 0.55;

  float alpha = (ring + echo + core) * fade * vPower * uOpacity;
  if (alpha < 0.003) discard;

  gl_FragColor = vec4(vColor * (0.55 + 0.85 * (ring + core)), alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ShockwaveField {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private budget: number;
  private cursor = 0;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly origins: THREE.InstancedBufferAttribute;
  private readonly quats: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly spawns: THREE.InstancedBufferAttribute;
  private readonly lives: THREE.InstancedBufferAttribute;
  private readonly radii: THREE.InstancedBufferAttribute;
  private readonly powers: THREE.InstancedBufferAttribute;

  private readonly uTime: Uniform<number>;
  private readonly uOpacity: Uniform<number>;
  private readonly uDetail: Uniform<number>;

  // Scratch state reused by every spawn; the pool never allocates after mount.
  private readonly normal = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  constructor(capacity: number) {
    this.capacity = Math.max(4, Math.floor(capacity));
    this.budget = this.capacity;

    const instanced = (components: number): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.capacity * components),
        components,
      );

    this.origins = instanced(3);
    this.quats = instanced(4);
    this.colors = instanced(3);
    this.spawns = instanced(1);
    this.lives = instanced(1);
    this.radii = instanced(1);
    this.powers = instanced(1);
    // Every slot starts long dead so nothing is drawn before the first impact.
    for (let i = 0; i < this.capacity; i++) {
      this.spawns.setX(i, -1e4);
      this.lives.setX(i, 1);
      this.quats.setXYZW(i, 0, 0, 0, 1);
    }

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.instanceCount = this.budget;
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        // A unit quad centred on the origin; the shader scales it to the radius.
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
    this.geometry.setAttribute('aQuat', this.quats);
    this.geometry.setAttribute('aColor', this.colors);
    this.geometry.setAttribute('aSpawn', this.spawns);
    this.geometry.setAttribute('aLife', this.lives);
    this.geometry.setAttribute('aRadius', this.radii);
    this.geometry.setAttribute('aPower', this.powers);

    const uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uDetail: { value: 1 },
    };
    this.uTime = uniforms.uTime;
    this.uOpacity = uniforms.uOpacity;
    this.uDetail = uniforms.uDetail;

    this.material = new THREE.ShaderMaterial({
      vertexShader: SHOCKWAVE_VERTEX,
      fragmentShader: SHOCKWAVE_FRAGMENT,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    // Positions live in the shader, so no bounding volume is ever trustworthy.
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
  }

  /** Caps how many rings may be alive at once, so 'low' quality draws fewer. */
  setBudget(rings: number): void {
    this.budget = Math.max(4, Math.min(this.capacity, Math.floor(rings)));
    this.geometry.instanceCount = this.budget;
    this.cursor %= this.budget;
  }

  /** Turns off the secondary echo ring on the cheapest quality level. */
  setDetail(enabled: boolean): void {
    this.uDetail.value = enabled ? 1 : 0;
  }

  spawn(spec: ShockwaveSpec): void {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.budget;

    this.normal.copy(spec.normal);
    if (this.normal.lengthSq() < 1e-8) this.normal.copy(QUAD_FORWARD);
    else this.normal.normalize();
    this.rotation.setFromUnitVectors(QUAD_FORWARD, this.normal);

    this.origins.setXYZ(slot, spec.origin.x, spec.origin.y, spec.origin.z);
    this.quats.setXYZW(slot, this.rotation.x, this.rotation.y, this.rotation.z, this.rotation.w);
    this.colors.setXYZ(slot, spec.color.r, spec.color.g, spec.color.b);
    this.spawns.setX(slot, spec.time);
    this.lives.setX(slot, Math.max(0.05, spec.life));
    this.radii.setX(slot, Math.max(0.01, spec.radius));
    this.powers.setX(slot, Math.max(0.05, spec.power));

    // The pool is tiny; a full re-upload beats bookkeeping dirty ranges.
    this.origins.needsUpdate = true;
    this.quats.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.spawns.needsUpdate = true;
    this.lives.needsUpdate = true;
    this.radii.needsUpdate = true;
    this.powers.needsUpdate = true;
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
