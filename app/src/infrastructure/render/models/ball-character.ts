import * as THREE from 'three';

import type { DomainEvent } from '../../../domain/events';
import type { MatchRules } from '../../../domain/rules';
import type { QualityLevel } from '../../../application/ports';
import { PALETTE } from '../palette';
import { createRadialGlowTexture } from '../textures';
import type { FrameContext, ReactiveModule } from './contract';

/**
 * The ball, as a cast member.
 *
 * Three ideas carry the whole performance:
 *
 * 1. **Squash and stretch.** A single spring drives one scalar: positive means
 *    stretched along the axis of travel, negative means flattened against
 *    whatever just hit it. The spring is deliberately underdamped, so the ball
 *    overshoots and jiggles back the way a rubber ball would.
 * 2. **A face that is not part of the body.** The deformed shell lives under a
 *    scaled node; the face is a sibling that is *placed* on the deformed surface
 *    every frame. That way the ball can be squashed to a pancake without the
 *    eyes turning into ovals.
 * 3. **Lag.** Pupils are on their own spring, so they arrive late and wobble.
 *    That single detail is what makes an emissive sphere read as alive.
 *
 * Everything is procedural and everything is pre-allocated: `update` performs no
 * allocation at all, and the only per-frame uploads are the sweat instance
 * matrices, which are skipped entirely when no droplet is alive.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Body spring: underdamped on purpose (zeta ~= 0.43). */
const BODY_STIFFNESS = 260;
const BODY_DAMPING = 14;

/** Pupil spring: looser and wobblier than the body. */
const PUPIL_STIFFNESS = 170;
const PUPIL_DAMPING = 9;

/** Above this speed ratio the ball starts sweating. */
const SWEAT_THRESHOLD = 0.7;
const MAX_SWEAT = 8;

/** Angular placement of the eyes on the leading hemisphere, in radians. */
const EYE_YAW = 0.62;
const EYE_PITCH = 0.2;
/** Angle below the face axis where the mouth sits. */
const MOUTH_PITCH = 0.46;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);
const UNIT_Y = new THREE.Vector3(0, 1, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);

interface BallDetail {
  readonly sweat: number;
  readonly seam: boolean;
  readonly halo: boolean;
  readonly highlights: boolean;
  readonly denseShell: boolean;
}

const BALL_DETAIL: Readonly<Record<QualityLevel, BallDetail>> = {
  low: { sweat: 0, seam: false, halo: false, highlights: false, denseShell: false },
  medium: { sweat: 5, seam: true, halo: true, highlights: true, denseShell: true },
  high: { sweat: MAX_SWEAT, seam: true, halo: true, highlights: true, denseShell: true },
};

// ---------------------------------------------------------------------------
// Curves and textures
// ---------------------------------------------------------------------------

/**
 * The tennis-ball seam: `x = a·cos t + b·cos 3t`, `y = a·sin t − b·sin 3t`,
 * `z = c·sin 2t`. The point lies on a sphere of radius `a + b` exactly when
 * `c² = 4ab`, which is why these three numbers are what they are.
 */
class SeamCurve extends THREE.Curve<THREE.Vector3> {
  private readonly radius: number;

  constructor(radius: number) {
    super();
    this.radius = radius;
  }

  override getPoint(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const a = t * Math.PI * 2;
    return target
      .set(
        0.7 * Math.cos(a) + 0.3 * Math.cos(3 * a),
        0.7 * Math.sin(a) - 0.3 * Math.sin(3 * a),
        0.91651514 * Math.sin(2 * a),
      )
      .multiplyScalar(this.radius);
  }
}

/** The classic "seeing stars" spiral, painted once into a 64px canvas. */
const createSpiralTexture = (size = 64): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2D canvas context unavailable for the dizzy spiral');

  context.clearRect(0, 0, size, size);
  context.strokeStyle = '#0a0f1e';
  context.lineWidth = size * 0.1;
  context.lineCap = 'round';
  context.beginPath();
  const steps = 110;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * 2.7 * Math.PI * 2;
    const radius = t * size * 0.41;
    const x = size * 0.5 + Math.cos(angle) * radius;
    const y = size * 0.5 + Math.sin(angle) * radius;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

// ---------------------------------------------------------------------------
// Small value types
// ---------------------------------------------------------------------------

interface Eye {
  readonly pivot: THREE.Group;
  readonly white: THREE.Mesh;
  readonly pupil: THREE.Mesh;
  readonly spiral: THREE.Mesh;
}

interface Droplet {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class BallCharacter implements ReactiveModule {
  readonly object3D = new THREE.Group();

  private readonly radius: number;
  private readonly maxSpeed: number;

  private readonly deform = new THREE.Group();
  private readonly counter = new THREE.Group();
  private readonly roller = new THREE.Group();
  private readonly face = new THREE.Group();
  private readonly sweatLayer = new THREE.Group();

  private readonly shell: THREE.Mesh;
  private readonly shellDense: THREE.BufferGeometry;
  private readonly shellCoarse: THREE.BufferGeometry;
  private readonly seam: THREE.Mesh;
  private readonly mouth: THREE.Mesh;
  private readonly tongue: THREE.Mesh;
  private readonly halo: THREE.Sprite;
  private readonly sweat: THREE.InstancedMesh;
  private readonly eyes: readonly Eye[];
  private readonly highlights: THREE.Object3D[] = [];

  private readonly shellMaterial: THREE.MeshStandardMaterial;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly haloMaterial: THREE.SpriteMaterial;
  private readonly sweatMaterial: THREE.MeshBasicMaterial;
  private readonly whiteMaterial: THREE.MeshStandardMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  private detail: BallDetail = BALL_DETAIL.high;

  // --- performance state ---------------------------------------------------
  private deformAmount = 0;
  private deformVelocity = 0;
  private speedRatio = 0;
  private mouthPop = 0;
  private wideEyes = 0;
  private dizzy = 0;
  private cheer = 0;
  private blinkPhase = 0;
  private blinkClock = 2.5;
  private sweatClock = 0;
  private sweatAlive = 0;

  private readonly droplets: Droplet[] = [];

  // --- scratch, never reallocated -----------------------------------------
  private readonly travel = new THREE.Vector3(0, 0, 1);
  private readonly deformAxis = new THREE.Vector3(0, 0, 1);
  private readonly impactAxis = new THREE.Vector3(0, 0, 1);
  private readonly pupil = new THREE.Vector2();
  private readonly pupilVelocity = new THREE.Vector2();
  private readonly pupilTarget = new THREE.Vector2();
  private readonly mouthBase = new THREE.Vector3();
  private readonly mouthDown = new THREE.Vector3();
  private readonly scratchVector = new THREE.Vector3();
  private readonly scratchAxis = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly faceBasis = new THREE.Matrix4();
  private readonly dropletMatrix = new THREE.Matrix4();
  private readonly dropletQuaternion = new THREE.Quaternion();
  private readonly rollQuaternion = new THREE.Quaternion();

  constructor(rules: MatchRules) {
    const radius = rules.ball.radius;
    this.radius = radius;
    this.maxSpeed = Math.max(1e-3, rules.ball.maxSpeed);

    // -- body ---------------------------------------------------------------
    this.shellDense = new THREE.SphereGeometry(radius, 28, 20);
    this.shellCoarse = new THREE.SphereGeometry(radius, 14, 10);
    this.shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x121a2c,
      emissive: PALETTE.ball,
      emissiveIntensity: 1.3,
      metalness: 0.18,
      roughness: 0.24,
    });
    this.disposables.push(this.shellDense, this.shellCoarse, this.shellMaterial);
    this.shell = new THREE.Mesh(this.shellDense, this.shellMaterial);
    this.roller.add(this.shell);

    const coreGeometry = new THREE.SphereGeometry(radius * 0.52, 12, 10);
    this.coreMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.ball, toneMapped: false });
    this.disposables.push(coreGeometry, this.coreMaterial);
    this.roller.add(new THREE.Mesh(coreGeometry, this.coreMaterial));

    const seamGeometry = new THREE.TubeGeometry(
      new SeamCurve(radius * 1.005),
      96,
      radius * 0.055,
      4,
      true,
    );
    const seamMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b1020,
      emissive: PALETTE.ballHalo,
      emissiveIntensity: 0.28,
      metalness: 0.1,
      roughness: 0.7,
    });
    this.disposables.push(seamGeometry, seamMaterial);
    this.seam = new THREE.Mesh(seamGeometry, seamMaterial);
    this.roller.add(this.seam);

    this.counter.add(this.roller);
    this.deform.add(this.counter);
    this.object3D.add(this.deform);

    // -- face ---------------------------------------------------------------
    const eyeRadius = radius * 0.44;
    const whiteGeometry = new THREE.SphereGeometry(eyeRadius, 14, 12);
    this.whiteMaterial = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0xffffff,
      emissiveIntensity: 0.35,
      metalness: 0.05,
      roughness: 0.32,
    });
    const pupilGeometry = new THREE.SphereGeometry(eyeRadius * 0.46, 12, 10);
    const pupilMaterial = new THREE.MeshStandardMaterial({
      color: 0x04060e,
      emissive: 0x000000,
      metalness: 0.3,
      roughness: 0.18,
    });
    const glintGeometry = new THREE.SphereGeometry(eyeRadius * 0.17, 7, 6);
    const glintMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const spiralTexture = createSpiralTexture();
    const spiralGeometry = new THREE.CircleGeometry(eyeRadius * 0.94, 18);
    const spiralMaterial = new THREE.MeshBasicMaterial({
      map: spiralTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(
      whiteGeometry,
      this.whiteMaterial,
      pupilGeometry,
      pupilMaterial,
      glintGeometry,
      glintMaterial,
      spiralGeometry,
      spiralMaterial,
      spiralTexture,
    );

    const eyes: Eye[] = [];
    for (const lateral of [-1, 1] as const) {
      const pivot = new THREE.Group();
      this.scratchAxis
        .set(
          lateral * Math.sin(EYE_YAW) * Math.cos(EYE_PITCH),
          Math.sin(EYE_PITCH),
          Math.cos(EYE_YAW) * Math.cos(EYE_PITCH),
        )
        .normalize();
      pivot.position.copy(this.scratchAxis).multiplyScalar(radius * 0.8);
      this.orientTowards(this.scratchAxis, pivot.quaternion);

      const white = new THREE.Mesh(whiteGeometry, this.whiteMaterial);
      pivot.add(white);

      const pupil = new THREE.Mesh(pupilGeometry, pupilMaterial);
      pupil.scale.z = 0.72;
      const glint = new THREE.Mesh(glintGeometry, glintMaterial);
      glint.position.set(-eyeRadius * 0.16, eyeRadius * 0.17, eyeRadius * 0.34);
      pupil.add(glint);
      this.highlights.push(glint);
      pivot.add(pupil);

      const spiral = new THREE.Mesh(spiralGeometry, spiralMaterial);
      spiral.position.z = eyeRadius * 0.86;
      spiral.visible = false;
      spiral.renderOrder = 3;
      pivot.add(spiral);

      this.face.add(pivot);
      eyes.push({ pivot, white, pupil, spiral });
    }
    this.eyes = eyes;

    // The mouth is a flat disc sitting on the tangent plane of the sphere, so it
    // is always outside the shell and never z-fights with it.
    this.scratchAxis.set(0, -Math.sin(MOUTH_PITCH), Math.cos(MOUTH_PITCH)).normalize();
    const mouthGeometry = new THREE.CircleGeometry(1, 22);
    const mouthMaterial = new THREE.MeshBasicMaterial({ color: 0x150310, toneMapped: false });
    this.disposables.push(mouthGeometry, mouthMaterial);
    this.mouth = new THREE.Mesh(mouthGeometry, mouthMaterial);
    this.mouth.position.copy(this.scratchAxis).multiplyScalar(radius * 1.015);
    this.orientTowards(this.scratchAxis, this.mouth.quaternion);
    this.mouth.rotateZ(0.13);
    this.mouth.renderOrder = 2;
    this.face.add(this.mouth);

    this.mouthBase.copy(this.scratchAxis).multiplyScalar(radius * 1.04);
    this.mouthDown.set(0, -1, 0).projectOnPlane(this.scratchAxis).normalize();

    const tongueGeometry = new THREE.SphereGeometry(radius * 0.17, 9, 7);
    tongueGeometry.scale(1, 0.62, 0.5);
    const tongueMaterial = new THREE.MeshBasicMaterial({ color: 0xfb7185, toneMapped: false });
    this.disposables.push(tongueGeometry, tongueMaterial);
    this.tongue = new THREE.Mesh(tongueGeometry, tongueMaterial);
    this.tongue.renderOrder = 3;
    this.tongue.visible = false;
    this.face.add(this.tongue);

    this.object3D.add(this.face);

    // -- halo ---------------------------------------------------------------
    const haloTexture = createRadialGlowTexture(96, 2.8);
    this.haloMaterial = new THREE.SpriteMaterial({
      map: haloTexture,
      color: PALETTE.ballHalo,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(haloTexture, this.haloMaterial);
    this.halo = new THREE.Sprite(this.haloMaterial);
    this.halo.scale.setScalar(radius * 6);
    this.object3D.add(this.halo);

    // -- sweat --------------------------------------------------------------
    const dropGeometry = new THREE.SphereGeometry(radius * 0.13, 6, 5);
    this.sweatMaterial = new THREE.MeshBasicMaterial({
      color: 0xbae6fd,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(dropGeometry, this.sweatMaterial);
    this.sweat = new THREE.InstancedMesh(dropGeometry, this.sweatMaterial, MAX_SWEAT);
    this.sweat.frustumCulled = false;
    this.sweat.visible = false;
    for (let i = 0; i < MAX_SWEAT; i++) {
      this.droplets.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
      this.sweat.setMatrixAt(i, this.dropletMatrix.makeScale(0, 0, 0));
    }
    this.sweat.instanceMatrix.needsUpdate = true;
    this.sweatLayer.add(this.sweat);
    this.object3D.add(this.sweatLayer);
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'paddle-hit': {
          // Flattened against the racket face, which is always the z plane.
          const strength = clamp(event.speed / this.maxSpeed, 0, 1);
          this.impactAxis.set(0, 0, 1);
          this.squash(0.34 + strength * 0.36);
          this.kickPupils(-event.offset.x * 9, -event.offset.y * 9 + 4);
          this.mouthPop = Math.max(this.mouthPop, 0.55 + strength * 0.5);
          this.wideEyes = 1;
          break;
        }
        case 'wall-bounce': {
          this.impactAxis.set(event.axis === 'x' ? 1 : 0, event.axis === 'y' ? 1 : 0, 0);
          this.squash(0.2 + event.intensity * 0.42);
          this.kickPupils(
            event.axis === 'x' ? event.intensity * 11 : 0,
            event.axis === 'y' ? event.intensity * 11 : 3,
          );
          this.mouthPop = Math.max(this.mouthPop, 0.4);
          // Only a genuinely violent carom is worth seeing stars over.
          if (event.intensity > 0.5 && this.speedRatio > 0.42) this.dizzy = 1.05;
          break;
        }
        case 'paddle-miss': {
          this.mouthPop = 1;
          this.kickPupils(0, -7);
          break;
        }
        case 'point-scored': {
          this.dizzy = Math.max(this.dizzy, 0.7);
          break;
        }
        case 'serve': {
          // Anticipation: crouch on the serve, the spring supplies the pop.
          this.impactAxis.set(0, 1, 0);
          this.squash(0.28);
          this.blinkPhase = 1;
          this.pupil.set(0, 0);
          this.pupilVelocity.set(0, 0);
          this.dizzy = 0;
          break;
        }
        case 'match-won': {
          this.cheer = 1.2;
          this.mouthPop = 1;
          break;
        }
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = clamp(ctx.dt, 1e-4, 1 / 30);
    const motion = ctx.reducedMotion ? 0.35 : 1;
    const fade = ctx.dimmed ? 0.4 : 1;
    const ball = ctx.ball;
    const ratio = ball.speedRatio;
    this.speedRatio = ratio;

    this.object3D.position.copy(ball.position);
    // The droplet layer cancels the root transform so sweat can be left behind
    // in world space without ever leaving this module's subtree.
    this.sweatLayer.position.set(-ball.position.x, -ball.position.y, -ball.position.z);

    const speed = ball.velocity.length();
    if (speed > 1e-3) this.travel.copy(ball.velocity).divideScalar(speed);

    this.updateBody(dt, ratio, motion);
    this.updateFace(ctx, dt, ratio, motion);
    this.updateSweat(ctx, dt, ratio);

    this.shellMaterial.emissiveIntensity = (1.05 + ratio * 1.7) * fade;
    this.coreMaterial.opacity = 1;
    this.haloMaterial.opacity = (0.36 + ratio * 0.42) * fade;
    this.halo.scale.setScalar(this.radius * (5.4 + ratio * 2.6));
    this.sweatMaterial.opacity = 0.85 * fade;
  }

  setQuality(level: QualityLevel): void {
    const detail = BALL_DETAIL[level];
    this.detail = detail;
    this.shell.geometry = detail.denseShell ? this.shellDense : this.shellCoarse;
    this.seam.visible = detail.seam;
    this.halo.visible = detail.halo;
    for (const glint of this.highlights) glint.visible = detail.highlights;
    this.sweat.count = detail.sweat;
    if (detail.sweat === 0) {
      this.sweat.visible = false;
      for (const drop of this.droplets) drop.life = 0;
      this.sweatAlive = 0;
    }
  }

  dispose(): void {
    this.sweat.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.highlights.length = 0;
    this.droplets.length = 0;
    for (const eye of this.eyes) eye.pivot.clear();
    this.face.clear();
    this.roller.clear();
    this.counter.clear();
    this.deform.clear();
    this.sweatLayer.clear();
    this.object3D.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private squash(amount: number): void {
    this.deformAmount = -clamp(amount, 0, 0.72);
    this.deformVelocity = 0;
    this.deformAxis.copy(this.impactAxis);
  }

  private kickPupils(x: number, y: number): void {
    this.pupilVelocity.x += x;
    this.pupilVelocity.y += y;
  }

  /** Builds a roll-free basis whose `+Z` points along `dir`, into `target`. */
  private orientTowards(dir: THREE.Vector3, target: THREE.Quaternion): void {
    const up = Math.abs(dir.y) > 0.94 ? FALLBACK_UP : WORLD_UP;
    this.axisX.crossVectors(up, dir).normalize();
    this.axisY.crossVectors(dir, this.axisX);
    this.faceBasis.makeBasis(this.axisX, this.axisY, dir);
    target.setFromRotationMatrix(this.faceBasis);
  }

  /** Squash, stretch and roll. */
  private updateBody(dt: number, ratio: number, motion: number): void {
    // The resting shape is a stretch proportional to speed; impacts yank the
    // spring negative and it springs back through that resting value.
    const rest = 0.32 * ratio * motion;
    this.deformVelocity +=
      (-BODY_STIFFNESS * (this.deformAmount - rest) - BODY_DAMPING * this.deformVelocity) * dt;
    this.deformAmount = clamp(this.deformAmount + this.deformVelocity * dt, -0.74, 0.95);

    // Ease the deformation axis back onto the direction of travel, keeping it in
    // the same hemisphere so the interpolation can never collapse to zero.
    this.scratchAxis.copy(this.travel);
    if (this.deformAxis.dot(this.scratchAxis) < 0) this.scratchAxis.negate();
    this.deformAxis.lerp(this.scratchAxis, 1 - Math.exp(-4 * dt));
    const axisLength = this.deformAxis.length();
    if (axisLength < 1e-3) this.deformAxis.copy(this.scratchAxis);
    else this.deformAxis.divideScalar(axisLength);

    const along = 1 + this.deformAmount;
    const across = 1 / Math.sqrt(Math.max(0.2, along));
    this.deform.quaternion.setFromUnitVectors(UNIT_Z, this.deformAxis);
    this.deform.scale.set(across, across, along);
    this.counter.quaternion.copy(this.deform.quaternion).invert();

    // Domain spin first — that is the authored rotation — plus a small tumble
    // proportional to speed so the seam always reads as rolling.
    const spin = this.spinMagnitude();
    if (spin > 1e-4) {
      this.scratchVector.copy(this.spinSource).divideScalar(spin);
      this.roller.rotateOnWorldAxis(this.scratchVector, spin * dt * motion);
    }
    this.scratchVector.crossVectors(this.travel, WORLD_UP);
    const tumble = this.scratchVector.length();
    if (tumble > 1e-3) {
      this.scratchVector.divideScalar(tumble);
      this.roller.rotateOnWorldAxis(this.scratchVector, ratio * 9 * dt * motion);
    }
  }

  /** Set by {@link update} so {@link updateBody} can read the spin without a copy. */
  private spinSource: THREE.Vector3 = new THREE.Vector3();

  private spinMagnitude(): number {
    return this.spinSource.length();
  }

  /** Eyes, pupils, mouth, and the face's place on the deformed surface. */
  private updateFace(ctx: FrameContext, dt: number, ratio: number, motion: number): void {
    this.mouthPop *= Math.exp(-5 * dt);
    this.wideEyes *= Math.exp(-4.5 * dt);
    this.cheer *= Math.exp(-2.2 * dt);
    if (this.dizzy > 0) this.dizzy = Math.max(0, this.dizzy - dt);

    // -- placement ----------------------------------------------------------
    this.orientTowards(this.travel, this.face.quaternion);
    if (this.dizzy > 0 || this.cheer > 0) {
      const roll = (Math.sin(ctx.time * 13) * this.dizzy * 0.22 + this.cheer * 0.18) * motion;
      this.rollQuaternion.setFromAxisAngle(UNIT_Z, roll);
      this.face.quaternion.multiply(this.rollQuaternion);
    }

    // Push the face out onto the deformed surface: rotate the anchor into the
    // deformation frame, scale it there, rotate it back.
    this.scratchVector.copy(this.travel).multiplyScalar(this.radius * 0.26);
    this.scratchVector.applyQuaternion(this.counter.quaternion);
    this.scratchVector.multiply(this.deform.scale);
    this.scratchVector.applyQuaternion(this.deform.quaternion);
    this.face.position.copy(this.scratchVector);
    this.face.scale.setScalar(clamp(1 - this.deformAmount * 0.26, 0.82, 1.32));

    // -- blink --------------------------------------------------------------
    this.blinkClock -= dt;
    if (this.blinkClock <= 0) {
      this.blinkPhase = 1;
      this.blinkClock = 2.4 + Math.random() * 3.6;
    }
    this.blinkPhase = Math.max(0, this.blinkPhase - dt * 7);
    const lid = 1 - Math.sin(this.blinkPhase * Math.PI) * 0.92;

    // -- pupils -------------------------------------------------------------
    this.pupilTarget.set(
      Math.sin(ctx.time * 9.5) * ratio * 0.18 * motion,
      (-0.14 - ratio * 0.24) * motion,
    );
    this.pupilVelocity.x +=
      (PUPIL_STIFFNESS * (this.pupilTarget.x - this.pupil.x) -
        PUPIL_DAMPING * this.pupilVelocity.x) *
      dt;
    this.pupilVelocity.y +=
      (PUPIL_STIFFNESS * (this.pupilTarget.y - this.pupil.y) -
        PUPIL_DAMPING * this.pupilVelocity.y) *
      dt;
    this.pupil.x = clamp(this.pupil.x + this.pupilVelocity.x * dt, -1, 1);
    this.pupil.y = clamp(this.pupil.y + this.pupilVelocity.y * dt, -1, 1);

    const eyeRadius = this.radius * 0.44;
    const dizzyNow = this.dizzy > 0;
    const whiteScale = 1 + this.wideEyes * 0.2;
    const pupilScale = (1 - this.wideEyes * 0.3) * 1;

    for (const eye of this.eyes) {
      eye.pivot.scale.set(1, lid, 1);
      eye.white.scale.setScalar(whiteScale);
      eye.pupil.visible = !dizzyNow;
      eye.spiral.visible = dizzyNow;
      if (dizzyNow) {
        eye.spiral.rotation.z += dt * 9 * motion;
        continue;
      }
      this.scratchVector
        .set(this.pupil.x * 0.62, this.pupil.y * 0.62, 1)
        .normalize()
        .multiplyScalar(eyeRadius * 0.66);
      eye.pupil.position.copy(this.scratchVector);
      eye.pupil.scale.set(pupilScale, pupilScale, 0.72 * pupilScale);
    }

    // -- mouth --------------------------------------------------------------
    // Calm at a stroll, a full screaming "O" at terminal velocity.
    const open = clamp(ratio ** 1.5 + this.mouthPop * 0.55 + this.cheer * 0.4, 0, 1.25);
    const width = this.radius * (0.3 + 0.22 * open);
    const height = this.radius * (0.05 + 0.46 * open);
    this.mouth.scale.set(width, height, 1);

    const showTongue = open > 0.45;
    this.tongue.visible = showTongue;
    if (showTongue) {
      const grow = clamp((open - 0.45) * 1.6, 0, 1);
      this.tongue.scale.setScalar(grow);
      this.tongue.quaternion.copy(this.mouth.quaternion);
      this.tongue.position.copy(this.mouthBase).addScaledVector(this.mouthDown, height * 0.42);
    }
  }

  private updateSweat(ctx: FrameContext, dt: number, ratio: number): void {
    const budget = this.detail.sweat;
    if (budget === 0) return;

    if (!ctx.reducedMotion && ratio > SWEAT_THRESHOLD && !ctx.dimmed) {
      this.sweatClock -= dt;
      if (this.sweatClock <= 0) {
        this.sweatClock = 0.05 + Math.random() * 0.06;
        this.spawnDroplet(ctx, ratio);
      }
    }

    if (this.sweatAlive === 0) {
      this.sweat.visible = false;
      return;
    }

    this.sweat.visible = true;
    let alive = 0;
    for (let i = 0; i < budget; i++) {
      const drop = this.droplets[i];
      if (drop === undefined) break;
      if (drop.life <= 0) {
        this.dropletMatrix.makeScale(0, 0, 0);
        this.sweat.setMatrixAt(i, this.dropletMatrix);
        continue;
      }
      alive++;
      drop.life -= dt;
      drop.vy -= 11 * dt;
      drop.x += drop.vx * dt;
      drop.y += drop.vy * dt;
      drop.z += drop.vz * dt;

      const shrink = clamp(drop.life * 2.6, 0, 1);
      const fall = Math.hypot(drop.vx, drop.vy, drop.vz);
      if (fall > 1e-3) {
        this.scratchVector.set(drop.vx / fall, drop.vy / fall, drop.vz / fall);
        this.dropletQuaternion.setFromUnitVectors(UNIT_Y, this.scratchVector);
      }
      this.scratchScale.set(shrink, shrink * (1 + Math.min(1.4, fall * 0.06)), shrink);
      this.scratchVector.set(drop.x, drop.y, drop.z);
      this.dropletMatrix.compose(this.scratchVector, this.dropletQuaternion, this.scratchScale);
      this.sweat.setMatrixAt(i, this.dropletMatrix);
    }
    this.sweatAlive = alive;
    this.sweat.instanceMatrix.needsUpdate = true;
  }

  private spawnDroplet(ctx: FrameContext, ratio: number): void {
    const budget = this.detail.sweat;
    for (let i = 0; i < budget; i++) {
      const drop = this.droplets[i];
      if (drop === undefined || drop.life > 0) continue;

      const angle = Math.random() * Math.PI * 2;
      const height = 0.35 + Math.random() * 0.6;
      const ring = Math.sqrt(Math.max(0, 1 - height * height));
      const nx = Math.cos(angle) * ring;
      const nz = Math.sin(angle) * ring;
      const origin = ctx.ball.position;
      drop.x = origin.x + nx * this.radius * 1.05;
      drop.y = origin.y + height * this.radius * 1.05;
      drop.z = origin.z + nz * this.radius * 1.05;
      drop.vx = nx * 2.4 - this.travel.x * ratio * 3;
      drop.vy = 3.2 + Math.random() * 1.8;
      drop.vz = nz * 2.4 - this.travel.z * ratio * 3;
      drop.life = 0.42 + Math.random() * 0.2;
      this.sweatAlive++;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createBallCharacter = (options: { rules: MatchRules }): ReactiveModule =>
  new BallCharacter(options.rules);
