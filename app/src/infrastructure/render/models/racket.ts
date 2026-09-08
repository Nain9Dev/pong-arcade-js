import * as THREE from 'three';

import type { Side } from '../../../domain/arena';
import { sideSign } from '../../../domain/arena';
import type { MatchRules } from '../../../domain/rules';
import type { QualityLevel } from '../../../application/ports';
import { SIDE_THEME } from '../palette';
import type { FrameContext, SceneModule } from './contract';
import { mergeAndDispose } from './merge';

/**
 * The racket each side swings — and the visual body of the paddle hitbox.
 *
 * Every dimension is derived from `rules.paddle`: the head is a superellipse
 * whose outer silhouette touches `halfWidth × halfHeight` exactly and whose rim
 * tube is `thickness` across, so what the player aims at is what the player
 * sees. The throat, grip, wrap and strap hang *outside* the hitbox — they are
 * pure personality and never lie about where the ball can be returned.
 *
 * Construction is done once, at build time, and everything after that is a
 * transform or a uniform: no geometry is rebuilt, no object is allocated per
 * frame. The string bed is a single merged mesh whose vertices are displaced in
 * the vertex shader, which is what makes the ripple free.
 */
export interface RacketModule extends SceneModule {
  /**
   * Rings the string bed. `intensity` is roughly `[0, 1]`; `offsetX`/`offsetY`
   * are the contact point normalised to `[-1, 1]` over the paddle face, which is
   * exactly the shape of `PaddleHitEvent.offset`.
   */
  impact(intensity: number, offsetX?: number, offsetY?: number): void;
  /** Adds a one-shot smear on top of the blur the paddle velocity already produces. */
  swing(intensity: number): void;
  /**
   * When disabled the module stops writing its own transform, so a character rig
   * can parent the racket to a hand and pose it. Enabled by default.
   */
  setAutoFollow(enabled: boolean): void;
  /** Centre of the string bed, in world space, for anchoring impact FX. */
  readonly faceAnchor: THREE.Object3D;
}

// ---------------------------------------------------------------------------
// Shape constants
// ---------------------------------------------------------------------------

/**
 * Superellipse exponent of the head outline. 2 is a plain ellipse and would lose
 * the corners of the hitbox; 2.4 keeps a racket silhouette while filling roughly
 * 88% of the rectangle the physics actually uses.
 */
const HEAD_EXPONENT = 2.4;

/** How far the handle is raked towards its own goal, in radians. */
const HANDLE_RAKE = 0.52;

const RIM_TUBULAR = 84;
const RIM_RADIAL = 6;
const THROAT_TUBULAR = 18;
const THROAT_RADIAL = 5;
const WRAP_TUBULAR = 88;
const WRAP_RADIAL = 4;
const WRAP_TURNS = 7;
const GRIP_SEGMENTS = 12;

/** Main strings, then the ones interleaved between them. */
const BED_MAIN_COLUMNS = 6;
const BED_MAIN_ROWS = 5;

const MAX_GHOSTS = 3;

interface RacketDetail {
  /** Smear copies of the rim drawn behind a moving racket. */
  readonly ghosts: number;
  /** Grommet strip, grip wrap and wrist strap. */
  readonly trim: boolean;
  /** Draws only the primary strings, halving the bed's index count. */
  readonly sparseBed: boolean;
}

const RACKET_DETAIL: Readonly<Record<QualityLevel, RacketDetail>> = {
  low: { ghosts: 0, trim: false, sparseBed: true },
  medium: { ghosts: 2, trim: true, sparseBed: false },
  high: { ghosts: MAX_GHOSTS, trim: true, sparseBed: false },
};

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Closed superellipse in the XY plane — the centreline of the head rim. */
class SuperellipseCurve extends THREE.Curve<THREE.Vector3> {
  private readonly rx: number;
  private readonly ry: number;

  constructor(rx: number, ry: number) {
    super();
    this.rx = rx;
    this.ry = ry;
  }

  override getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const angle = t * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const e = 2 / HEAD_EXPONENT;
    return target.set(
      Math.sign(c) * Math.abs(c) ** e * this.rx,
      Math.sign(s) * Math.abs(s) ** e * this.ry,
      0,
    );
  }
}

/** Grip tape: a helix running down the handle axis (local `-Y`). */
class HelixCurve extends THREE.Curve<THREE.Vector3> {
  private readonly length: number;
  private readonly radius: number;
  private readonly flare: number;

  constructor(length: number, radius: number, flare: number) {
    super();
    this.length = length;
    this.radius = radius;
    this.flare = flare;
  }

  override getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const angle = t * WRAP_TURNS * Math.PI * 2;
    const radius = this.radius * (1 + this.flare * t * t);
    return target.set(Math.cos(angle) * radius, -t * this.length, Math.sin(angle) * radius);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Frame-rate independent exponential approach factor. */
const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Half-chord of the head outline at a given `x` (or `y`, by symmetry). */
const chordHalf = (across: number, extent: number, span: number): number => {
  const u = Math.min(1, Math.abs(across) / extent);
  return span * (1 - u ** HEAD_EXPONENT) ** (1 / HEAD_EXPONENT);
};

const indexCount = (geometry: THREE.BufferGeometry): number => geometry.getIndex()?.count ?? 0;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class Racket implements RacketModule {
  readonly object3D = new THREE.Group();
  readonly faceAnchor = new THREE.Object3D();

  private readonly side: Side;
  private readonly maxPaddleSpeed: number;

  /** Everything that swings: rim, bed, throat, grip, strap. */
  private readonly head = new THREE.Group();
  private readonly strapPivot = new THREE.Group();
  private readonly ghosts: THREE.InstancedMesh;

  private readonly trim: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  private readonly rimMaterial: THREE.MeshStandardMaterial;
  private readonly bedMaterial: THREE.MeshStandardMaterial;
  private readonly ghostMaterial: THREE.MeshBasicMaterial;

  private readonly bed: THREE.Mesh;
  private readonly bedIndexTotal: number;
  private readonly bedIndexSparse: number;

  // Ripple uniforms, owned here so `onBeforeCompile` can hand the same objects
  // back to the shader on every recompile.
  private readonly uRipple = { value: 0 };
  private readonly uPhase = { value: 0 };
  private readonly uImpact = { value: new THREE.Vector2() };
  private readonly uBedScale = { value: new THREE.Vector2(1, 1) };

  private detail: RacketDetail = RACKET_DETAIL.high;
  private autoFollow = true;

  private flash = 0;
  private ripple = 0;
  private recoil = 0;
  private swingBoost = 0;
  private smear = 0;

  private bank = 0;
  private pitch = 0;
  private yaw = 0;
  private strapSwing = 0;
  private strapTilt = 0;

  // Per-frame scratch. Never allocate below this line.
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3(1, 1, 1);
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly ghostColor = new THREE.Color();

  constructor(side: Side, rules: MatchRules) {
    this.side = side;
    this.maxPaddleSpeed = Math.max(1e-3, rules.paddle.maxSpeed);

    const theme = SIDE_THEME[side];
    const { halfWidth, halfHeight, thickness } = rules.paddle;

    // The rim tube is inset by its own radius so the silhouette lands exactly on
    // the hitbox, and its diameter is exactly the paddle thickness.
    const tube = thickness * 0.5;
    const rx = Math.max(tube * 2, halfWidth - tube);
    const ry = Math.max(tube * 2, halfHeight - tube);

    // -- rim -----------------------------------------------------------------
    const rimGeometry = new THREE.TubeGeometry(
      new SuperellipseCurve(rx, ry),
      RIM_TUBULAR,
      tube,
      RIM_RADIAL,
      true,
    );
    this.rimMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a1120,
      emissive: theme.core,
      emissiveIntensity: 1.15,
      metalness: 0.72,
      roughness: 0.26,
    });
    this.disposables.push(rimGeometry, this.rimMaterial);
    this.head.add(new THREE.Mesh(rimGeometry, this.rimMaterial));

    const hardwareMaterial = new THREE.MeshStandardMaterial({
      color: 0x111a2e,
      emissive: theme.deep,
      emissiveIntensity: 0.85,
      metalness: 0.55,
      roughness: 0.42,
    });
    this.disposables.push(hardwareMaterial);

    // -- grommet strip -------------------------------------------------------
    const bedRx = rx - tube * 1.5;
    const bedRy = ry - tube * 1.5;
    const grommetGeometry = new THREE.TubeGeometry(
      new SuperellipseCurve(bedRx + tube * 0.55, bedRy + tube * 0.55),
      48,
      tube * 0.34,
      4,
      true,
    );
    this.disposables.push(grommetGeometry);
    const grommet = new THREE.Mesh(grommetGeometry, hardwareMaterial);
    this.head.add(grommet);
    this.trim.push(grommet);

    // -- string bed ----------------------------------------------------------
    const bedGeometry = buildStringBed(bedRx, bedRy, thickness);
    this.bedIndexTotal = indexCount(bedGeometry.geometry);
    this.bedIndexSparse = bedGeometry.sparseIndices;
    this.uBedScale.value.set(bedRx, bedRy);
    this.bedMaterial = new THREE.MeshStandardMaterial({
      color: 0x0e1626,
      emissive: theme.glow,
      emissiveIntensity: 0.55,
      metalness: 0.15,
      roughness: 0.55,
    });
    this.patchBedMaterial();
    this.disposables.push(bedGeometry.geometry, this.bedMaterial);
    this.bed = new THREE.Mesh(bedGeometry.geometry, this.bedMaterial);
    this.head.add(this.bed);

    // -- throat + grip -------------------------------------------------------
    const rake = -sideSign(side) * HANDLE_RAKE;
    const throatLength = ry * 0.55;
    const gripLength = ry * 0.92;
    const gripRadius = Math.max(0.12, thickness * 0.46);

    const jointY = -ry * 0.98;
    const converge = new THREE.Vector3(
      0,
      jointY - Math.cos(HANDLE_RAKE) * throatLength,
      -Math.sin(rake) * throatLength,
    );

    const shoulderX = rx * 0.55;
    const shoulderY = -chordHalf(shoulderX, rx, ry);
    const hardwareParts: THREE.BufferGeometry[] = [
      buildThroatArm(shoulderX, shoulderY, converge, tube * 0.62),
      buildThroatArm(-shoulderX, shoulderY, converge, tube * 0.62),
      buildGrip(gripLength, gripRadius, rake, converge),
    ];
    const hardwareGeometry = mergeAndDispose(hardwareParts);
    this.disposables.push(hardwareGeometry);
    this.head.add(new THREE.Mesh(hardwareGeometry, hardwareMaterial));

    // -- grip wrap + wrist strap --------------------------------------------
    const wrapMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b2742,
      emissive: theme.core,
      emissiveIntensity: 0.22,
      metalness: 0.1,
      roughness: 0.88,
    });
    this.disposables.push(wrapMaterial);

    const wrapGeometry = new THREE.TubeGeometry(
      new HelixCurve(gripLength * 0.86, gripRadius * 1.03, 0.22),
      WRAP_TUBULAR,
      gripRadius * 0.2,
      WRAP_RADIAL,
      false,
    );
    wrapGeometry.rotateX(rake);
    wrapGeometry.translate(converge.x, converge.y, converge.z);
    this.disposables.push(wrapGeometry);
    const wrap = new THREE.Mesh(wrapGeometry, wrapMaterial);
    this.head.add(wrap);
    this.trim.push(wrap);

    const strapGeometry = buildStrap(gripRadius);
    this.disposables.push(strapGeometry);
    this.strapPivot.position.set(
      converge.x,
      converge.y - Math.cos(HANDLE_RAKE) * gripLength,
      converge.z - Math.sin(rake) * gripLength,
    );
    this.strapPivot.rotation.x = rake;
    this.strapPivot.add(new THREE.Mesh(strapGeometry, wrapMaterial));
    this.head.add(this.strapPivot);
    this.trim.push(this.strapPivot);

    // -- swing smear ---------------------------------------------------------
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: theme.glow,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(this.ghostMaterial);
    this.ghosts = new THREE.InstancedMesh(rimGeometry, this.ghostMaterial, MAX_GHOSTS);
    this.ghosts.frustumCulled = false;
    this.ghosts.renderOrder = 2;
    this.ghosts.visible = false;
    for (let i = 0; i < MAX_GHOSTS; i++) {
      // Baked once: the per-instance fade never changes, only the matrices do.
      const fade = 1 - i / MAX_GHOSTS;
      this.ghostColor.setScalar(fade * fade);
      this.ghosts.setColorAt(i, this.ghostColor);
      this.ghosts.setMatrixAt(i, this.scratchMatrix.identity());
    }
    if (this.ghosts.instanceColor !== null) this.ghosts.instanceColor.needsUpdate = true;

    this.head.add(this.faceAnchor);
    this.object3D.add(this.head);
    this.object3D.add(this.ghosts);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  impact(intensity: number, offsetX = 0, offsetY = 0): void {
    const strength = THREE.MathUtils.clamp(intensity, 0, 1.5);
    this.flash = Math.min(1.8, this.flash + strength);
    this.ripple = Math.min(1.4, this.ripple + strength * 0.9);
    this.recoil = Math.min(1.2, this.recoil + strength * 0.8);
    this.swingBoost = Math.min(1.4, this.swingBoost + strength * 0.5);
    this.uPhase.value = 0;
    this.uImpact.value.set(
      THREE.MathUtils.clamp(offsetX, -1, 1),
      THREE.MathUtils.clamp(offsetY, -1, 1),
    );
    this.strapSwing += strength * 5;
  }

  swing(intensity: number): void {
    this.swingBoost = Math.min(1.6, this.swingBoost + Math.max(0, intensity));
  }

  setAutoFollow(enabled: boolean): void {
    this.autoFollow = enabled;
  }

  update(ctx: FrameContext): void {
    const dt = Math.min(0.05, Math.max(1e-4, ctx.dt));
    const motion = ctx.reducedMotion ? 0.3 : 1;
    const paddle = ctx.paddles[this.side];

    if (this.autoFollow) this.object3D.position.copy(paddle.position);

    // --- decays ------------------------------------------------------------
    this.flash *= Math.exp(-8 * dt);
    this.ripple *= Math.exp(-6.5 * dt);
    this.recoil *= Math.exp(-9 * dt);
    this.swingBoost *= Math.exp(-6 * dt);
    this.uPhase.value += dt * 26;

    // --- pose --------------------------------------------------------------
    const vx = paddle.velocity.x / this.maxPaddleSpeed;
    const vy = paddle.velocity.y / this.maxPaddleSpeed;
    const travel = Math.min(1, Math.hypot(vx, vy));
    const sign = sideSign(this.side);
    const idle = ctx.dimmed ? 0.35 : 1;

    // The head lags behind the hand: it banks away from the direction of travel
    // and rolls a little further as it approaches the floor, which keeps the
    // grip clear of the arena wall at the bottom of its run.
    const bankTarget =
      (-vx * 0.46 - paddle.normalised.y * 0.12) * motion;
    const pitchTarget = (vy * 0.34 * sign + Math.sin(ctx.time * 1.7) * 0.02 * idle) * motion;
    const yawTarget = (vx * 0.3 * sign + Math.sin(ctx.time * 1.1 + 1.7) * 0.03 * idle) * motion;

    const blend = approach(14, dt);
    this.bank += (bankTarget - this.bank) * blend;
    this.pitch += (pitchTarget - this.pitch) * blend;
    this.yaw += (yawTarget - this.yaw) * blend;

    this.head.rotation.set(this.pitch, this.yaw, this.bank);

    // Recoil shoves the whole racket back towards its own goal on contact.
    this.head.position.z = sign * this.recoil * 0.42;
    const stretch = 1 + this.recoil * 0.07;
    this.head.scale.set(stretch, stretch, 1 - this.recoil * 0.22);

    // --- string bed --------------------------------------------------------
    this.uRipple.value = this.ripple * 0.16 * motion;
    const fade = ctx.dimmed ? 0.35 : 1;
    this.bedMaterial.emissiveIntensity = (0.5 + this.ripple * 1.9) * fade;
    this.rimMaterial.emissiveIntensity = (1.05 + this.flash * 3.4) * fade;

    // --- wrist strap -------------------------------------------------------
    // A one-degree-of-freedom pendulum: cheap, and it sells the weight of the
    // racket better than any amount of extra geometry.
    const strapDrive = (-vx * 3.4 - this.strapTilt * 26 - this.strapSwing * 4.5) * motion;
    this.strapSwing += strapDrive * dt;
    this.strapTilt += this.strapSwing * dt;
    this.strapTilt = THREE.MathUtils.clamp(this.strapTilt, -0.9, 0.9);
    this.strapPivot.rotation.z = this.strapTilt;

    // --- swing smear -------------------------------------------------------
    const smearTarget = Math.min(1, travel * 1.15 + this.swingBoost);
    this.smear += (smearTarget - this.smear) * approach(18, dt);
    this.updateGhosts(vx, vy, fade * motion);
  }

  setQuality(level: QualityLevel): void {
    const detail = RACKET_DETAIL[level];
    this.detail = detail;
    for (const part of this.trim) part.visible = detail.trim;
    this.ghosts.count = detail.ghosts;
    this.ghosts.visible = detail.ghosts > 0;
    this.bed.geometry.setDrawRange(
      0,
      detail.sparseBed ? this.bedIndexSparse : this.bedIndexTotal,
    );
  }

  dispose(): void {
    this.ghosts.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.trim.length = 0;
    this.strapPivot.clear();
    this.head.clear();
    this.object3D.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Injects the ripple into the standard vertex shader. Only `begin_vertex` is
   * touched, so lighting, tone mapping and colour management stay exactly as
   * three.js built them.
   */
  private patchBedMaterial(): void {
    this.bedMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uRipple = this.uRipple;
      shader.uniforms.uPhase = this.uPhase;
      shader.uniforms.uImpact = this.uImpact;
      shader.uniforms.uBedScale = this.uBedScale;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uRipple;',
          'uniform float uPhase;',
          'uniform vec2 uImpact;',
          'uniform vec2 uBedScale;',
        ].join('\n'),
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vec2 bedUv = transformed.xy / uBedScale;',
          'float bedDist = distance(bedUv, uImpact);',
          'float bedWave = sin(bedDist * 7.5 - uPhase) * exp(-bedDist * 2.1);',
          'transformed.z += bedWave * uRipple;',
        ].join('\n'),
      );
    };
    this.bedMaterial.needsUpdate = true;
  }

  private updateGhosts(vx: number, vy: number, fade: number): void {
    const count = this.detail.ghosts;
    if (count <= 0) {
      this.ghosts.visible = false;
      return;
    }

    const opacity = this.smear * 0.42 * fade;
    this.ghostMaterial.opacity = opacity;
    this.ghosts.visible = opacity > 0.01;
    if (!this.ghosts.visible) return;

    const length = Math.hypot(vx, vy);
    const dirX = length > 1e-4 ? vx / length : 0;
    const dirY = length > 1e-4 ? vy / length : 1;
    const reach = Math.min(1.1, length * 1.4) * this.smear;

    for (let i = 0; i < count; i++) {
      const step = ((i + 1) / count) * reach;
      this.scratchPosition.set(
        this.head.position.x - dirX * step,
        this.head.position.y - dirY * step,
        this.head.position.z,
      );
      const shrink = 1 - (i + 1) / (count + 3);
      this.scratchScale.set(shrink, shrink, shrink);
      this.scratchMatrix.compose(this.scratchPosition, this.head.quaternion, this.scratchScale);
      this.ghosts.setMatrixAt(i, this.scratchMatrix);
    }
    this.ghosts.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Geometry builders (build time only — allocation here is free)
// ---------------------------------------------------------------------------

/**
 * The string bed as one merged mesh.
 *
 * Primary strings are emitted first and the interleaved ones after, so the low
 * quality level can drop half the bed with `setDrawRange` instead of rebuilding
 * anything. Alternating strings are nudged in `z` so the weave actually reads.
 */
const buildStringBed = (
  rx: number,
  ry: number,
  thickness: number,
): { geometry: THREE.BufferGeometry; sparseIndices: number } => {
  const radius = Math.max(0.014, thickness * 0.06);
  const main: THREE.BufferGeometry[] = [];
  const extra: THREE.BufferGeometry[] = [];

  const column = (x: number, target: THREE.BufferGeometry[], weave: number): void => {
    const half = chordHalf(x, rx, ry);
    if (half < radius * 3) return;
    const strand = new THREE.CylinderGeometry(radius, radius, half * 2, 6, 1, true);
    strand.translate(x, 0, weave * radius * 0.9);
    target.push(strand);
  };

  const row = (y: number, target: THREE.BufferGeometry[], weave: number): void => {
    const half = chordHalf(y, ry, rx);
    if (half < radius * 3) return;
    const strand = new THREE.CylinderGeometry(radius, radius, half * 2, 6, 1, true);
    strand.rotateZ(Math.PI * 0.5);
    strand.translate(0, y, weave * radius * 0.9);
    target.push(strand);
  };

  for (let i = 0; i < BED_MAIN_COLUMNS; i++) {
    const t = (i + 0.5) / BED_MAIN_COLUMNS;
    const x = (t * 2 - 1) * rx * 0.94;
    column(x, main, i % 2 === 0 ? 1 : -1);
  }
  for (let i = 0; i < BED_MAIN_ROWS; i++) {
    const t = (i + 0.5) / BED_MAIN_ROWS;
    const y = (t * 2 - 1) * ry * 0.94;
    row(y, main, i % 2 === 0 ? -1 : 1);
  }
  for (let i = 0; i < BED_MAIN_COLUMNS - 1; i++) {
    const t = (i + 1) / BED_MAIN_COLUMNS;
    const x = (t * 2 - 1) * rx * 0.94;
    column(x, extra, i % 2 === 0 ? -1 : 1);
  }
  for (let i = 0; i < BED_MAIN_ROWS - 1; i++) {
    const t = (i + 1) / BED_MAIN_ROWS;
    const y = (t * 2 - 1) * ry * 0.94;
    row(y, extra, i % 2 === 0 ? 1 : -1);
  }

  let sparseIndices = 0;
  for (const strand of main) sparseIndices += indexCount(strand);

  const all = main.concat(extra);
  const geometry = mergeAndDispose(all);
  return { geometry, sparseIndices };
};

/** One arm of the throat, curving from a shoulder of the head down to the grip. */
const buildThroatArm = (
  shoulderX: number,
  shoulderY: number,
  converge: THREE.Vector3,
  radius: number,
): THREE.BufferGeometry => {
  const start = new THREE.Vector3(shoulderX, shoulderY, 0);
  const control = new THREE.Vector3(
    shoulderX * 0.86,
    (shoulderY + converge.y) * 0.5,
    converge.z * 0.35,
  );
  const curve = new THREE.QuadraticBezierCurve3(start, control, converge);
  return new THREE.TubeGeometry(curve, THROAT_TUBULAR, radius, THROAT_RADIAL, false);
};

/** Lathed handle with a flared butt cap, raked into place. */
const buildGrip = (
  length: number,
  radius: number,
  rake: number,
  converge: THREE.Vector3,
): THREE.BufferGeometry => {
  // Bottom to top, which is the winding three.js expects for outward normals.
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0001, -length),
    new THREE.Vector2(radius * 1.32, -length + radius * 0.12),
    new THREE.Vector2(radius * 1.36, -length + radius * 0.42),
    new THREE.Vector2(radius * 1.02, -length * 0.9),
    new THREE.Vector2(radius * 0.94, -length * 0.36),
    new THREE.Vector2(radius, -length * 0.12),
    new THREE.Vector2(radius * 0.88, 0),
    new THREE.Vector2(0.0001, radius * 0.2),
  ];
  const geometry = new THREE.LatheGeometry(profile, GRIP_SEGMENTS);
  geometry.rotateX(rake);
  geometry.translate(converge.x, converge.y, converge.z);
  return geometry;
};

/** Wrist strap: a hanging loop and the bead that cinches it. */
const buildStrap = (gripRadius: number): THREE.BufferGeometry => {
  const loop = new THREE.TorusGeometry(gripRadius * 1.1, gripRadius * 0.16, 5, 14);
  loop.scale(0.75, 1, 0.42);
  loop.translate(0, -gripRadius * 1.15, 0);

  const bead = new THREE.SphereGeometry(gripRadius * 0.42, 7, 5);
  bead.translate(0, -gripRadius * 0.12, 0);

  return mergeAndDispose([loop, bead]);
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createRacket = (options: { side: Side; rules: MatchRules }): RacketModule =>
  new Racket(options.side, options.rules);
