import * as THREE from 'three';

import type { Arena, Side } from '../../../domain/arena';
import { paddlePlaneZ, sideSign } from '../../../domain/arena';
import type { DomainEvent } from '../../../domain/events';
import type { MatchRules } from '../../../domain/rules';
import type { QualityLevel } from '../../../application/ports';
import type { CharacterModule, Emote, FrameContext } from './contract';
import type {
  ArmParts,
  BaseParts,
  HeadParts,
  RobotMaterials,
  RobotSpec,
  RobotVariant,
  TorsoParts,
} from './robot-parts';
import {
  Disposal,
  ROBOT_SPECS,
  buildArm,
  buildBase,
  buildHand,
  buildHead,
  buildTorso,
  createRobotMaterials,
  headPivotY,
  lowerBoneLength,
} from './robot-parts';
import { createRadialGlowTexture } from '../textures';

/**
 * The two duelling robots.
 *
 * A robot is not a mesh, it is a performance. The parts library provides the rig
 * — pivots for the head, the jaw, the antenna, both arms and every eyelid — and
 * this module drives it: it reaches for the paddle with two-bone inverse
 * kinematics, tracks the ball with its pupils, and plays poses on top.
 *
 * All animation is expressed as a small set of scalar channels eased towards a
 * target rather than as keyframes. Blending then costs nothing (an emote simply
 * moves the targets) and the whole update stays allocation-free.
 */

export interface RobotOptions {
  readonly side: Side;
  readonly variant: RobotVariant;
  readonly arena: Arena;
  readonly rules: MatchRules;
}

/** Animation channels. Every emote is a set of targets over these. */
interface Pose {
  /** Head nod in radians; positive looks down. */
  headPitch: number;
  /** Torso pitch in radians; positive folds forward. */
  lean: number;
  /** Jaw opening, 0 shut to 1 wide. */
  jaw: number;
  /** Eyelid opening, 0 shut to 1 normal; above 1 the eyes go saucer-wide. */
  lids: number;
  /** Blends the eyeball towards the happy arc, 0 to 1. */
  joy: number;
  /** Vertical offset of the whole rig, in world units. */
  hop: number;
  /** Amplitude of the body's wobble around Y, in radians. */
  spin: number;
  /** Multiplier on the power core's emissive intensity. */
  core: number;
  /** Belly plate droop, 0 to 1. */
  sag: number;
  /** How far the arm commits towards the paddle: 0 guard, 1 full extension. */
  reach: number;
}

const restPose = (): Pose => ({
  headPitch: 0,
  lean: 0,
  jaw: 0,
  lids: 1,
  joy: 0,
  hop: 0,
  spin: 0,
  core: 1,
  sag: 0,
  reach: 0.5,
});

/** Target pose per emote; omitted channels fall back to the rest pose. */
const EMOTE_POSES: Readonly<Record<Emote, Partial<Pose>>> = {
  idle: {},
  ready: { lean: 0.16, lids: 0.72, reach: 0.62, core: 1.15 },
  swing: { lean: 0.3, reach: 1, jaw: 0.35, core: 1.6 },
  flinch: { lean: -0.34, headPitch: -0.35, jaw: 0.9, lids: 1.6, reach: 0.15, core: 0.65 },
  celebrate: { hop: 0.55, jaw: 0.7, joy: 1, lean: -0.12, core: 1.9, reach: 0.85 },
  defeat: { lean: 0.5, headPitch: 0.62, lids: 0.28, sag: 1, core: 0.35, hop: -0.35, reach: 0.1 },
  taunt: { lean: 0.24, jaw: 0.45, joy: 0.6, spin: 0.5, core: 1.4 },
  dizzy: { headPitch: -0.15, jaw: 0.55, lids: 1.3, spin: 0.9, core: 0.8, reach: 0.25 },
};

/** Rate at which each channel chases its target, per second. */
const EASE = 9;

const POSE_KEYS: readonly (keyof Pose)[] = [
  'headPitch',
  'lean',
  'jaw',
  'lids',
  'joy',
  'hop',
  'spin',
  'core',
  'sag',
  'reach',
];

const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

class Robot implements CharacterModule {
  readonly object3D: THREE.Group;
  readonly racketAnchor: THREE.Object3D;

  private readonly side: Side;
  private readonly spec: RobotSpec;
  private readonly disposal = new Disposal();
  private readonly materials: RobotMaterials;

  private readonly body: THREE.Group;
  private readonly torso: TorsoParts;
  private readonly head: HeadParts;
  private readonly base: BaseParts;
  private readonly armLeft: ArmParts;
  private readonly armRight: ArmParts;

  private readonly pose = restPose();
  private readonly target = restPose();
  private readonly rest = restPose();
  private emote: Emote = 'idle';

  /** Extra impulse a swing adds on top of the pose, decaying to zero. */
  private swingImpulse = 0;
  private blinkTimer = 1.5;
  private blink = 0;
  private coreFlash = 0;

  // Scratch objects: this runs every frame and must not allocate.
  private readonly ballLocal = new THREE.Vector3();
  private readonly reachTarget = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();

  constructor(options: RobotOptions) {
    this.side = options.side;
    const spec = ROBOT_SPECS[options.variant];
    this.spec = spec;

    const glowTexture = this.disposal.track(createRadialGlowTexture(128, 2.6));
    this.materials = createRobotMaterials(options.side, glowTexture, this.disposal);

    this.object3D = new THREE.Group();
    this.body = new THREE.Group();
    this.object3D.add(this.body);

    this.torso = buildTorso(spec, this.materials, options.rules, this.disposal);
    this.head = buildHead(spec, this.materials, this.disposal);
    this.base = buildBase(spec, this.materials, this.disposal);
    this.head.group.position.y = headPivotY(spec);

    this.armLeft = buildArm(spec, this.materials, this.disposal, -1);
    this.armRight = buildArm(spec, this.materials, this.disposal, 1);

    this.body.add(this.torso.group, this.head.group, this.base.group);
    this.body.add(this.armLeft.shoulder, this.armRight.shoulder);

    this.armRight.wrist.add(buildHand(this.materials, this.disposal, -spec.forearm * 0.5));

    // The racket module parents itself here, so the hand really holds it.
    this.racketAnchor = new THREE.Object3D();
    this.racketAnchor.position.y = -spec.handle * 0.5;
    this.armRight.wrist.add(this.racketAnchor);

    // Stand behind the paddle plane, facing down the tunnel, so the robot frames
    // the action instead of hiding the ball.
    const sign = sideSign(options.side);
    this.object3D.position.set(
      0,
      -options.arena.halfHeight + 1.1,
      sign * (paddlePlaneZ(options.arena) + 2.6),
    );
    this.object3D.rotation.y = sign > 0 ? Math.PI : 0;
  }

  play(emote: Emote): void {
    this.emote = emote;
    const preset = EMOTE_POSES[emote];
    for (const key of POSE_KEYS) {
      this.target[key] = preset[key] ?? this.rest[key];
    }
    if (emote === 'swing') this.swingImpulse = 1;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    // Emotes belong to the director; the core flash is the one thing the robot
    // decides for itself, because it is tied to its own racket making contact.
    for (const event of events) {
      if (event.type === 'paddle-hit' && event.side === this.side) this.coreFlash = 1;
    }
  }

  update(ctx: FrameContext): void {
    const dt = Math.min(ctx.dt, 0.1);
    const motion = ctx.reducedMotion ? 0.25 : 1;
    const paddle = ctx.paddles[this.side];
    const pose = this.pose;
    const blend = approach(EASE, dt);

    for (const key of POSE_KEYS) {
      pose[key] += (this.target[key] - pose[key]) * blend;
    }

    this.swingImpulse = Math.max(0, this.swingImpulse - dt * 3.4);
    this.coreFlash = Math.max(0, this.coreFlash - dt * 2.6);

    // --- body: follow the paddle and lean into the movement -----------------
    const idle = Math.sin(ctx.time * 2.1) * 0.05 * motion;
    this.body.position.x += (paddle.position.x - this.body.position.x) * approach(11, dt);
    this.body.position.y = pose.hop * motion + idle;
    this.body.rotation.z = THREE.MathUtils.clamp(-paddle.velocity.x * 0.012, -0.3, 0.3) * motion;
    this.body.rotation.x = pose.lean * motion;
    this.body.rotation.y = pose.spin * Math.sin(ctx.time * 7) * motion;

    // --- hover base ---------------------------------------------------------
    this.base.gyro.rotation.y += dt * (1.6 + Math.abs(paddle.velocity.x) * 0.05) * motion;
    this.base.thrust.scale.setScalar(0.9 + Math.sin(ctx.time * 9) * 0.08 * motion);

    // --- head tracks the ball ----------------------------------------------
    this.ballLocal.copy(ctx.ball.position);
    this.object3D.worldToLocal(this.ballLocal);
    const yaw = Math.atan2(this.ballLocal.x - this.body.position.x, Math.max(0.5, this.ballLocal.z));
    this.head.group.rotation.y = THREE.MathUtils.clamp(yaw, -0.7, 0.7) * motion;
    this.head.group.rotation.x = pose.headPitch * motion;
    this.head.jaw.rotation.x = pose.jaw * 0.5;
    this.head.antenna.rotation.z = Math.sin(ctx.time * 3.3) * 0.12 * motion;
    this.head.bulb.visible = Math.sin(ctx.time * 4.5) > -0.2;

    this.updateEyes(dt, yaw, motion, pose);

    // --- torso: the core pulses faster as the rally heats up ----------------
    const tension = Math.min(1, ctx.rally / 14 + ctx.ball.speedRatio * 0.5);
    const pulse = 1 + Math.sin(ctx.time * (4 + tension * 9)) * 0.18;
    this.materials.core.emissiveIntensity = pose.core * pulse * (1 + tension) + this.coreFlash * 2.5;
    this.torso.coreHalo.scale.setScalar(1 + tension * 0.5 + this.coreFlash);
    this.torso.sagPlate.rotation.x = pose.sag * 0.5;
    this.torso.pauldronLeft.rotation.z = pose.sag * 0.22;
    this.torso.pauldronRight.rotation.z = -pose.sag * 0.22;

    this.updateArm(dt, ctx, motion);
  }

  private updateEyes(dt: number, yaw: number, motion: number, pose: Pose): void {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = 2.2 + Math.random() * 3.4;
      this.blink = 1;
    }
    this.blink = Math.max(0, this.blink - dt * 7);

    const open = THREE.MathUtils.clamp(pose.lids - this.blink, 0, 1.6);
    const closed = 1 - Math.min(1, open);
    for (const eye of this.head.eyes) {
      eye.pupilPivot.rotation.y = THREE.MathUtils.clamp(yaw * 0.6, -0.5, 0.5);
      eye.pupilPivot.rotation.x = THREE.MathUtils.clamp(-this.ballLocal.y * 0.04, -0.4, 0.4);
      // Spiralling pupils are the cheapest possible cartoon signal for "dazed".
      if (this.emote === 'dizzy') eye.pupilPivot.rotation.z += dt * 9 * motion;
      else eye.pupilPivot.rotation.z = 0;
      eye.lidTop.rotation.x = closed * 1.2;
      eye.lidBottom.rotation.x = -closed * 0.9;
      eye.ball.visible = pose.joy < 0.5;
      eye.arc.visible = pose.joy >= 0.5;
      eye.ball.scale.setScalar(1 + Math.max(0, open - 1) * 0.6);
    }
  }

  /**
   * Two-bone inverse kinematics, so the racket actually meets the paddle.
   *
   * The paddle *is* the hitbox, so a racket that merely floats near it reads as
   * broken. This is the standard law-of-cosines solve: clamp the target inside
   * the arm's reach, aim the shoulder at it, then derive the elbow angle from
   * the two bone lengths.
   */
  private updateArm(dt: number, ctx: FrameContext, motion: number): void {
    const paddle = ctx.paddles[this.side];
    const arm = this.armRight;
    const upper = this.spec.upperArm;
    const lower = lowerBoneLength(this.spec);

    // Where the racket should be, expressed in the body's local space.
    this.reachTarget.set(
      paddle.position.x - this.body.position.x,
      paddle.position.y - this.object3D.position.y,
      Math.abs(paddle.position.z - this.object3D.position.z),
    );
    // `reach` pulls the guard pose back towards the chest between rallies.
    const commit = 0.35 + this.pose.reach * 0.65 + this.swingImpulse * 0.25;
    this.reachTarget.multiplyScalar(commit);
    this.toTarget.copy(this.reachTarget).sub(arm.shoulder.position);

    const distance = THREE.MathUtils.clamp(this.toTarget.length(), 1e-3, (upper + lower) * 0.999);
    const aim = motion < 1 ? 1 : approach(14, dt);

    const yaw = Math.atan2(this.toTarget.x, this.toTarget.z);
    const pitch = Math.atan2(this.toTarget.y, Math.hypot(this.toTarget.x, this.toTarget.z));
    arm.shoulder.rotation.y += (yaw - arm.shoulder.rotation.y) * aim;
    arm.shoulder.rotation.x += (-pitch - Math.PI / 2 - arm.shoulder.rotation.x) * aim;

    const cosine = (upper * upper + lower * lower - distance * distance) / (2 * upper * lower);
    const elbow = Math.PI - Math.acos(THREE.MathUtils.clamp(cosine, -1, 1));
    arm.elbow.rotation.x += (elbow - arm.elbow.rotation.x) * aim;

    // The free arm counterbalances, which is what stops the pose looking rigid.
    this.armLeft.shoulder.rotation.x =
      -0.5 + Math.sin(ctx.time * 2.4) * 0.12 * motion - this.pose.lean * 0.4;
    this.armLeft.elbow.rotation.x = 0.7 + this.pose.joy * 0.8;
  }

  setQuality(level: QualityLevel): void {
    const detailed = level !== 'low';
    this.torso.rivets.visible = detailed;
    this.torso.seams.visible = detailed;
    this.torso.coreHalo.visible = detailed;
    this.base.gyroBlocks.visible = detailed;
  }

  dispose(): void {
    this.object3D.removeFromParent();
    this.disposal.releaseAll();
  }
}

export const createRobot = (options: RobotOptions): CharacterModule => new Robot(options);
