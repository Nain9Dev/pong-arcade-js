import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { Arena } from '../../../domain/arena';
import { goalPlaneZ } from '../../../domain/arena';
import type { DomainEvent } from '../../../domain/events';
import { createRng } from '../../../domain/rng';
import type { QualityLevel } from '../../../application/ports';
import { SIDE_THEME } from '../palette';
import type { FrameContext, ReactiveModule } from './contract';

/**
 * The crowd: tiered terraces down both long sides of the arena, packed with a
 * few hundred small spectators that bob, ripple, jump and run a Mexican wave.
 *
 * ## Why the animation lives in the vertex shader
 *
 * The obvious implementation rewrites `instanceMatrix` every frame. For 700
 * spectators that is 700 matrix compositions plus a full re-upload of a 45 KB
 * buffer, every frame, forever — on the CPU, on the main thread, competing with
 * the physics step. The cheaper and much more expressive option is to upload the
 * seating chart *once* and express every reaction as a handful of scalar
 * uniforms: the GPU then evaluates the bob, the ripple, the staggered jump, the
 * wave and the arm raise per vertex, in parallel, for free.
 *
 * So `update()` writes about ten floats per frame and touches no instance data
 * at all. Reducing quality reduces `InstancedMesh.count`, which is the only knob
 * that actually costs anything.
 *
 * ## Scene layout
 *
 * Everything is derived from the {@link Arena} it is built for. The terraces sit
 * just outside the `x = ±halfWidth` walls and rake upwards and outwards, so the
 * crowd never intrudes into the play volume and never occludes the ball.
 */

// --------------------------------------------------------------------------
// Model constants — the little spectator, in local units (feet at y = 0).
// --------------------------------------------------------------------------

const PART_BODY = 0;
const PART_HEAD = 1;
const PART_ARM = 2;
const PART_FLAG = 3;

const SHOULDER_X = 0.3;
const SHOULDER_Y = 0.72;
const ARM_LENGTH = 0.34;
const HAND_X = SHOULDER_X;
const HAND_Y = SHOULDER_Y - ARM_LENGTH;
/** Height of the tallest vertex, used to normalise the baked shading ramp. */
const MODEL_HEIGHT = 1.2;

/** Terrace steps per side. Static geometry, so this never changes with quality. */
const TIERS = 5;

/** Spectators built at mount. `setQuality` only ever renders a prefix of these. */
const SEAT_TARGET = 720;

/** Share of the built seats each quality level actually draws. */
const OCCUPANCY: Readonly<Record<QualityLevel, number>> = {
  low: 0.22,
  medium: 0.62,
  high: 1,
};

/** Fraction of spectators waving a little pennant. */
const PENNANT_SHARE = 0.16;

/** Dim shirt tones. Nothing here is allowed to out-shout the ball. */
const SHIRT_TONES: readonly number[] = [
  0x2b3358, 0x3a4166, 0x1f5f78, 0x6d3a51, 0x474d70, 0x2f5d5a, 0x6a4a3a, 0x30416b,
  0x545a7a, 0x243a52,
];

/** Heads and bare arms: a few skin tones plus the odd helmet. */
const HEAD_TONES: readonly number[] = [0x8a6a52, 0xa9805f, 0x5d4b3a, 0x6f7a92, 0x3f4658];

/** Global brightness clamp applied to every spectator colour. */
const CROWD_DIMMING = 0.5;

const LIGHT_DIR = new THREE.Vector3(0.35, 1, 0.45).normalize();

const scratchColor = new THREE.Color();
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchScale = new THREE.Vector3();

/** Frame-rate independent exponential approach factor. */
const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

const f = (value: number): string => value.toFixed(4);

// --------------------------------------------------------------------------
// Shader
// --------------------------------------------------------------------------

/**
 * Injected after `#include <common>`.
 *
 * `instanceMatrix` and `instanceColor` are declared for us by the renderer's
 * program prefix; the seat's world position is read straight out of the matrix
 * translation column, which is why no per-instance position attribute exists.
 */
const CROWD_VERTEX_HEAD = /* glsl */ `
attribute float aPart;
attribute float aPhase;
attribute float aEnergy;
attribute float aFlag;
attribute vec3 aHead;

uniform float uTime;
uniform float uMotion;
uniform float uDim;
uniform float uCheer;
uniform float uPennants;
uniform vec2 uSlump;
uniform vec2 uFlash;
uniform vec4 uJump;
uniform vec4 uRipple;
uniform vec4 uWave;
uniform vec3 uNearTint;
uniform vec3 uFarTint;
`;

/** Replaces `#include <begin_vertex>` — the whole performance happens here. */
const CROWD_VERTEX_BODY = /* glsl */ `
  float seatZ = instanceMatrix[3].z;
  float seatX = instanceMatrix[3].x;
  float energy = aEnergy;
  float motion = uMotion;

  // Idle: everyone breathes on their own phase, nobody is ever perfectly still.
  float bob = sin(uTime * (1.5 + energy * 0.6) + aPhase) * 0.048 * energy;
  float sway = sin(uTime * 0.83 + aPhase * 1.7) * 0.022;

  // paddle-hit: a bump of movement runs outwards along the terraces from the
  // impact, biased towards the stand on the side the ball was struck.
  float rippleDist = abs(seatZ - uRipple.z) + abs(seatX - uRipple.w) * 0.28;
  float rippleT = uTime - uRipple.y - rippleDist * 0.028;
  float rippleG = max(rippleT, 0.0);
  float ripple = uRipple.x * exp(-rippleG * rippleG * 24.0) * step(0.0, rippleT) * energy;

  // point-scored: a staggered jump starting at the scorer's end, its height
  // falling off with distance so the far terraces barely lift.
  float jumpDist = abs(seatZ - uJump.z);
  float jumpT = uTime - uJump.y - jumpDist * 0.017 - aPhase * 0.018;
  float jumpG = max(jumpT, 0.0);
  float jumpFall = 1.0 - clamp(jumpDist / uJump.w, 0.0, 0.82);
  float jump = uJump.x * jumpFall * exp(-jumpG * 1.9) * step(0.0, jumpT)
    * abs(sin(jumpG * 8.5)) * energy;

  // match-won: sustained hopping, plus a wave that laps the arena end to end.
  float hop = uCheer * abs(sin(uTime * (6.4 + energy * 1.2) + aPhase)) * 0.30 * energy;
  float sweep = fract((uTime - uWave.y) * uWave.z);
  float waveZ = mix(-uWave.w, uWave.w, sweep);
  float waveD = (seatZ - waveZ) / max(uWave.w * 0.14, 0.001);
  float wave = uWave.x * exp(-waveD * waveD) * energy;

  // paddle-miss: a short collective slump, sagging out of phase per spectator.
  float slumpT = uTime - uSlump.y;
  float slump = uSlump.x * exp(-max(slumpT, 0.0) * 1.4) * step(0.0, slumpT)
    * (0.6 + 0.4 * sin(uTime * 1.3 + aPhase));

  float rise = (bob + ripple + jump + hop + wave) * motion;
  float sag = slump * 0.20 * motion;
  float lift = rise - sag;

  // Squash and stretch about the feet: they stretch on the way up and flatten
  // when they slump, which is what sells the weight of a few hundred bodies.
  float stretch = 1.0 + rise * 0.55 - sag * 1.05;
  float fat = 1.0 - (stretch - 1.0) * 0.45;

  float excite = clamp(
    (jump * 2.4 + wave * 2.6 + hop * 2.2 + ripple * 1.8 + uCheer * 0.35) * motion,
    0.0,
    1.0
  );

  float isArm = step(1.5, aPart);
  float isFlag = step(2.5, aPart);
  float show = aFlag * uPennants;

  // A spectator with no pennant collapses its quad onto the hand: eight
  // degenerate vertices cost nothing and keep the crowd to a single draw call.
  vec3 src = mix(position, vec3(${f(HAND_X)}, ${f(HAND_Y)}, 0.0), isFlag * (1.0 - show));

  // Arms (and whatever the hand is holding) swing up and out from the shoulder.
  float armSide = sign(position.x);
  vec3 pivot = vec3(armSide * ${f(SHOULDER_X)}, ${f(SHOULDER_Y)}, 0.0);
  float angle = excite * 2.55 * armSide;
  float ca = cos(angle);
  float sa = sin(angle);
  vec3 rel = src - pivot;
  vec3 swung = vec3(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca, rel.z) + pivot;
  swung.x += sin(uTime * 7.0 + aPhase + rel.y * 5.0) * 0.05 * isFlag * show;

  vec3 transformed = mix(src, swung, isArm);
  transformed.y *= stretch;
  transformed.xz *= fat;
  transformed.y += lift;
  transformed.x += sway * motion;

  // Colour: shirt on the body, skin on head and arms, side tint on the pennant.
  float isHead = step(0.5, aPart) * (1.0 - isFlag);
  float farSide = step(0.0, seatZ);
  vec3 sideTint = mix(uNearTint, uFarTint, farSide);
  vec3 tint = mix(instanceColor, aHead, isHead);
  tint = mix(tint, sideTint * 1.6, isFlag);

  float flash = mix(uFlash.x, uFlash.y, farSide);
  vec3 shaded = color * tint;
  shaded = mix(shaded, sideTint, flash * 0.45) + sideTint * flash * 0.30;
  vColor = shaded * mix(1.0, 0.28, uDim);
`;

// --------------------------------------------------------------------------
// Geometry helpers
// --------------------------------------------------------------------------

/**
 * Bakes a fake key light into the vertex colours and tags every vertex with the
 * body part it belongs to. Doing the lighting once, at build time, is what lets
 * the crowd run on an unlit material and ignore the scene's lights entirely.
 */
const tagPart = (geometry: THREE.BufferGeometry, part: number, unlit = false): void => {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const count = position.count;
  const shades = new Float32Array(count * 3);
  const parts = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    let shade = 1;
    if (!unlit) {
      const lambert = Math.max(
        0,
        normal.getX(i) * LIGHT_DIR.x + normal.getY(i) * LIGHT_DIR.y + normal.getZ(i) * LIGHT_DIR.z,
      );
      // A vertical ramp on top of the lambert term fakes the ambient occlusion
      // of a body sitting in a packed terrace.
      const height = THREE.MathUtils.clamp(position.getY(i) / MODEL_HEIGHT, 0, 1);
      shade = 0.4 + 0.44 * lambert + 0.2 * height;
    }
    shades[i * 3] = shade;
    shades[i * 3 + 1] = shade;
    shades[i * 3 + 2] = shade;
    parts[i] = part;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(shades, 3));
  geometry.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
};

/**
 * One spectator: a rounded body, a head, two stubby arms and a pennant, merged
 * into a single ~70 triangle mesh. Low enough that seven hundred of them are one
 * cheap draw call, chunky enough to still read as a little person at distance.
 */
const buildSpectatorGeometry = (): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];

  const body = new THREE.SphereGeometry(0.34, 6, 4);
  body.scale(1, 1.28, 0.86);
  body.translate(0, 0.42, 0);
  tagPart(body, PART_BODY);
  parts.push(body);

  const head = new THREE.SphereGeometry(0.215, 6, 4);
  head.scale(1, 1.06, 0.96);
  head.translate(0, 0.95, 0);
  tagPart(head, PART_HEAD);
  parts.push(head);

  for (const side of [-1, 1]) {
    const arm = new THREE.BoxGeometry(0.1, ARM_LENGTH, 0.12);
    arm.translate(side * SHOULDER_X, SHOULDER_Y - ARM_LENGTH * 0.5, 0);
    tagPart(arm, PART_ARM);
    parts.push(arm);
  }

  // Two back-to-back quads rather than a double-sided material: four extra
  // triangles are far cheaper than disabling backface culling on the whole crowd.
  const flagFront = new THREE.PlaneGeometry(0.34, 0.24);
  const flagBack = new THREE.PlaneGeometry(0.34, 0.24);
  flagBack.rotateY(Math.PI);
  flagBack.translate(0, 0, -0.006);
  for (const flag of [flagFront, flagBack]) {
    flag.translate(HAND_X + 0.19, HAND_Y + 0.04, 0);
    tagPart(flag, PART_FLAG, true);
    parts.push(flag);
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();

  // The crowd material is unlit and untextured, so both attributes are dead
  // weight in the vertex stream once the shading has been baked.
  merged.deleteAttribute('normal');
  merged.deleteAttribute('uv');
  return merged;
};

interface Terrace {
  /** Distance from the arena centre to the front lip of each tier. */
  readonly innerX: number;
  readonly stepX: number;
  readonly stepY: number;
  readonly baseY: number;
  readonly spanZ: number;
  readonly deckTop: (tier: number) => number;
  readonly deckCentreX: (tier: number) => number;
}

const buildTerrace = (arena: Arena): Terrace => {
  const innerX = arena.halfWidth * 1.13;
  const stepX = arena.halfWidth * 0.21;
  const stepY = arena.halfHeight * 0.3;
  const baseY = -arena.halfHeight * 0.93;
  return {
    innerX,
    stepX,
    stepY,
    baseY,
    spanZ: arena.halfDepth * 2.06,
    deckTop: (tier: number) => baseY + tier * stepY,
    deckCentreX: (tier: number) => innerX + stepX * (tier + 0.5),
  };
};

/** The concrete: decks, risers and a back wall, merged into one static mesh. */
const buildStandsGeometry = (terrace: Terrace, arena: Arena): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  const deckThickness = terrace.stepY * 0.18;
  const wallHeight = terrace.stepY * TIERS + arena.halfHeight * 0.35;

  for (const side of [-1, 1]) {
    for (let tier = 0; tier < TIERS; tier++) {
      const y = terrace.deckTop(tier);

      const deck = new THREE.BoxGeometry(terrace.stepX, deckThickness, terrace.spanZ);
      deck.translate(side * terrace.deckCentreX(tier), y - deckThickness * 0.5, 0);
      tagPart(deck, PART_BODY);
      parts.push(deck);

      const riser = new THREE.BoxGeometry(deckThickness, terrace.stepY, terrace.spanZ);
      riser.translate(
        side * (terrace.innerX + terrace.stepX * tier + deckThickness * 0.5),
        y - terrace.stepY * 0.5,
        0,
      );
      tagPart(riser, PART_BODY);
      parts.push(riser);
    }

    const wall = new THREE.BoxGeometry(terrace.stepX * 0.4, wallHeight, terrace.spanZ);
    wall.translate(
      side * (terrace.innerX + terrace.stepX * TIERS + terrace.stepX * 0.2),
      terrace.baseY + wallHeight * 0.5 - terrace.stepY,
      0,
    );
    tagPart(wall, PART_BODY);
    parts.push(wall);
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.deleteAttribute('normal');
  merged.deleteAttribute('uv');
  return merged;
};

/**
 * The neon handrail along the lip of every tier, built as one mesh per half of
 * the arena so a scoring side can flash its own colour without a shader.
 */
const buildRailGeometry = (terrace: Terrace, half: -1 | 1): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  const thickness = terrace.stepY * 0.09;
  const length = terrace.spanZ * 0.5;

  for (const side of [-1, 1]) {
    for (let tier = 0; tier < TIERS; tier++) {
      const rail = new THREE.BoxGeometry(thickness, thickness, length);
      rail.translate(
        side * (terrace.innerX + terrace.stepX * tier + thickness * 2),
        terrace.deckTop(tier) + terrace.stepY * 0.55,
        half * length * 0.5,
      );
      parts.push(rail);
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.deleteAttribute('uv');
  merged.deleteAttribute('normal');
  return merged;
};

// --------------------------------------------------------------------------
// Module
// --------------------------------------------------------------------------

export const createCrowd = (options: { arena: Arena }): ReactiveModule => {
  const { arena } = options;
  const root = new THREE.Group();
  root.name = 'crowd';
  const disposables: { dispose(): void }[] = [];

  const terrace = buildTerrace(arena);
  const rng = createRng(0x50e0c1a);

  // ---- static architecture -------------------------------------------------

  const standsGeometry = buildStandsGeometry(terrace, arena);
  const standsMaterial = new THREE.MeshBasicMaterial({
    color: 0x0a0f24,
    vertexColors: true,
  });
  disposables.push(standsGeometry, standsMaterial);
  const stands = new THREE.Mesh(standsGeometry, standsMaterial);
  root.add(stands);

  const railMaterials: Record<'near' | 'far', THREE.MeshBasicMaterial> = {
    near: new THREE.MeshBasicMaterial({
      color: SIDE_THEME.near.core,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
    far: new THREE.MeshBasicMaterial({
      color: SIDE_THEME.far.core,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  };
  for (const half of [-1, 1] as const) {
    const geometry = buildRailGeometry(terrace, half);
    const material = half < 0 ? railMaterials.near : railMaterials.far;
    disposables.push(geometry, material);
    const rail = new THREE.Mesh(geometry, material);
    rail.renderOrder = -1;
    root.add(rail);
  }

  // ---- seating chart -------------------------------------------------------

  const rows = TIERS * 2;
  const perRow = Math.max(12, Math.round(SEAT_TARGET / rows));
  const total = rows * perRow;
  const gap = terrace.spanZ / perRow;
  const spectatorScale = arena.halfHeight * 0.15;

  interface Seat {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly tier: number;
    readonly facing: number;
    readonly key: number;
  }

  const seats: Seat[] = [];
  for (const side of [-1, 1]) {
    for (let tier = 0; tier < TIERS; tier++) {
      const stagger = tier % 2 === 0 ? 0 : gap * 0.5;
      for (let i = 0; i < perRow; i++) {
        const z = -terrace.spanZ * 0.5 + gap * (i + 0.5) + stagger + rng.range(-0.1, 0.1) * gap;
        seats.push({
          x: side * (terrace.deckCentreX(tier) + rng.range(-0.12, 0.12) * terrace.stepX),
          y: terrace.deckTop(tier),
          z,
          tier,
          // The model faces +Z, so a quarter turn points it at the play volume.
          facing: side > 0 ? -Math.PI / 2 : Math.PI / 2,
          // Sorting by this thins the upper tiers first when quality drops, so a
          // small crowd still looks like a crowd rather than a scattering.
          key: tier * 0.35 + rng.next(),
        });
      }
    }
  }
  seats.sort((a, b) => a.key - b.key);

  const spectatorGeometry = buildSpectatorGeometry();
  disposables.push(spectatorGeometry);

  const phases = new Float32Array(total);
  const energies = new Float32Array(total);
  const flags = new Float32Array(total);
  const heads = new Float32Array(total * 3);

  const uniforms = {
    uTime: { value: 0 },
    uMotion: { value: 1 },
    uDim: { value: 0 },
    uCheer: { value: 0 },
    uPennants: { value: 1 },
    uSlump: { value: new THREE.Vector2(0, -1e4) },
    uFlash: { value: new THREE.Vector2(0, 0) },
    // amplitude, start time, origin z, falloff reach
    uJump: { value: new THREE.Vector4(0, -1e4, 0, arena.halfDepth * 1.6) },
    // amplitude, start time, origin z, origin x
    uRipple: { value: new THREE.Vector4(0, -1e4, 0, 0) },
    // amplitude, start time, sweeps per second, half span
    uWave: { value: new THREE.Vector4(0, -1e4, 0.22, terrace.spanZ * 0.5) },
    uNearTint: { value: new THREE.Color(SIDE_THEME.near.core) },
    uFarTint: { value: new THREE.Color(SIDE_THEME.far.core) },
  };

  const crowdMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  crowdMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CROWD_VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', CROWD_VERTEX_BODY);
  };
  crowdMaterial.customProgramCacheKey = () => 'pong-crowd-1';
  disposables.push(crowdMaterial);

  const crowd = new THREE.InstancedMesh(spectatorGeometry, crowdMaterial, total);
  crowd.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  for (let i = 0; i < total; i++) {
    const seat = seats[i];
    if (seat === undefined) continue;

    scratchPosition.set(seat.x, seat.y, seat.z);
    scratchEuler.set(0, seat.facing + rng.range(-0.28, 0.28), 0);
    scratchQuaternion.setFromEuler(scratchEuler);
    const size = spectatorScale * rng.range(0.84, 1.16);
    scratchScale.set(size, size * rng.range(0.94, 1.1), size);
    scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
    crowd.setMatrixAt(i, scratchMatrix);

    // Supporters cluster behind the end they came to see, but most of the crowd
    // is neutral: too much side colour and the terraces start shouting.
    const supporterSide = seat.z < 0 ? SIDE_THEME.near : SIDE_THEME.far;
    if (rng.next() < 0.3) {
      scratchColor.setHex(supporterSide.core).multiplyScalar(0.36);
    } else {
      const tone = SHIRT_TONES[Math.floor(rng.next() * SHIRT_TONES.length)] ?? 0x2b3358;
      scratchColor.setHex(tone).multiplyScalar(CROWD_DIMMING);
    }
    crowd.setColorAt(i, scratchColor);

    const headTone = HEAD_TONES[Math.floor(rng.next() * HEAD_TONES.length)] ?? 0x8a6a52;
    scratchColor.setHex(headTone).multiplyScalar(CROWD_DIMMING);
    heads[i * 3] = scratchColor.r;
    heads[i * 3 + 1] = scratchColor.g;
    heads[i * 3 + 2] = scratchColor.b;

    phases[i] = rng.range(0, Math.PI * 2);
    energies[i] = rng.range(0.72, 1.3);
    flags[i] = rng.next() < PENNANT_SHARE ? 1 : 0;
  }

  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor !== null) crowd.instanceColor.needsUpdate = true;

  spectatorGeometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  spectatorGeometry.setAttribute('aEnergy', new THREE.InstancedBufferAttribute(energies, 1));
  spectatorGeometry.setAttribute('aFlag', new THREE.InstancedBufferAttribute(flags, 1));
  spectatorGeometry.setAttribute('aHead', new THREE.InstancedBufferAttribute(heads, 3));

  crowd.count = Math.round(total * OCCUPANCY.high);
  crowd.computeBoundingSphere();
  root.add(crowd);

  // ---- reactive state ------------------------------------------------------

  let pendingHit = false;
  let pendingHitZ = 0;
  let pendingHitX = 0;
  let pendingHitStrength = 0;

  let pendingJump = false;
  let pendingJumpZ = 0;
  let pendingJumpStrength = 0;

  let pendingSlump = false;
  let pendingSlumpStrength = 0;

  let pendingWave = false;
  let pendingCalm = false;

  let flashNear = 0;
  let flashFar = 0;
  let pendingFlashNear = 0;
  let pendingFlashFar = 0;

  let cheerTarget = 0;
  let cheerUntil = -1;
  let motion = 1;
  let dim = 0;

  const railBase = 0.3;

  const handleEvents = (events: readonly DomainEvent[]): void => {
    for (const event of events) {
      switch (event.type) {
        case 'paddle-hit': {
          pendingHit = true;
          pendingHitZ = event.position.z;
          pendingHitX = event.position.x;
          // Edge saves and long rallies get a bigger reaction — the crowd is a
          // tension meter as much as it is decoration.
          pendingHitStrength = Math.min(
            0.4,
            0.12 + (event.edge ? 0.1 : 0) + Math.min(event.rally, 12) * 0.014,
          );
          break;
        }
        case 'point-scored': {
          pendingJump = true;
          pendingJumpZ = goalPlaneZ(arena, event.scorer);
          pendingJumpStrength = 0.42 + Math.min(event.rally, 16) * 0.012;
          if (event.scorer === 'near') pendingFlashNear = 1;
          else pendingFlashFar = 1;
          break;
        }
        case 'paddle-miss': {
          pendingSlump = true;
          pendingSlumpStrength = 0.55;
          break;
        }
        case 'match-won': {
          pendingJump = true;
          pendingJumpZ = goalPlaneZ(arena, event.winner);
          pendingJumpStrength = 0.6;
          pendingWave = true;
          if (event.winner === 'near') pendingFlashNear = 1;
          else pendingFlashFar = 1;
          break;
        }
        case 'serve': {
          pendingCalm = true;
          break;
        }
        case 'wall-bounce':
          break;
      }
    }
  };

  const update = (ctx: FrameContext): void => {
    const { time, dt } = ctx;
    uniforms.uTime.value = time;

    if (pendingCalm) {
      pendingCalm = false;
      cheerUntil = -1;
      uniforms.uWave.value.x = 0;
    }

    if (pendingHit) {
      pendingHit = false;
      uniforms.uRipple.value.set(pendingHitStrength, time, pendingHitZ, pendingHitX);
    }

    if (pendingJump) {
      pendingJump = false;
      uniforms.uJump.value.x = pendingJumpStrength;
      uniforms.uJump.value.y = time;
      uniforms.uJump.value.z = pendingJumpZ;
    }

    if (pendingSlump) {
      pendingSlump = false;
      uniforms.uSlump.value.set(pendingSlumpStrength, time);
    }

    if (pendingWave) {
      pendingWave = false;
      uniforms.uWave.value.x = 0.5;
      uniforms.uWave.value.y = time;
      cheerUntil = time + 14;
    }

    if (pendingFlashNear > 0) {
      flashNear = pendingFlashNear;
      pendingFlashNear = 0;
    }
    if (pendingFlashFar > 0) {
      flashFar = pendingFlashFar;
      pendingFlashFar = 0;
    }

    const decay = Math.exp(-dt * 1.6);
    flashNear *= decay;
    flashFar *= decay;
    if (flashNear < 0.002) flashNear = 0;
    if (flashFar < 0.002) flashFar = 0;
    uniforms.uFlash.value.set(flashNear, flashFar);

    cheerTarget = time < cheerUntil ? 1 : 0;
    uniforms.uCheer.value +=
      (cheerTarget - uniforms.uCheer.value) * approach(cheerTarget > 0 ? 9 : 1.1, dt);

    const motionTarget = ctx.reducedMotion ? 0.25 : 1;
    motion += (motionTarget - motion) * approach(6, dt);
    uniforms.uMotion.value = motion;

    const dimTarget = ctx.dimmed ? 1 : 0;
    dim += (dimTarget - dim) * approach(5, dt);
    uniforms.uDim.value = dim;

    const architecture = 1 - dim * 0.75;
    standsMaterial.color.setRGB(
      0.17 * architecture,
      0.21 * architecture,
      0.36 * architecture,
    );
    railMaterials.near.opacity = (railBase + flashNear * 0.55) * architecture;
    railMaterials.far.opacity = (railBase + flashFar * 0.55) * architecture;
  };

  const setQuality = (level: QualityLevel): void => {
    crowd.count = Math.round(total * OCCUPANCY[level]);
    uniforms.uPennants.value = level === 'low' ? 0 : 1;
  };

  const dispose = (): void => {
    root.clear();
    crowd.dispose();
    for (const item of disposables) item.dispose();
    disposables.length = 0;
  };

  return { object3D: root, update, setQuality, dispose, handleEvents };
};
