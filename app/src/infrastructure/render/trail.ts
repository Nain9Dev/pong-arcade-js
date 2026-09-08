import * as THREE from 'three';

/**
 * A camera-facing ribbon drawn through the ball's recent positions.
 *
 * Samples live in a ring buffer and the ribbon is rebuilt into pre-allocated
 * attribute arrays every frame — the geometry, its buffers and its material are
 * created once and never reallocated, which is what keeps the trail free of
 * per-frame garbage at 60 Hz.
 */
export class BallTrail {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private readonly points: THREE.Vector3[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly halfWidth: number;
  /** Minimum travel before a new sample is recorded, in world units. */
  private readonly step: number;

  private head = 0;
  private count = 0;
  private active: number;

  private readonly tangent = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly lateral = new THREE.Vector3();
  private readonly tint = new THREE.Color();

  constructor(capacity: number, ballRadius: number) {
    this.capacity = Math.max(4, capacity);
    this.active = this.capacity;
    this.halfWidth = ballRadius * 0.92;
    this.step = ballRadius * 0.6;

    for (let i = 0; i < this.capacity; i++) this.points.push(new THREE.Vector3());

    this.positions = new Float32Array(this.capacity * 2 * 3);
    this.colors = new Float32Array(this.capacity * 2 * 3);
    const indices = new Uint16Array((this.capacity - 1) * 6);
    for (let i = 0; i < this.capacity - 1; i++) {
      const a = i * 2;
      const offset = i * 6;
      indices[offset] = a;
      indices[offset + 1] = a + 1;
      indices[offset + 2] = a + 2;
      indices[offset + 3] = a + 1;
      indices[offset + 4] = a + 3;
      indices[offset + 5] = a + 2;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    // Vertices move every frame, so the bounding volume is never trustworthy.
    this.object.frustumCulled = false;
    this.object.renderOrder = 3;
  }

  /** Limits how many samples the ribbon uses, without touching the buffers. */
  setLength(samples: number): void {
    this.active = Math.max(4, Math.min(this.capacity, Math.floor(samples)));
    if (this.count > this.active) this.count = this.active;
  }

  /** Drops the history — call this whenever the ball teleports (serve, goal). */
  reset(): void {
    this.count = 0;
    this.head = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /**
   * Records the ball's position. The head sample always tracks the ball exactly;
   * a new sample is only appended once the ball has travelled far enough, which
   * keeps the ribbon's length in world units instead of in frames.
   */
  push(position: THREE.Vector3): void {
    if (this.count === 0) {
      this.head = 0;
      this.sample(0).copy(position);
      this.count = 1;
      return;
    }

    const newest = this.sample(0);
    if (this.count === 1 || newest.distanceTo(this.sample(1)) >= this.step) {
      this.head = (this.head + 1) % this.capacity;
      if (this.count < this.active) this.count++;
    }
    this.sample(0).copy(position);
  }

  /**
   * Rebuilds the ribbon so it faces `camera`, fading from `color` at the head to
   * black (invisible under additive blending) at the tail.
   */
  update(camera: THREE.Camera, color: THREE.ColorRepresentation, intensity: number): void {
    if (this.count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    this.tint.set(color);
    const last = this.count - 1;
    for (let i = 0; i < this.count; i++) {
      const current = this.sample(i);
      const ahead = this.sample(Math.max(0, i - 1));
      const behind = this.sample(Math.min(last, i + 1));

      this.tangent.subVectors(ahead, behind);
      if (this.tangent.lengthSq() < 1e-8) this.tangent.set(0, 0, 1);
      this.toCamera.copy(camera.position).sub(current);
      this.lateral.crossVectors(this.tangent, this.toCamera);
      if (this.lateral.lengthSq() < 1e-8) this.lateral.set(1, 0, 0);
      this.lateral.normalize();

      const t = i / last;
      const width = this.halfWidth * (1 - t) ** 0.7;
      const fade = (1 - t) ** 1.8 * intensity;
      const offset = i * 6;

      this.positions[offset] = current.x + this.lateral.x * width;
      this.positions[offset + 1] = current.y + this.lateral.y * width;
      this.positions[offset + 2] = current.z + this.lateral.z * width;
      this.positions[offset + 3] = current.x - this.lateral.x * width;
      this.positions[offset + 4] = current.y - this.lateral.y * width;
      this.positions[offset + 5] = current.z - this.lateral.z * width;

      const r = this.tint.r * fade;
      const g = this.tint.g * fade;
      const b = this.tint.b * fade;
      this.colors[offset] = r;
      this.colors[offset + 1] = g;
      this.colors[offset + 2] = b;
      this.colors[offset + 3] = r;
      this.colors[offset + 4] = g;
      this.colors[offset + 5] = b;
    }

    const position = this.geometry.getAttribute('position');
    const colorAttribute = this.geometry.getAttribute('color');
    position.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, (this.count - 1) * 6);
  }

  private sample(index: number): THREE.Vector3 {
    const slot = (this.head - index + this.capacity * 2) % this.capacity;
    const point = this.points[slot];
    if (point === undefined) throw new RangeError(`Trail sample ${index} out of range`);
    return point;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
