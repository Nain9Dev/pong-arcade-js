import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { Arena } from '../../../domain/arena';
import { createRng } from '../../../domain/rng';
import type { QualityLevel } from '../../../application/ports';
import { createRadialGlowTexture } from '../textures';
import type { FrameContext, SceneModule } from './contract';
import { mergeAndDispose } from './merge';

/**
 * The broadcast drones: two or three little quadcopters filming the match from
 * inside the arena.
 *
 * They exist for one gag — the camera crew is *in the way*. Each drone drifts on
 * a smooth sine-sum path near the ceiling with its gimbal stubbornly locked onto
 * the ball, and when the ball comes at it, it panics: it bails upwards, tips
 * away, its rotors scream, and the gimbal never once stops filming.
 *
 * Everything is shared: one hull geometry, one rotor geometry, one rotor
 * texture. Only the blinking status light gets per-drone materials, because the
 * blink is what makes three identical props read as three different characters.
 */

const DRONE_COUNT = 3;

/** How many drones each quality level flies. `low` removes them entirely. */
const DRONES_BY_QUALITY: Readonly<Record<QualityLevel, number>> = {
  low: 0,
  medium: 2,
  high: 3,
};

/** Arm span, from the hull centre to a rotor hub. */
const ARM_REACH = 0.27;
const ROTOR_RADIUS = 0.19;

/** Below this distance to the ball a drone starts bailing out. */
const PANIC_RADIUS = 4.2;
/** Seconds of ball travel used to see the impact coming. */
const PANIC_LOOKAHEAD = 0.16;

const LED_COLOURS: readonly number[] = [0xff3b30, 0x22d3ee, 0xfbbf24];

const scratchTarget = new THREE.Vector3();
const scratchThreat = new THREE.Vector3();

const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/**
 * A rotor frozen mid-blur: concentric arcs of light with a bright hub and a
 * faint tip ring. Painted once, shared by all twelve rotors.
 */
const createRotorTexture = (size = 128): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable for rotor texture');

  const c = size / 2;
  const disc = ctx.createRadialGradient(c, c, size * 0.03, c, c, size * 0.5);
  disc.addColorStop(0, 'rgba(214,236,255,0.60)');
  disc.addColorStop(0.35, 'rgba(150,190,255,0.10)');
  disc.addColorStop(0.88, 'rgba(190,222,255,0.26)');
  disc.addColorStop(1, 'rgba(150,190,255,0)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = 'round';
  for (let i = 0; i < 24; i++) {
    const start = (i / 24) * Math.PI * 2;
    const radius = size * (0.16 + 0.3 * ((i % 7) / 7));
    ctx.strokeStyle = `rgba(224,242,255,${0.03 + 0.05 * ((i % 5) / 5)})`;
    ctx.lineWidth = size * 0.018;
    ctx.beginPath();
    ctx.arc(c, c, radius, start, start + 1.15);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(236,248,255,0.85)';
  ctx.beginPath();
  ctx.arc(c, c, size * 0.035, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

/** Chassis, arms, motor pods and skids, merged into one shared geometry. */
const buildHullGeometry = (): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];

  const chassis = new RoundedBoxGeometry(0.58, 0.19, 0.44, 1, 0.07);
  parts.push(chassis);

  const canopy = new RoundedBoxGeometry(0.3, 0.13, 0.24, 1, 0.05);
  canopy.translate(0, 0.11, -0.04);
  parts.push(canopy);

  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      const arm = new THREE.BoxGeometry(ARM_REACH * 1.35, 0.05, 0.07);
      arm.rotateY(x * z > 0 ? -Math.PI / 4 : Math.PI / 4);
      arm.translate((x * ARM_REACH) / 2, 0.01, (z * ARM_REACH) / 2);
      parts.push(arm);

      const pod = new THREE.CylinderGeometry(0.055, 0.072, 0.08, 6);
      pod.translate(x * ARM_REACH, 0.03, z * ARM_REACH);
      parts.push(pod);
    }
  }

  for (const x of [-1, 1]) {
    const skid = new THREE.BoxGeometry(0.045, 0.045, 0.42);
    skid.translate(x * 0.17, -0.16, 0);
    parts.push(skid);

    const leg = new THREE.BoxGeometry(0.04, 0.12, 0.04);
    leg.translate(x * 0.17, -0.1, 0);
    parts.push(leg);
  }

  const merged = mergeAndDispose(parts);
  merged.deleteAttribute('uv');
  return merged;
};

/** Yoke plus camera barrel. Built facing `+Z`, which is where `lookAt` aims it. */
const buildGimbalGeometry = (): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];

  for (const x of [-1, 1]) {
    const cheek = new THREE.BoxGeometry(0.03, 0.13, 0.1);
    cheek.translate(x * 0.1, 0.02, -0.02);
    parts.push(cheek);
  }

  const yoke = new THREE.BoxGeometry(0.23, 0.03, 0.09);
  yoke.translate(0, 0.08, -0.02);
  parts.push(yoke);

  const barrel = new THREE.CylinderGeometry(0.068, 0.076, 0.17, 7);
  barrel.rotateX(Math.PI / 2);
  parts.push(barrel);

  const merged = mergeAndDispose(parts);
  merged.deleteAttribute('uv');
  return merged;
};

interface Drone {
  readonly group: THREE.Group;
  readonly gimbal: THREE.Group;
  readonly rotors: readonly THREE.Mesh[];
  readonly led: THREE.Mesh;
  readonly halo: THREE.Sprite;
  readonly ledMaterial: THREE.MeshBasicMaterial;
  readonly haloMaterial: THREE.SpriteMaterial;
  /** Five phase offsets that make each drone's drift path its own. */
  readonly phase: Float32Array;
  readonly speed: number;
  readonly blinkRate: number;
  dodge: number;
  spin: number;
  roll: number;
  pitch: number;
  previousX: number;
  previousZ: number;
}

export const createDrones = (options: { arena: Arena }): SceneModule => {
  const { arena } = options;
  const root = new THREE.Group();
  root.name = 'drones';
  const disposables: { dispose(): void }[] = [];
  const rng = createRng(0x0dc0ffee);

  const hullGeometry = buildHullGeometry();
  const gimbalGeometry = buildGimbalGeometry();
  const rotorGeometry = new THREE.CircleGeometry(ROTOR_RADIUS, 10);
  rotorGeometry.rotateX(-Math.PI / 2);
  const lensGeometry = new THREE.CircleGeometry(0.05, 8);
  const ledGeometry = new THREE.SphereGeometry(0.035, 5, 3);
  disposables.push(hullGeometry, gimbalGeometry, rotorGeometry, lensGeometry, ledGeometry);

  const rotorTexture = createRotorTexture();
  const glowTexture = createRadialGlowTexture(96, 2.6);
  disposables.push(rotorTexture, glowTexture);

  const hullMaterial = new THREE.MeshLambertMaterial({
    color: 0x1a2338,
    emissive: 0x0a1226,
    emissiveIntensity: 1,
  });
  const gimbalMaterial = new THREE.MeshLambertMaterial({
    color: 0x2a3450,
    emissive: 0x0c1730,
  });
  const rotorMaterial = new THREE.MeshBasicMaterial({
    map: rotorTexture,
    color: 0x9fd4ff,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const lensMaterial = new THREE.MeshBasicMaterial({
    color: 0x8ee7ff,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  disposables.push(hullMaterial, gimbalMaterial, rotorMaterial, lensMaterial);

  const drones: Drone[] = [];

  for (let i = 0; i < DRONE_COUNT; i++) {
    const group = new THREE.Group();
    group.name = `drone-${i}`;

    group.add(new THREE.Mesh(hullGeometry, hullMaterial));

    const rotors: THREE.Mesh[] = [];
    for (const x of [-1, 1]) {
      for (const z of [-1, 1]) {
        const rotor = new THREE.Mesh(rotorGeometry, rotorMaterial);
        rotor.position.set(x * ARM_REACH, 0.085, z * ARM_REACH);
        rotor.renderOrder = 2;
        group.add(rotor);
        rotors.push(rotor);
      }
    }

    const gimbal = new THREE.Group();
    gimbal.position.set(0, -0.16, 0.06);
    gimbal.add(new THREE.Mesh(gimbalGeometry, gimbalMaterial));
    const lens = new THREE.Mesh(lensGeometry, lensMaterial);
    lens.position.z = 0.09;
    lens.renderOrder = 3;
    gimbal.add(lens);
    group.add(gimbal);

    const colour = LED_COLOURS[i % LED_COLOURS.length] ?? 0xff3b30;
    const ledMaterial = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const haloMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: colour,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    disposables.push(ledMaterial, haloMaterial);

    const led = new THREE.Mesh(ledGeometry, ledMaterial);
    led.position.set(0, 0.14, -0.2);
    led.renderOrder = 3;
    group.add(led);

    const halo = new THREE.Sprite(haloMaterial);
    halo.position.copy(led.position);
    halo.scale.setScalar(0.4);
    halo.renderOrder = 2;
    group.add(halo);

    const phase = new Float32Array(5);
    for (let p = 0; p < phase.length; p++) phase[p] = rng.range(0, Math.PI * 2);

    drones.push({
      group,
      gimbal,
      rotors,
      led,
      halo,
      ledMaterial,
      haloMaterial,
      phase,
      speed: rng.range(0.82, 1.24),
      blinkRate: rng.range(0.55, 0.95),
      dodge: 0,
      spin: rng.range(0, Math.PI * 2),
      roll: 0,
      pitch: 0,
      previousX: 0,
      previousZ: 0,
    });
    root.add(group);
  }

  let active = DRONES_BY_QUALITY.high;

  const update = (ctx: FrameContext): void => {
    if (active === 0) return;

    const { halfWidth, halfHeight, halfDepth } = arena;
    const dt = Math.max(ctx.dt, 1e-4);
    const motion = ctx.reducedMotion ? 0.35 : 1;
    const ball = ctx.ball.position;

    // Where the ball will be in a moment: a drone that only reacts to where the
    // ball *is* never gets out of the way in time, which reads as a bug rather
    // than as a joke.
    scratchTarget.copy(ball).addScaledVector(ctx.ball.velocity, PANIC_LOOKAHEAD * motion);

    for (let i = 0; i < active; i++) {
      const drone = drones[i];
      if (drone === undefined) continue;

      const t = ctx.time * drone.speed * motion;
      const p = drone.phase;
      const p0 = p[0] ?? 0;
      const p1 = p[1] ?? 0;
      const p2 = p[2] ?? 0;
      const p3 = p[3] ?? 0;
      const p4 = p[4] ?? 0;

      let x =
        halfWidth * 0.54 * Math.sin(t * 0.53 + p0) + halfWidth * 0.2 * Math.sin(t * 1.27 + p1);
      let y = halfHeight * (0.5 + 0.16 * Math.sin(t * 0.71 + p2));
      let z =
        halfDepth * 0.66 * Math.sin(t * 0.29 + p3) + halfDepth * 0.13 * Math.sin(t * 0.91 + p4);

      scratchThreat.set(x, y, z);
      const threat = THREE.MathUtils.clamp(
        1 -
          Math.min(scratchThreat.distanceTo(ball), scratchThreat.distanceTo(scratchTarget)) /
            PANIC_RADIUS,
        0,
        1,
      );
      // Snap up, settle down: panic is instant, dignity takes a while.
      const target = threat * threat;
      drone.dodge += (target - drone.dodge) * approach(target > drone.dodge ? 18 : 2, dt);

      const escape = drone.dodge * motion;
      const away = Math.sign(x - ball.x) || 1;
      y += escape * halfHeight * 0.42;
      x += away * escape * halfWidth * 0.12;

      const margin = ARM_REACH + ROTOR_RADIUS + 0.2;
      x = THREE.MathUtils.clamp(x, -halfWidth + margin, halfWidth - margin);
      y = THREE.MathUtils.clamp(y, -halfHeight * 0.15, halfHeight - margin);
      z = THREE.MathUtils.clamp(z, -halfDepth * 0.82, halfDepth * 0.82);

      const vx = (x - drone.previousX) / dt;
      const vz = (z - drone.previousZ) / dt;
      drone.previousX = x;
      drone.previousZ = z;
      drone.group.position.set(x, y, z);

      // Lean into the turn, then over-lean while bailing out.
      const targetRoll =
        THREE.MathUtils.clamp(-vx * 0.05, -0.5, 0.5) - away * escape * 0.45;
      const targetPitch = THREE.MathUtils.clamp(vz * 0.05, -0.5, 0.5) + escape * 0.3;
      drone.roll += (targetRoll - drone.roll) * approach(9, dt);
      drone.pitch += (targetPitch - drone.pitch) * approach(9, dt);
      drone.group.rotation.set(drone.pitch * motion, 0, drone.roll * motion);

      // The gimbal is the joke: whatever the airframe is doing, it keeps filming.
      drone.gimbal.lookAt(ball);

      drone.spin += (32 + escape * 95) * dt;
      for (let r = 0; r < drone.rotors.length; r++) {
        const rotor = drone.rotors[r];
        if (rotor === undefined) continue;
        rotor.rotation.y = r % 2 === 0 ? drone.spin : -drone.spin;
      }

      // Status light: a short bright pulse on a long cycle, per drone.
      const cycle = (ctx.time * drone.blinkRate + p0) % 1;
      const pulse = Math.max(0, 1 - cycle / 0.2);
      drone.led.scale.setScalar(0.65 + pulse * 0.85);
      drone.ledMaterial.opacity = 0.22 + pulse * 0.78;
      drone.halo.scale.setScalar(0.28 + pulse * 0.5);
      drone.haloMaterial.opacity = (0.1 + pulse * 0.55) * (ctx.dimmed ? 0.35 : 1);
    }
  };

  const setQuality = (level: QualityLevel): void => {
    active = DRONES_BY_QUALITY[level];
    root.visible = active > 0;
    for (let i = 0; i < drones.length; i++) {
      const drone = drones[i];
      if (drone !== undefined) drone.group.visible = i < active;
    }
  };

  const dispose = (): void => {
    root.clear();
    for (const item of disposables) item.dispose();
    disposables.length = 0;
    drones.length = 0;
  };

  return { object3D: root, update, setQuality, dispose };
};
