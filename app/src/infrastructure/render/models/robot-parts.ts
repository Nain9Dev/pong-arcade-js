import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { Side } from '../../../domain/arena';
import type { MatchRules } from '../../../domain/rules';
import { SIDE_THEME } from '../palette';
import { mergeAndDispose as fuse } from './merge';

/**
 * The workshop: every plate, lens and nozzle the two duelling robots are made of.
 *
 * Nothing here animates. This module only knows how to *build* a robot out of
 * Three.js primitives — proportions, materials and merged geometry — and hands
 * back the named pivots that `robot-rig` then poses. Keeping the two apart means
 * the silhouette can be redesigned without touching a single line of animation.
 *
 * Two rules shape everything below:
 *
 * 1. **Nothing is loaded.** The game ships as one static bundle, so a bolt is a
 *    cylinder, a visor is a squashed sphere and a hover glow is a canvas gradient.
 * 2. **Static geometry is merged.** Anything that never moves relative to its
 *    parent is baked into a single `BufferGeometry`; anything repeated becomes an
 *    `InstancedMesh`. A robot this detailed would otherwise cost ~90 draw calls.
 *
 * The rig origin sits on the **shoulder line**, not on the floor: the robot has
 * no legs, it hovers, and pinning the origin to the shoulders keeps both robots'
 * arms working in the same vertical band whatever their height.
 */

export type RobotVariant = 'chispa' | 'tornillo';

export interface Disposable {
  dispose(): void;
}

/** Collects everything that owns GPU memory so `dispose()` can be exhaustive. */
export class Disposal {
  private readonly items: Disposable[] = [];

  track<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  releaseAll(): void {
    for (const item of this.items) item.dispose();
    this.items.length = 0;
  }
}

/**
 * All the numbers that make one robot look like itself.
 *
 * Lengths are absolute world units rather than multiples of a master scale: the
 * arm solver needs true bone lengths, and a scaled root would silently break it.
 */
export interface RobotSpec {
  readonly variant: RobotVariant;
  /** Corner rounding of every plate. Chispa is pillowy, Tornillo is a brick. */
  readonly bevel: number;
  readonly torsoWidth: number;
  readonly torsoHeight: number;
  readonly torsoDepth: number;
  /** Torso centre relative to the rig origin (which is the shoulder line). */
  readonly torsoCentreY: number;
  readonly shoulderSpan: number;
  readonly shoulderY: number;
  /** Height of the neck joint, where the head pivot lives. */
  readonly neckY: number;
  readonly headWidth: number;
  readonly headHeight: number;
  readonly headDepth: number;
  readonly earLength: number;
  readonly eyeRadius: number;
  /** Multiplier on the robot's right eye. Tornillo's is comically oversized. */
  readonly eyeAsymmetry: number;
  readonly eyeSpacing: number;
  readonly antennaLength: number;
  /** Rest tilt of the antenna: positive leans it forward, into the arena. */
  readonly antennaTilt: number;
  /** Extra kink halfway up the stalk. */
  readonly antennaKink: number;
  readonly upperArm: number;
  readonly forearm: number;
  readonly handle: number;
  readonly baseRadius: number;
  /** Height of the hover base pivot, below the torso. */
  readonly baseY: number;
  /** Permanent roll baked into one belly plate, so Tornillo looks dinged. */
  readonly dent: number;
  /** Idle bob amplitude multiplier. */
  readonly bob: number;
  /** Global animation speed. Chispa is twitchy, Tornillo is ponderous. */
  readonly tempo: number;
  /** Desync phase so the two robots never breathe in lockstep. */
  readonly phase: number;
  readonly gyroBlocks: number;
  readonly rivets: number;
}

const CHISPA: RobotSpec = {
  variant: 'chispa',
  bevel: 0.17,
  torsoWidth: 2.15,
  torsoHeight: 2.05,
  torsoDepth: 1.45,
  torsoCentreY: -0.9,
  shoulderSpan: 2.5,
  shoulderY: 0,
  neckY: 0.16,
  headWidth: 1.95,
  headHeight: 1.55,
  headDepth: 1.6,
  earLength: 0.34,
  eyeRadius: 0.28,
  eyeAsymmetry: 1,
  eyeSpacing: 0.46,
  antennaLength: 1.05,
  antennaTilt: 0.62,
  antennaKink: 0,
  upperArm: 1.45,
  forearm: 1.32,
  handle: 0.92,
  baseRadius: 1.18,
  baseY: -2.35,
  dent: 0,
  bob: 1.25,
  tempo: 1.2,
  phase: 0,
  gyroBlocks: 12,
  rivets: 18,
};

const TORNILLO: RobotSpec = {
  variant: 'tornillo',
  bevel: 0.055,
  torsoWidth: 1.95,
  torsoHeight: 2.45,
  torsoDepth: 1.35,
  torsoCentreY: -1.05,
  shoulderSpan: 2.3,
  shoulderY: 0.02,
  neckY: 0.2,
  headWidth: 1.7,
  headHeight: 1.8,
  headDepth: 1.55,
  earLength: 0.46,
  eyeRadius: 0.25,
  eyeAsymmetry: 1.45,
  eyeSpacing: 0.44,
  antennaLength: 1.25,
  antennaTilt: 0.1,
  antennaKink: 0.8,
  upperArm: 1.55,
  forearm: 1.38,
  handle: 0.95,
  baseRadius: 1.05,
  baseY: -2.75,
  dent: 0.3,
  bob: 0.85,
  tempo: 0.88,
  phase: 1.7,
  gyroBlocks: 10,
  rivets: 22,
};

export const ROBOT_SPECS: Readonly<Record<RobotVariant, RobotSpec>> = {
  chispa: CHISPA,
  tornillo: TORNILLO,
};

/** Head pivot height: the neck joint the whole head rotates around. */
export const headPivotY = (spec: RobotSpec): number => spec.neckY + 0.2;

/** Distance from the wrist to the racket face, along the forearm axis. */
export const racketOffset = (spec: RobotSpec): number => spec.handle + 0.18;

/** Full effective length of the lower IK bone: forearm plus the racket it holds. */
export const lowerBoneLength = (spec: RobotSpec): number => spec.forearm + racketOffset(spec);

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface RobotMaterials {
  /** Dark structural armour. */
  readonly shell: THREE.MeshStandardMaterial;
  /** Lighter panels layered over the shell, so plates read as separate pieces. */
  readonly plate: THREE.MeshStandardMaterial;
  /** Recessed panel gaps — nearly black, never lit. */
  readonly seam: THREE.MeshBasicMaterial;
  /** Emissive trim in the robot's own colour. */
  readonly accent: THREE.MeshStandardMaterial;
  /** The power core; its `emissiveIntensity` is driven every frame. */
  readonly core: THREE.MeshStandardMaterial;
  /** Blown-out additive light: bulbs, thrusters, core centre. */
  readonly glow: THREE.MeshBasicMaterial;
  readonly halo: THREE.SpriteMaterial;
  readonly disc: THREE.MeshBasicMaterial;
  readonly visor: THREE.MeshStandardMaterial;
  readonly visorRim: THREE.MeshBasicMaterial;
  readonly sclera: THREE.MeshBasicMaterial;
  readonly pupil: THREE.MeshBasicMaterial;
  readonly pip: THREE.MeshBasicMaterial;
  /** The racket's energy membrane. */
  readonly field: THREE.MeshBasicMaterial;
}

export const createRobotMaterials = (
  side: Side,
  glowTexture: THREE.Texture,
  disposal: Disposal,
): RobotMaterials => {
  const theme = SIDE_THEME[side];
  const track = <T extends THREE.Material>(material: T): T => disposal.track(material);

  return {
    shell: track(
      new THREE.MeshStandardMaterial({
        color: 0x121a2e,
        emissive: theme.deep,
        emissiveIntensity: 0.5,
        metalness: 0.78,
        roughness: 0.38,
      }),
    ),
    plate: track(
      new THREE.MeshStandardMaterial({
        color: 0x1d2742,
        emissive: theme.deep,
        emissiveIntensity: 0.32,
        metalness: 0.58,
        roughness: 0.52,
      }),
    ),
    seam: track(new THREE.MeshBasicMaterial({ color: 0x03040c })),
    accent: track(
      new THREE.MeshStandardMaterial({
        color: theme.deep,
        emissive: theme.core,
        emissiveIntensity: 1.15,
        metalness: 0.35,
        roughness: 0.28,
      }),
    ),
    core: track(
      new THREE.MeshStandardMaterial({
        color: 0x050914,
        emissive: theme.glow,
        emissiveIntensity: 1.6,
        metalness: 0.1,
        roughness: 0.15,
      }),
    ),
    glow: track(new THREE.MeshBasicMaterial({ color: theme.glow, toneMapped: false })),
    halo: track(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: theme.core,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    ),
    disc: track(
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: theme.core,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    ),
    visor: track(
      new THREE.MeshStandardMaterial({
        color: 0x020617,
        emissive: theme.deep,
        emissiveIntensity: 0.8,
        metalness: 0.15,
        roughness: 0.06,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    ),
    visorRim: track(
      new THREE.MeshBasicMaterial({ color: theme.core, toneMapped: false }),
    ),
    sclera: track(new THREE.MeshBasicMaterial({ color: 0xf3f8ff, toneMapped: false })),
    pupil: track(new THREE.MeshBasicMaterial({ color: 0x05070f })),
    pip: track(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })),
    field: track(
      new THREE.MeshBasicMaterial({
        color: theme.glow,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    ),
  };
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** A bevelled box whose corner radius can never exceed the box itself. */
const slab = (w: number, h: number, d: number, bevel: number, segments = 2): THREE.BufferGeometry => {
  const radius = Math.max(0.012, Math.min(bevel, w * 0.48, h * 0.48, d * 0.48));
  return new RoundedBoxGeometry(w, h, d, radius > 0.05 ? segments : 1, radius);
};

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

export interface TorsoParts {
  readonly group: THREE.Group;
  /** Belly plate that droops on defeat, and carries Tornillo's dent. */
  readonly sagPlate: THREE.Object3D;
  readonly pauldronLeft: THREE.Object3D;
  readonly pauldronRight: THREE.Object3D;
  readonly core: THREE.Mesh;
  readonly coreHalo: THREE.Sprite;
  readonly rivets: THREE.InstancedMesh;
  readonly seams: THREE.Mesh;
  /** One emissive pip per point needed to win, lit as the score climbs. */
  readonly pips: THREE.InstancedMesh;
  readonly pipCount: number;
}

export const buildTorso = (
  spec: RobotSpec,
  materials: RobotMaterials,
  rules: MatchRules,
  disposal: Disposal,
): TorsoParts => {
  const group = new THREE.Group();
  const { torsoWidth: w, torsoHeight: h, torsoDepth: d, torsoCentreY: cy, bevel } = spec;
  const front = d * 0.5;

  // --- structural shell -----------------------------------------------------
  const shellParts: THREE.BufferGeometry[] = [];
  shellParts.push(slab(w, h, d, bevel, 3).translate(0, cy, 0));
  // Collar, hips and backpack: the silhouette breakers.
  shellParts.push(slab(w * 0.72, 0.28, d * 0.82, bevel).translate(0, cy + h * 0.5 + 0.02, 0));
  shellParts.push(slab(w * 0.66, 0.42, d * 0.86, bevel).translate(0, cy - h * 0.5 - 0.14, 0));
  shellParts.push(slab(w * 0.68, h * 0.52, 0.34, bevel).translate(0, cy + 0.12, -front - 0.13));
  // Cooling vents: five slats down each flank.
  for (let i = 0; i < 5; i++) {
    const y = cy + h * 0.22 - i * (h * 0.11);
    shellParts.push(slab(0.16, 0.07, d * 0.52, 0.02).translate(w * 0.5 + 0.03, y, 0));
    shellParts.push(slab(0.16, 0.07, d * 0.52, 0.02).translate(-w * 0.5 - 0.03, y, 0));
  }
  const shellGeometry = disposal.track(fuse(shellParts));
  group.add(new THREE.Mesh(shellGeometry, materials.shell));

  // --- layered armour plates ------------------------------------------------
  const plateParts: THREE.BufferGeometry[] = [];
  plateParts.push(slab(w * 0.8, h * 0.42, 0.2, bevel).translate(0, cy + h * 0.22, front + 0.07));
  plateParts.push(slab(w * 0.34, h * 0.2, 0.16, bevel).translate(0, cy + h * 0.46, front + 0.16));
  plateParts.push(slab(w * 0.55, 0.3, 0.18, bevel).translate(0, cy - h * 0.46, front + 0.05));
  const plateGeometry = disposal.track(fuse(plateParts));
  group.add(new THREE.Mesh(plateGeometry, materials.plate));

  // --- the plate that sags in defeat ---------------------------------------
  const sagPlate = new THREE.Object3D();
  sagPlate.position.set(w * 0.14, cy - h * 0.16, front + 0.06);
  sagPlate.rotation.z = spec.dent;
  const sagGeometry = disposal.track(
    fuse([
      slab(w * 0.52, h * 0.26, 0.16, bevel),
      slab(w * 0.2, 0.08, 0.1, 0.02).translate(0, h * 0.11, 0.09),
    ]),
  );
  sagPlate.add(new THREE.Mesh(sagGeometry, materials.plate));
  group.add(sagPlate);

  // --- panel gaps -----------------------------------------------------------
  const seamGeometry = disposal.track(
    fuse([
      new THREE.BoxGeometry(w * 0.86, 0.035, 0.04).translate(0, cy + h * 0.02, front + 0.005),
      new THREE.BoxGeometry(w * 0.62, 0.035, 0.04).translate(0, cy - h * 0.3, front + 0.005),
      new THREE.BoxGeometry(0.035, h * 0.6, 0.04).translate(0, cy + h * 0.06, front + 0.005),
    ]),
  );
  const seams = new THREE.Mesh(seamGeometry, materials.seam);
  seams.renderOrder = 1;
  group.add(seams);

  // --- power core -----------------------------------------------------------
  const coreY = cy + h * 0.24;
  const coreGeometry = disposal.track(
    fuse([
      new THREE.SphereGeometry(0.3, 16, 12).translate(0, 0, 0),
      new THREE.TorusGeometry(0.36, 0.055, 6, 20).translate(0, 0, -0.02),
    ]),
  );
  const core = new THREE.Mesh(coreGeometry, materials.core);
  core.position.set(0, coreY, front + 0.2);
  group.add(core);

  const coreHalo = new THREE.Sprite(materials.halo);
  coreHalo.position.set(0, coreY, front + 0.32);
  coreHalo.scale.setScalar(1.7);
  group.add(coreHalo);

  // --- rivets ---------------------------------------------------------------
  // One draw call for the whole scatter; the matrices never change afterwards.
  const rivetGeometry = disposal.track(new THREE.CylinderGeometry(0.055, 0.07, 0.05, 6));
  rivetGeometry.rotateX(Math.PI * 0.5);
  const rivets = new THREE.InstancedMesh(rivetGeometry, materials.accent, spec.rivets);
  rivets.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < spec.rivets; i++) {
    const angle = (i / spec.rivets) * Math.PI * 2 + 0.4;
    const rx = Math.cos(angle) * w * 0.4;
    const ry = Math.sin(angle) * h * 0.36;
    matrix.makeTranslation(rx, cy + ry + h * 0.05, front + 0.09);
    rivets.setMatrixAt(i, matrix);
  }
  rivets.instanceMatrix.needsUpdate = true;
  group.add(rivets);

  // --- score pips -----------------------------------------------------------
  const pipCount = Math.max(1, Math.min(12, rules.pointsToWin));
  const pipSpan = w * 0.62;
  const pipStep = pipSpan / pipCount;
  const pipGeometry = disposal.track(
    new THREE.BoxGeometry(Math.min(0.15, pipStep * 0.6), 0.09, 0.06),
  );
  const pips = new THREE.InstancedMesh(pipGeometry, materials.pip, pipCount);
  pips.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  for (let i = 0; i < pipCount; i++) {
    matrix.makeTranslation(
      -pipSpan * 0.5 + pipStep * (i + 0.5),
      cy - h * 0.46,
      front + 0.15,
    );
    pips.setMatrixAt(i, matrix);
  }
  pips.instanceMatrix.needsUpdate = true;
  group.add(pips);

  // --- pauldrons ------------------------------------------------------------
  const pauldronGeometry = disposal.track(
    fuse([
      slab(0.92, 0.6, 0.98, Math.max(bevel, 0.12), 3),
      slab(0.34, 0.16, 0.62, 0.05).translate(0.24, 0.3, 0),
    ]),
  );
  const half = spec.shoulderSpan * 0.5;
  const pauldronRight = new THREE.Object3D();
  pauldronRight.position.set(half + 0.08, spec.shoulderY + 0.2, 0);
  pauldronRight.rotation.z = -0.24;
  pauldronRight.add(new THREE.Mesh(pauldronGeometry, materials.shell));
  group.add(pauldronRight);

  const pauldronLeft = new THREE.Object3D();
  pauldronLeft.position.set(-half - 0.08, spec.shoulderY + 0.2, 0);
  pauldronLeft.rotation.z = 0.24;
  pauldronLeft.scale.x = -1;
  pauldronLeft.add(new THREE.Mesh(pauldronGeometry, materials.shell));
  group.add(pauldronLeft);

  return {
    group,
    sagPlate,
    pauldronLeft,
    pauldronRight,
    core,
    coreHalo,
    rivets,
    seams,
    pips,
    pipCount,
  };
};

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

export interface EyeParts {
  readonly group: THREE.Object3D;
  readonly ball: THREE.Mesh;
  readonly pupilPivot: THREE.Object3D;
  readonly glint: THREE.Mesh;
  /** Happy arc that replaces the eyeball when the robot beams. */
  readonly arc: THREE.Mesh;
  readonly lidTop: THREE.Object3D;
  readonly lidBottom: THREE.Object3D;
  readonly radius: number;
  /** `+1` for the robot's right eye, `-1` for its left; mirrors brow angles. */
  readonly sign: number;
}

export interface HeadParts {
  readonly group: THREE.Object3D;
  readonly jaw: THREE.Object3D;
  readonly antenna: THREE.Object3D;
  readonly bulb: THREE.Mesh;
  readonly visorRim: THREE.Mesh;
  readonly eyes: readonly EyeParts[];
}

const buildEye = (
  spec: RobotSpec,
  materials: RobotMaterials,
  disposal: Disposal,
  sign: number,
  scale: number,
): EyeParts => {
  const radius = spec.eyeRadius * scale;
  const group = new THREE.Object3D();

  const ballGeometry = disposal.track(new THREE.SphereGeometry(radius, 14, 10));
  const ball = new THREE.Mesh(ballGeometry, materials.sclera);
  ball.renderOrder = 2;
  group.add(ball);

  // The pupil hangs off a pivot at the eye centre, so "looking" is a rotation
  // and the pupil always stays glued to the eyeball surface.
  const pupilPivot = new THREE.Object3D();
  const pupilGeometry = disposal.track(new THREE.SphereGeometry(radius * 0.46, 12, 9));
  pupilGeometry.scale(1, 1, 0.62);
  pupilGeometry.translate(0, 0, radius * 0.72);
  const pupil = new THREE.Mesh(pupilGeometry, materials.pupil);
  pupil.renderOrder = 3;
  pupilPivot.add(pupil);

  const glintGeometry = disposal.track(new THREE.SphereGeometry(radius * 0.15, 8, 6));
  glintGeometry.translate(-radius * 0.16, radius * 0.17, radius * 0.9);
  const glint = new THREE.Mesh(glintGeometry, materials.sclera);
  glint.renderOrder = 4;
  pupilPivot.add(glint);
  group.add(pupilPivot);

  // Half torus: the classic "^_^" arc, hidden until the robot is delighted.
  const arcGeometry = disposal.track(
    new THREE.TorusGeometry(radius * 0.95, radius * 0.2, 6, 14, Math.PI),
  );
  arcGeometry.translate(0, -radius * 0.2, radius * 0.4);
  const arc = new THREE.Mesh(arcGeometry, materials.sclera);
  arc.renderOrder = 3;
  arc.visible = false;
  group.add(arc);

  const lidGeometry = disposal.track(slab(radius * 2.6, radius * 1.8, radius * 0.5, radius * 0.2));
  const lidTop = new THREE.Object3D();
  lidTop.add(new THREE.Mesh(lidGeometry, materials.shell));
  lidTop.position.z = radius * 0.3;
  group.add(lidTop);

  const lidBottom = new THREE.Object3D();
  lidBottom.add(new THREE.Mesh(lidGeometry, materials.shell));
  lidBottom.position.z = radius * 0.3;
  group.add(lidBottom);

  return { group, ball, pupilPivot, glint, arc, lidTop, lidBottom, radius, sign };
};

export const buildHead = (
  spec: RobotSpec,
  materials: RobotMaterials,
  disposal: Disposal,
): HeadParts => {
  const group = new THREE.Object3D();
  const { headWidth: w, headHeight: h, headDepth: d, bevel } = spec;
  const centre = h * 0.52;
  const front = d * 0.5;

  // --- chassis --------------------------------------------------------------
  const shellParts: THREE.BufferGeometry[] = [];
  shellParts.push(slab(w, h, d, Math.max(bevel, 0.1), 3).translate(0, centre, 0));
  // Brow ridge.
  shellParts.push(slab(w * 0.94, 0.22, d * 0.66, bevel).translate(0, centre + h * 0.4, d * 0.1));
  // Chin block, below the jaw hinge.
  shellParts.push(slab(w * 0.5, 0.24, d * 0.5, bevel).translate(0, centre - h * 0.46, -d * 0.1));
  // Ear vents: a barrel plus three fins on each side.
  for (const sx of [1, -1]) {
    const earX = sx * (w * 0.5 + spec.earLength * 0.45);
    const ear = new THREE.CylinderGeometry(0.24, 0.28, spec.earLength, 10);
    ear.rotateZ(Math.PI * 0.5);
    shellParts.push(ear.translate(earX, centre + h * 0.06, -d * 0.04));
    for (let i = 0; i < 3; i++) {
      shellParts.push(
        slab(spec.earLength * 0.9, 0.05, 0.32, 0.02).translate(
          earX,
          centre + h * 0.06 + 0.16 - i * 0.15,
          -d * 0.04 + 0.16,
        ),
      );
    }
  }
  const shellGeometry = disposal.track(fuse(shellParts));
  group.add(new THREE.Mesh(shellGeometry, materials.shell));

  // --- visor ----------------------------------------------------------------
  // A squashed sphere reads as curved glass from any angle, and costs one draw
  // call; the rim behind it is what actually sells the "lens".
  const visorY = centre + h * 0.12;
  const visorGeometry = disposal.track(new THREE.SphereGeometry(1, 20, 12));
  visorGeometry.scale(w * 0.42, h * 0.3, d * 0.62);
  visorGeometry.translate(0, visorY, 0);
  const visor = new THREE.Mesh(visorGeometry, materials.visor);
  visor.renderOrder = 6;
  group.add(visor);

  const rimGeometry = disposal.track(new THREE.TorusGeometry(1, 0.055, 6, 30));
  rimGeometry.scale(w * 0.42, h * 0.3, 1);
  rimGeometry.translate(0, visorY, d * 0.34);
  const visorRim = new THREE.Mesh(rimGeometry, materials.visorRim);
  visorRim.renderOrder = 5;
  group.add(visorRim);

  // --- eyes -----------------------------------------------------------------
  const right = buildEye(spec, materials, disposal, 1, spec.eyeAsymmetry);
  right.group.position.set(spec.eyeSpacing, visorY + 0.02, d * 0.22);
  group.add(right.group);

  const left = buildEye(spec, materials, disposal, -1, 1);
  left.group.position.set(-spec.eyeSpacing, visorY, d * 0.22);
  group.add(left.group);

  // --- jaw ------------------------------------------------------------------
  const jaw = new THREE.Object3D();
  jaw.position.set(0, centre - h * 0.3, d * 0.24);
  const jawGeometry = disposal.track(
    fuse([
      slab(w * 0.6, 0.3, d * 0.44, bevel).translate(0, -0.14, -d * 0.1),
      slab(w * 0.42, 0.08, 0.1, 0.02).translate(0, -0.03, front - 0.28),
    ]),
  );
  jaw.add(new THREE.Mesh(jawGeometry, materials.plate));
  group.add(jaw);

  // --- antenna --------------------------------------------------------------
  const antenna = new THREE.Object3D();
  antenna.position.set(0, centre + h * 0.5, -d * 0.06);
  const stalkParts: THREE.BufferGeometry[] = [];
  const lower = spec.antennaLength * 0.55;
  stalkParts.push(new THREE.CylinderGeometry(0.05, 0.075, lower, 6).translate(0, lower * 0.5, 0));
  const upper = new THREE.CylinderGeometry(0.04, 0.05, spec.antennaLength * 0.5, 6);
  upper.translate(0, spec.antennaLength * 0.25, 0);
  upper.rotateX(spec.antennaKink);
  upper.translate(0, lower, 0);
  stalkParts.push(upper);
  const stalkGeometry = disposal.track(fuse(stalkParts));
  antenna.add(new THREE.Mesh(stalkGeometry, materials.shell));

  const bulbGeometry = disposal.track(new THREE.SphereGeometry(0.14, 10, 8));
  const bulb = new THREE.Mesh(bulbGeometry, materials.glow);
  const tip = lower + spec.antennaLength * 0.5;
  bulb.position.set(0, lower + Math.cos(spec.antennaKink) * spec.antennaLength * 0.5, Math.sin(spec.antennaKink) * spec.antennaLength * 0.5);
  bulb.position.y = Math.min(bulb.position.y, tip);
  antenna.add(bulb);
  group.add(antenna);

  return { group, jaw, antenna, bulb, visorRim, eyes: [right, left] };
};

// ---------------------------------------------------------------------------
// Hover base
// ---------------------------------------------------------------------------

export interface BaseParts {
  readonly group: THREE.Object3D;
  readonly gyro: THREE.Object3D;
  readonly gyroBlocks: THREE.InstancedMesh;
  readonly gyroRing: THREE.Mesh;
  readonly disc: THREE.Mesh;
  readonly thrust: THREE.Mesh;
}

export const buildBase = (
  spec: RobotSpec,
  materials: RobotMaterials,
  disposal: Disposal,
): BaseParts => {
  const group = new THREE.Object3D();
  const r = spec.baseRadius;

  const hullGeometry = disposal.track(
    fuse([
      new THREE.CylinderGeometry(r * 0.5, r * 0.66, 0.36, 14).translate(0, -0.1, 0),
      new THREE.CylinderGeometry(r * 0.66, r * 0.98, 0.5, 14).translate(0, -0.52, 0),
      new THREE.CylinderGeometry(r * 0.98, r * 0.42, 0.42, 14).translate(0, -0.97, 0),
      // Three thruster nozzles under the skirt.
      ...[0, 1, 2].map((i) => {
        const angle = (i / 3) * Math.PI * 2 + Math.PI * 0.5;
        return new THREE.CylinderGeometry(0.14, 0.22, 0.3, 8).translate(
          Math.cos(angle) * r * 0.55,
          -1.12,
          Math.sin(angle) * r * 0.55,
        );
      }),
    ]),
  );
  group.add(new THREE.Mesh(hullGeometry, materials.shell));

  const thrustGeometry = disposal.track(
    fuse(
      [0, 1, 2].map((i) => {
        const angle = (i / 3) * Math.PI * 2 + Math.PI * 0.5;
        const cone = new THREE.ConeGeometry(0.17, 0.42, 8, 1, true);
        cone.rotateX(Math.PI);
        return cone.translate(Math.cos(angle) * r * 0.55, -1.44, Math.sin(angle) * r * 0.55);
      }),
    ),
  );
  const thrust = new THREE.Mesh(thrustGeometry, materials.glow);
  thrust.renderOrder = 2;
  group.add(thrust);

  // The gyro ring: a torus plus a ring of blocks, spinning as one.
  const gyro = new THREE.Object3D();
  gyro.position.y = -0.55;
  const ringGeometry = disposal.track(new THREE.TorusGeometry(r * 1.12, 0.05, 6, 26));
  ringGeometry.rotateX(Math.PI * 0.5);
  const gyroRing = new THREE.Mesh(ringGeometry, materials.accent);
  gyro.add(gyroRing);

  const blockGeometry = disposal.track(slab(0.2, 0.13, 0.3, 0.03));
  const gyroBlocks = new THREE.InstancedMesh(blockGeometry, materials.accent, spec.gyroBlocks);
  gyroBlocks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const axis = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < spec.gyroBlocks; i++) {
    const angle = (i / spec.gyroBlocks) * Math.PI * 2;
    position.set(Math.cos(angle) * r * 1.12, 0, Math.sin(angle) * r * 1.12);
    quaternion.setFromAxisAngle(axis, -angle);
    matrix.compose(position, quaternion, scale);
    gyroBlocks.setMatrixAt(i, matrix);
  }
  gyroBlocks.instanceMatrix.needsUpdate = true;
  gyro.add(gyroBlocks);
  group.add(gyro);

  const discGeometry = disposal.track(new THREE.PlaneGeometry(r * 4.6, r * 4.6));
  discGeometry.rotateX(-Math.PI * 0.5);
  const disc = new THREE.Mesh(discGeometry, materials.disc);
  disc.position.y = -1.5;
  disc.renderOrder = 1;
  group.add(disc);

  return { group, gyro, gyroBlocks, gyroRing, disc, thrust };
};

// ---------------------------------------------------------------------------
// Arms and racket
// ---------------------------------------------------------------------------

export interface ArmParts {
  readonly shoulder: THREE.Object3D;
  readonly elbow: THREE.Object3D;
  readonly wrist: THREE.Object3D;
}

/**
 * One articulated arm: shoulder → elbow → wrist, each an empty pivot with the
 * bone mesh hanging along its local `-Y`. Bones are built at their true length
 * because the IK solver reasons in exactly these units.
 */
export const buildArm = (
  spec: RobotSpec,
  materials: RobotMaterials,
  disposal: Disposal,
  sign: number,
): ArmParts => {
  const shoulder = new THREE.Object3D();
  shoulder.position.set((sign * spec.shoulderSpan) / 2, spec.shoulderY, 0);

  const upperGeometry = disposal.track(
    fuse([
      new THREE.SphereGeometry(0.3, 12, 9),
      slab(0.4, spec.upperArm * 0.86, 0.4, 0.12).translate(0, -spec.upperArm * 0.5, 0),
      slab(0.46, 0.16, 0.46, 0.06).translate(0, -spec.upperArm * 0.78, 0),
    ]),
  );
  shoulder.add(new THREE.Mesh(upperGeometry, materials.shell));

  const elbow = new THREE.Object3D();
  elbow.position.y = -spec.upperArm;
  shoulder.add(elbow);

  // Forearm plus two exposed pistons, so the joint reads as machinery.
  const forearmParts: THREE.BufferGeometry[] = [
    new THREE.SphereGeometry(0.24, 12, 9),
    slab(0.36, spec.forearm * 0.84, 0.36, 0.1).translate(0, -spec.forearm * 0.48, 0),
  ];
  for (const px of [0.19, -0.19]) {
    forearmParts.push(
      new THREE.CylinderGeometry(0.055, 0.055, spec.forearm * 0.62, 6).translate(
        px,
        -spec.forearm * 0.42,
        0.2,
      ),
    );
  }
  const forearmGeometry = disposal.track(fuse(forearmParts));
  elbow.add(new THREE.Mesh(forearmGeometry, materials.shell));

  const pistonGeometry = disposal.track(
    fuse([
      new THREE.CylinderGeometry(0.08, 0.08, 0.26, 8).translate(0.19, -spec.forearm * 0.14, 0.2),
      new THREE.CylinderGeometry(0.08, 0.08, 0.26, 8).translate(-0.19, -spec.forearm * 0.14, 0.2),
    ]),
  );
  elbow.add(new THREE.Mesh(pistonGeometry, materials.accent));

  const wrist = new THREE.Object3D();
  wrist.position.y = -spec.forearm;
  elbow.add(wrist);

  return { shoulder, elbow, wrist };
};

/**
 * Three fingers wrapped around a handle.
 *
 * They sit at 120° around the grip axis, which is what lets the solver twist
 * the wrist freely to keep the racket face level without the grip ever looking
 * wrong.
 */
export const buildHand = (
  materials: RobotMaterials,
  disposal: Disposal,
  gripY: number,
): THREE.Mesh => {
  const parts: THREE.BufferGeometry[] = [slab(0.34, 0.32, 0.3, 0.1).translate(0, gripY, 0)];
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + 0.4;
    const cx = Math.cos(angle) * 0.17;
    const cz = Math.sin(angle) * 0.17;
    const knuckle = slab(0.13, 0.22, 0.13, 0.05);
    knuckle.translate(cx, gripY + 0.06, cz);
    parts.push(knuckle);
    const tip = slab(0.12, 0.17, 0.12, 0.05);
    tip.rotateZ(-Math.cos(angle) * 0.7);
    tip.rotateX(Math.sin(angle) * 0.7);
    tip.translate(cx * 0.55, gripY - 0.13, cz * 0.55);
    parts.push(tip);
  }
  return new THREE.Mesh(disposal.track(fuse(parts)), materials.shell);
};

export interface RacketParts {
  readonly handle: THREE.Mesh;
  readonly rim: THREE.Mesh;
  readonly face: THREE.Mesh;
  /** Empty object sitting exactly on the racket face, for FX anchoring. */
  readonly anchor: THREE.Object3D;
}

/**
 * The racket is deliberately collinear with the forearm: handle straight down
 * the bone axis, blade normal along it too. That keeps the face pointing at the
 * ball whatever the arm is doing, and lets the IK treat "forearm + racket" as a
 * single bone.
 *
 * Its size is derived from the paddle in `MatchRules`, so it always reads as the
 * emitter behind the neon slab rather than a second, contradictory paddle.
 */
export const buildRacket = (
  spec: RobotSpec,
  materials: RobotMaterials,
  rules: MatchRules,
  disposal: Disposal,
): RacketParts => {
  const reach = racketOffset(spec);
  const rx = rules.paddle.halfWidth * 0.58;
  const rz = rules.paddle.halfHeight * 0.6;

  const handleGeometry = disposal.track(
    fuse([
      new THREE.CylinderGeometry(0.09, 0.11, spec.handle, 8).translate(0, -spec.handle * 0.5, 0),
      new THREE.SphereGeometry(0.12, 10, 8).translate(0, -spec.handle * 0.04, 0),
      slab(0.2, 0.14, 0.2, 0.05).translate(0, -reach + 0.1, 0),
    ]),
  );
  const handle = new THREE.Mesh(handleGeometry, materials.shell);

  const rimGeometry = disposal.track(new THREE.TorusGeometry(1, 0.055, 6, 26));
  rimGeometry.rotateX(-Math.PI * 0.5);
  rimGeometry.scale(rx, 1, rz);
  rimGeometry.translate(0, -reach, 0);
  const rim = new THREE.Mesh(rimGeometry, materials.accent);

  const faceGeometry = disposal.track(new THREE.CircleGeometry(1, 26));
  faceGeometry.rotateX(-Math.PI * 0.5);
  faceGeometry.scale(rx * 0.94, 1, rz * 0.94);
  faceGeometry.translate(0, -reach, 0);
  const face = new THREE.Mesh(faceGeometry, materials.field);
  face.renderOrder = 3;

  const anchor = new THREE.Object3D();
  anchor.position.y = -reach;

  return { handle, rim, face, anchor };
};
