import * as THREE from 'three';

import type { Arena, Side } from '../../domain/arena';
import { goalPlaneZ, SIDES } from '../../domain/arena';
import type { MatchRules } from '../../domain/rules';
import type { QualityProfile } from './palette';
import { PALETTE, SIDE_THEME } from './palette';
import { createRadialGlowTexture } from './textures';

/** Concurrent wall ripples the shader can carry; oldest slot is recycled. */
const MAX_RIPPLES = 4;

const RIPPLE_LIFE = 1.1;

export interface ArenaFrame {
  /** Seconds since mount; the same clock the ripple timestamps use. */
  readonly time: number;
  /** Accumulated grid offset along `z`, so speed reads as motion. */
  readonly scroll: number;
  /** `0` = full colour, `1` = fully desaturated (menu / pause). */
  readonly dim: number;
  readonly ballPosition: THREE.Vector3;
  /** How strongly the ball lights the walls around it, in `[0, 1]`. */
  readonly ballGlow: number;
}

const WALL_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WALL_FRAGMENT = /* glsl */ `
#define MAX_RIPPLES ${MAX_RIPPLES}

uniform float uTime;
uniform float uScroll;
uniform float uDim;
uniform float uDetail;
uniform float uCellMajor;
uniform float uCellMinor;
uniform float uHalfDepth;
uniform float uFogDensity;
uniform float uBallGlow;
uniform vec3 uBallPosition;
uniform vec3 uBase;
uniform vec3 uMajor;
uniform vec3 uMinor;
uniform vec3 uNearTint;
uniform vec3 uFarTint;
uniform vec3 uFogColor;
uniform vec4 uRipples[MAX_RIPPLES];

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

// Distance to the nearest grid line, converted back into world units so the
// line width can stay constant regardless of the cell size.
float lineMask(float coord, float cell, float width) {
  float d = abs(fract(coord / cell - 0.5) - 0.5) * cell;
  return 1.0 - smoothstep(0.0, width, d);
}

void main() {
  float dist = length(vWorldPos - cameraPosition);
  // Widening the line with distance is a cheap stand-in for derivative-based
  // antialiasing, which is not reliably available in GLSL ES 1.00 shaders.
  float width = 0.04 + dist * 0.008;

  vec2 plane = abs(vWorldNormal.x) > 0.5
    ? vec2(vWorldPos.z, vWorldPos.y)
    : vec2(vWorldPos.z, vWorldPos.x);
  plane.x += uScroll;

  float major = max(lineMask(plane.x, uCellMajor, width), lineMask(plane.y, uCellMajor, width));
  float minor = max(
    lineMask(plane.x, uCellMinor, width * 0.65),
    lineMask(plane.y, uCellMinor, width * 0.65)
  );

  vec3 color = uBase;
  color += uMinor * minor * 0.30 * uDetail;

  float sweep = 0.55 + 0.45 * sin(plane.x * 0.22 - uTime * 1.35);
  color += uMajor * major * (0.55 + 0.75 * sweep);

  float depth01 = clamp(vWorldPos.z / uHalfDepth, -1.0, 1.0);
  vec3 endTint = mix(uNearTint, uFarTint, depth01 * 0.5 + 0.5);
  float ends = smoothstep(0.30, 1.0, abs(depth01));
  color += endTint * ends * (0.10 + major * 0.65);

  float ballDist = distance(vWorldPos, uBallPosition);
  color += vec3(0.30, 0.72, 1.0) * uBallGlow * exp(-ballDist * ballDist * 0.030);

  // Branch-free so the loop stays within the GLSL ES 1.00 restrictions.
  for (int i = 0; i < MAX_RIPPLES; i++) {
    vec4 ripple = uRipples[i];
    float age = uTime - ripple.w;
    float alive = step(0.0, age) * step(age, ${RIPPLE_LIFE.toFixed(2)});
    float front = age * 24.0;
    float edge = (distance(vWorldPos, ripple.xyz) - front) * 0.85;
    float ring = exp(-min(edge * edge, 32.0)) * (1.0 - age / ${RIPPLE_LIFE.toFixed(2)});
    color += vec3(0.65, 0.88, 1.0) * ring * alive * uDetail;
  }

  float fog = clamp(1.0 - exp(-dist * dist * uFogDensity), 0.0, 1.0);
  color = mix(color, uFogColor, fog);

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(color, vec3(luma) * 0.30, uDim);

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Appends a rounded rectangle centred on the origin to a path. */
const roundedRect = (path: THREE.Path, halfW: number, halfH: number, radius: number): void => {
  const r = Math.max(0.001, Math.min(radius, halfW * 0.9, halfH * 0.9));
  path.moveTo(-halfW + r, -halfH);
  path.lineTo(halfW - r, -halfH);
  path.absarc(halfW - r, -halfH + r, r, -Math.PI / 2, 0, false);
  path.lineTo(halfW, halfH - r);
  path.absarc(halfW - r, halfH - r, r, 0, Math.PI / 2, false);
  path.lineTo(-halfW + r, halfH);
  path.absarc(-halfW + r, halfH - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(-halfW, -halfH + r);
  path.absarc(-halfW + r, -halfH + r, r, Math.PI, Math.PI * 1.5, false);
};

/**
 * The neon tunnel: four gridded inner walls, the twelve glowing box edges and a
 * tinted goal mouth at each end.
 *
 * Every dimension is derived from the `Arena` it is built for — the class never
 * assumes the default box.
 */
export class ArenaMesh {
  readonly object = new THREE.Group();

  private readonly wallMaterial: THREE.ShaderMaterial;
  private readonly ripples: THREE.Vector4[] = [];
  private rippleCursor = 0;
  /** Receding goal frames, ordered outwards, toggled by the quality profile. */
  private readonly goalRings: THREE.Object3D[] = [];
  private readonly edgeMaterial: THREE.LineBasicMaterial;
  private readonly goalGlows: THREE.Mesh[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(arena: Arena, rules: MatchRules) {
    const { halfWidth, halfDepth } = arena;

    for (let i = 0; i < MAX_RIPPLES; i++) {
      // `w` is the spawn time; a large negative value marks the slot as idle.
      this.ripples.push(new THREE.Vector4(0, 0, 0, -1e4));
    }

    const cellMajor = halfWidth / 3;
    this.wallMaterial = new THREE.ShaderMaterial({
      vertexShader: WALL_VERTEX,
      fragmentShader: WALL_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uDim: { value: 0 },
        uDetail: { value: 1 },
        uCellMajor: { value: cellMajor },
        uCellMinor: { value: cellMajor / 4 },
        uHalfDepth: { value: halfDepth },
        // Tuned so the far goal is roughly half-swallowed by the background.
        uFogDensity: { value: 0.8 / (4 * halfDepth * halfDepth) },
        uBallGlow: { value: 0 },
        uBallPosition: { value: new THREE.Vector3() },
        uBase: { value: new THREE.Color(PALETTE.wall) },
        uMajor: { value: new THREE.Color(PALETTE.gridMajor) },
        uMinor: { value: new THREE.Color(PALETTE.gridMinor) },
        uNearTint: { value: new THREE.Color(SIDE_THEME.near.core) },
        uFarTint: { value: new THREE.Color(SIDE_THEME.far.core) },
        uFogColor: { value: new THREE.Color(PALETTE.background) },
        uRipples: { value: this.ripples },
      },
      side: THREE.FrontSide,
    });
    this.disposables.push(this.wallMaterial);

    this.buildWalls(arena);

    this.edgeMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.edge,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(this.edgeMaterial);
    this.buildEdges(arena);

    const glowTexture = createRadialGlowTexture(128, 2.0);
    this.disposables.push(glowTexture);
    for (const side of SIDES) {
      this.buildGoal(arena, rules, side, glowTexture);
    }
  }

  private buildWalls(arena: Arena): void {
    const { halfWidth, halfHeight, halfDepth } = arena;
    const sideGeometry = new THREE.PlaneGeometry(halfDepth * 2, halfHeight * 2);
    const capGeometry = new THREE.PlaneGeometry(halfWidth * 2, halfDepth * 2);
    this.disposables.push(sideGeometry, capGeometry);

    // Rotations turn each plane's +Z normal inwards; the shader picks its grid
    // axes from that normal, so no per-wall uniforms are needed.
    const walls: ReadonlyArray<{
      geometry: THREE.BufferGeometry;
      position: [number, number, number];
      rotation: [number, number, number];
    }> = [
      { geometry: sideGeometry, position: [-halfWidth, 0, 0], rotation: [0, Math.PI / 2, 0] },
      { geometry: sideGeometry, position: [halfWidth, 0, 0], rotation: [0, -Math.PI / 2, 0] },
      { geometry: capGeometry, position: [0, -halfHeight, 0], rotation: [-Math.PI / 2, 0, 0] },
      { geometry: capGeometry, position: [0, halfHeight, 0], rotation: [Math.PI / 2, 0, 0] },
    ];

    for (const wall of walls) {
      const mesh = new THREE.Mesh(wall.geometry, this.wallMaterial);
      mesh.position.set(...wall.position);
      mesh.rotation.set(...wall.rotation);
      this.object.add(mesh);
    }
  }

  private buildEdges(arena: Arena): void {
    const box = new THREE.BoxGeometry(arena.halfWidth * 2, arena.halfHeight * 2, arena.halfDepth * 2);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    this.disposables.push(edges);
    const lines = new THREE.LineSegments(edges, this.edgeMaterial);
    lines.renderOrder = 1;
    this.object.add(lines);
  }

  private buildGoal(
    arena: Arena,
    rules: MatchRules,
    side: Side,
    glowTexture: THREE.Texture,
  ): void {
    const theme = SIDE_THEME[side];
    const z = goalPlaneZ(arena, side);
    const { halfWidth, halfHeight } = arena;
    const border = Math.max(rules.ball.radius, Math.min(halfWidth, halfHeight) * 0.09);
    const corner = Math.min(halfWidth, halfHeight) * 0.28;

    const frameShape = new THREE.Shape();
    roundedRect(frameShape, halfWidth + border, halfHeight + border, corner + border);
    const hole = new THREE.Path();
    roundedRect(hole, halfWidth, halfHeight, corner);
    frameShape.holes.push(hole);

    const frameGeometry = new THREE.ShapeGeometry(frameShape, 12);
    const frameMaterial = new THREE.MeshBasicMaterial({
      color: theme.core,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(frameGeometry, frameMaterial);
    const frame = new THREE.Mesh(frameGeometry, frameMaterial);
    frame.position.z = z;
    frame.renderOrder = 2;
    this.object.add(frame);

    // A soft wash of colour so the mouth of the tunnel glows even without bloom.
    const glowGeometry = new THREE.PlaneGeometry((halfWidth + border) * 2.6, (halfHeight + border) * 2.6);
    const glowMaterial = new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: theme.deep,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.disposables.push(glowGeometry, glowMaterial);
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.position.z = z + Math.sign(z) * 0.05;
    glow.renderOrder = 0;
    this.goalGlows.push(glow);
    this.object.add(glow);

    // Receding frames beyond the goal line: pure depth cue, no gameplay meaning.
    const ringPoints = frameShape.getPoints(10);
    const ringGeometry = new THREE.BufferGeometry().setFromPoints(ringPoints);
    this.disposables.push(ringGeometry);
    const maxRings = 4;
    for (let i = 1; i <= maxRings; i++) {
      const material = new THREE.LineBasicMaterial({
        color: theme.glow,
        transparent: true,
        opacity: 0.55 * (1 - i / (maxRings + 1)),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.disposables.push(material);
      const ring = new THREE.LineLoop(ringGeometry, material);
      const spacing = arena.halfDepth * 0.16;
      ring.position.z = z + Math.sign(z) * spacing * i;
      ring.scale.setScalar(1 + i * 0.12);
      this.goalRings.push(ring);
      this.object.add(ring);
    }
  }

  /** Fires an expanding ring of light centred on a wall impact. */
  ripple(x: number, y: number, z: number, time: number): void {
    const slot = this.ripples[this.rippleCursor % MAX_RIPPLES];
    this.rippleCursor = (this.rippleCursor + 1) % MAX_RIPPLES;
    if (slot === undefined) return;
    slot.set(x, y, z, time);
    this.wallMaterial.uniformsNeedUpdate = true;
  }

  update(frame: ArenaFrame): void {
    const uniforms = this.wallMaterial.uniforms;
    const time = uniforms.uTime;
    if (time !== undefined) time.value = frame.time;
    const scroll = uniforms.uScroll;
    if (scroll !== undefined) scroll.value = frame.scroll;
    const dim = uniforms.uDim;
    if (dim !== undefined) dim.value = frame.dim;
    const glow = uniforms.uBallGlow;
    if (glow !== undefined) glow.value = frame.ballGlow;
    const ball = uniforms.uBallPosition;
    if (ball !== undefined && ball.value instanceof THREE.Vector3) ball.value.copy(frame.ballPosition);

    const fade = 1 - frame.dim * 0.75;
    this.edgeMaterial.opacity = 0.85 * fade;
    for (const goalGlow of this.goalGlows) {
      const material = goalGlow.material;
      if (material instanceof THREE.MeshBasicMaterial) material.opacity = 0.85 * fade;
    }
  }

  setQuality(profile: QualityProfile): void {
    const detail = this.wallMaterial.uniforms.uDetail;
    if (detail !== undefined) detail.value = profile.gridDetail ? 1 : 0;
    // Rings alternate between the two goals, so budget them per side.
    const perSide = profile.goalRings;
    this.goalRings.forEach((ring, index) => {
      ring.visible = index % 4 < perSide;
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }
}
