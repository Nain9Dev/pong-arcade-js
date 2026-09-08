import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { Arena, Side } from '../../../domain/arena';
import type { MatchRules } from '../../../domain/rules';
import type { QualityLevel } from '../../../application/ports';
import { SIDE_THEME } from '../palette';

/**
 * The arena's signage kit and the jumbotron that hangs over the court.
 *
 * Two things live here because they are the same craft: turning text and numbers
 * into geometry without shipping a single byte of font or image data. The kit at
 * the top (procedural text strips, UV quads, placed boxes) is reused by
 * `stadium.ts` for banners and structure; the `Jumbotron` below is the scoreboard
 * itself, whose digits are seven real segments of extruded geometry rather than
 * glyphs painted into a texture — so they stay crisp at any distance and update
 * by toggling colours instead of repainting a canvas.
 */

// ---------------------------------------------------------------------------
// Build-time geometry helpers
// ---------------------------------------------------------------------------

/** A box translated into place, ready to be merged into a bigger part. */
export const placedBox = (
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return geometry;
};

/** A box rotated (X, then Y, then Z) and translated into place. */
export const orientedBox = (
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
): THREE.BufferGeometry => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  if (rx !== 0) geometry.rotateX(rx);
  if (ry !== 0) geometry.rotateY(ry);
  if (rz !== 0) geometry.rotateZ(rz);
  geometry.translate(x, y, z);
  return geometry;
};

/**
 * Merges the parts, disposes the sources and returns the single geometry.
 * Every structural part in the stadium is assembled this way so that a rib, a
 * truss module or a goal frame costs exactly one draw call.
 */
export const mergeAndDispose = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged;
};

/**
 * Adds an all-white `color` attribute.
 *
 * Three.js only multiplies `instanceColor` into the fragment when the material
 * declares `vertexColors`, and declaring it without the attribute leaves the
 * shader reading an unbound attribute (black). One white attribute makes
 * per-instance tinting work on a shared geometry.
 */
export const withWhiteVertexColors = (geometry: THREE.BufferGeometry): THREE.BufferGeometry => {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3).fill(1);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
};

// ---------------------------------------------------------------------------
// Procedural signage
// ---------------------------------------------------------------------------

/** One line of text baked into a horizontal band of the sign atlas. */
export interface SignRow {
  readonly text: string;
  /** Core colour of the glyphs. */
  readonly fill: string;
  /** Halo painted behind them, so the sign reads as neon rather than paint. */
  readonly glow: string;
}

const SIGN_FONT = '"Arial Black", "Segoe UI", system-ui, sans-serif';

/**
 * Paints every row into one square atlas. A single texture and a single
 * material then serve every banner and label in the arena.
 */
export const createSignTexture = (
  rows: readonly SignRow[],
  width = 512,
  rowHeight = 128,
): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, rows.length) * rowHeight;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable for sign texture');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxWidth = width * 0.88;
  rows.forEach((row, index) => {
    const centreY = index * rowHeight + rowHeight * 0.5;
    let size = rowHeight * 0.58;
    ctx.font = `900 ${size}px ${SIGN_FONT}`;
    const measured = ctx.measureText(row.text).width;
    if (measured > maxWidth) {
      size *= maxWidth / measured;
      ctx.font = `900 ${size}px ${SIGN_FONT}`;
    }
    // Two passes: a wide bloom in the glow colour, then a tight core on top.
    ctx.shadowColor = row.glow;
    ctx.shadowBlur = size * 0.6;
    ctx.fillStyle = row.glow;
    ctx.fillText(row.text, width * 0.5, centreY);
    ctx.shadowBlur = size * 0.2;
    ctx.fillStyle = row.fill;
    ctx.fillText(row.text, width * 0.5, centreY);
  });
  ctx.shadowBlur = 0;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
};

/** Vertical UV span of a row inside an atlas built by {@link createSignTexture}. */
export const signRowUv = (index: number, count: number): { v0: number; v1: number } => ({
  v0: 1 - (index + 1) / count,
  v1: 1 - index / count,
});

/** A quad whose UVs address one arbitrary rectangle of an atlas. */
export const createUvQuad = (
  width: number,
  height: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): THREE.BufferGeometry => {
  const geometry = new THREE.PlaneGeometry(width, height);
  const uv = geometry.getAttribute('uv');
  uv.setXY(0, u0, v1);
  uv.setXY(1, u1, v1);
  uv.setXY(2, u0, v0);
  uv.setXY(3, u1, v0);
  uv.needsUpdate = true;
  return geometry;
};

/** Faint horizontal banding that turns a flat panel into a hologram. */
const createScanlineTexture = (): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable for scanline texture');

  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(0, 0, 4, 64);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let y = 0; y < 64; y += 4) ctx.fillRect(0, y, 4, 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 9);
  texture.needsUpdate = true;
  return texture;
};

// ---------------------------------------------------------------------------
// Seven-segment display
// ---------------------------------------------------------------------------

/** Lit segments per digit, bit order `a b c d e f g`. */
const SEGMENT_MASKS: readonly number[] = [
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f,
];

/**
 * `[x, y, vertical]` per segment, in half-cell units.
 *
 *      aaa
 *     f   b
 *      ggg
 *     e   c
 *      ddd
 */
const SEGMENT_LAYOUT: readonly (readonly [number, number, boolean])[] = [
  [0, 1, false],
  [1, 0.5, true],
  [1, -0.5, true],
  [0, -1, false],
  [-1, -0.5, true],
  [-1, 0.5, true],
  [0, 0, false],
];

const SEGMENTS_PER_DIGIT = 7;
const DIGITS_PER_SCORE = 2;
const FACES = 2;
const INSTANCES_PER_SCORE = FACES * DIGITS_PER_SCORE * SEGMENTS_PER_DIGIT;

/** Instance tint of a lit segment; the material carries the side colour. */
const SEGMENT_ON = new THREE.Color(1, 1, 1);
/** An unlit segment stays visible as a dark ghost, like real arena hardware. */
const SEGMENT_OFF = new THREE.Color(0.055, 0.055, 0.07);
const WHITE = new THREE.Color(1, 1, 1);

/** Rows of the jumbotron's own sign atlas. */
const HEADER_ROW = 0;
const HOME_ROW = 1;
const AWAY_ROW = 2;
const TARGET_ROW = 3;
const SIGN_ROWS = 4;

/**
 * The holographic scoreboard hanging over the middle of the court.
 *
 * It is deliberately additive and depth-write free: the ball is opaque and drawn
 * first, so it always punches through the hologram instead of disappearing
 * behind it. Readability of the ball wins over decoration, and the jumbotron
 * still reads as a solid object thanks to its lit metal frame.
 */
export class Jumbotron {
  readonly object = new THREE.Group();

  private readonly digits: Readonly<Record<Side, THREE.InstancedMesh>>;
  private readonly digitMaterials: Readonly<Record<Side, THREE.MeshBasicMaterial>>;
  private readonly halfMaterials: Readonly<Record<Side, THREE.MeshBasicMaterial>>;
  private readonly baseColor: Readonly<Record<Side, THREE.Color>>;
  private readonly frameMaterial: THREE.MeshStandardMaterial;
  private readonly labelMaterial: THREE.MeshBasicMaterial;
  private readonly labels: THREE.Mesh;
  private readonly scanlines: THREE.Texture;
  private readonly disposables: { dispose(): void }[] = [];

  private readonly centreY: number;
  private readonly centreZ: number;
  private readonly tilt: number;
  private readonly bob: number;

  private readonly flash: Record<Side, number> = { near: 0, far: 0 };
  private punch = 0;
  private shownNear = -1;
  private shownFar = -1;

  constructor(arena: Arena, rules: MatchRules) {
    const unit = Math.min(arena.halfWidth, arena.halfHeight);
    const panelW = arena.halfWidth * 0.86;
    const panelH = arena.halfHeight * 0.46;
    const panelD = unit * 0.13;
    const frameBar = unit * 0.075;

    this.centreY = arena.halfHeight * 0.58;
    this.centreZ = arena.halfDepth * 0.1;
    // Tips the face down towards the near player, who sits below and behind it.
    this.tilt = -0.16;
    this.bob = arena.halfHeight * 0.018;

    this.object.position.set(0, this.centreY, this.centreZ);
    this.object.rotation.x = this.tilt;

    const digitH = panelH * 0.44;
    const digitW = digitH * 0.5;
    const digitsY = panelH * 0.08;
    const groupOffset = panelW * 0.26;

    // --- backing halves: the surfaces that flash when their side scores ------
    this.scanlines = createScanlineTexture();
    this.disposables.push(this.scanlines);

    const halfMaterials: Record<Side, THREE.MeshBasicMaterial> = {
      near: this.createHalfMaterial('near'),
      far: this.createHalfMaterial('far'),
    };
    this.halfMaterials = halfMaterials;

    for (const side of ['near', 'far'] as const) {
      const sign = side === 'near' ? -1 : 1;
      const parts: THREE.BufferGeometry[] = [];
      for (let face = 0; face < FACES; face++) {
        const quad = createUvQuad(panelW * 0.5, panelH, 0, 0, 1, 1);
        quad.translate(sign * panelW * 0.25, 0, panelD * 0.5);
        if (face === 1) quad.rotateY(Math.PI);
        parts.push(quad);
      }
      const geometry = mergeAndDispose(parts);
      this.disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, halfMaterials[side]);
      mesh.renderOrder = 3;
      this.object.add(mesh);
    }

    // --- frame, centre divider and ceiling mounts ---------------------------
    const frameParts: THREE.BufferGeometry[] = [];
    const outerW = panelW + frameBar * 2;
    const frameD = panelD + frameBar * 0.6;
    const topY = panelH * 0.5 + frameBar * 0.5;
    frameParts.push(placedBox(outerW, frameBar, frameD, 0, topY, 0));
    frameParts.push(placedBox(outerW, frameBar, frameD, 0, -topY, 0));
    frameParts.push(placedBox(frameBar, panelH, frameD, -(panelW + frameBar) * 0.5, 0, 0));
    frameParts.push(placedBox(frameBar, panelH, frameD, (panelW + frameBar) * 0.5, 0, 0));
    frameParts.push(placedBox(frameBar * 0.4, panelH * 0.82, panelD * 0.95, 0, 0, 0));
    // Stubby mounts that vanish into the ceiling, so it hangs instead of floats.
    const mountTop = arena.halfHeight - this.centreY + frameBar;
    const mountLen = Math.max(frameBar, mountTop - topY);
    for (const x of [-panelW * 0.3, panelW * 0.3]) {
      frameParts.push(placedBox(frameBar * 0.55, mountLen, frameBar * 0.55, x, topY + mountLen * 0.5, 0));
    }
    const frameGeometry = mergeAndDispose(frameParts);
    this.frameMaterial = new THREE.MeshStandardMaterial({
      color: 0x111a30,
      metalness: 0.72,
      roughness: 0.42,
      emissive: 0x0b1636,
      emissiveIntensity: 0.85,
    });
    this.disposables.push(frameGeometry, this.frameMaterial);
    this.object.add(new THREE.Mesh(frameGeometry, this.frameMaterial));

    // --- the digits ---------------------------------------------------------
    const segment = this.createSegmentGeometry(digitW, digitH);
    this.disposables.push(segment);

    const digitMaterials: Record<Side, THREE.MeshBasicMaterial> = {
      near: this.createDigitMaterial('near'),
      far: this.createDigitMaterial('far'),
    };
    this.digitMaterials = digitMaterials;
    this.baseColor = {
      near: new THREE.Color(SIDE_THEME.near.core),
      far: new THREE.Color(SIDE_THEME.far.core),
    };

    const faceMatrix = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const composed = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const unitScale = new THREE.Vector3(1, 1, 1);
    const zAxis = new THREE.Vector3(0, 0, 1);

    const meshes: Record<Side, THREE.InstancedMesh> = {
      near: new THREE.InstancedMesh(segment, digitMaterials.near, INSTANCES_PER_SCORE),
      far: new THREE.InstancedMesh(segment, digitMaterials.far, INSTANCES_PER_SCORE),
    };
    this.digits = meshes;

    for (const side of ['near', 'far'] as const) {
      const mesh = meshes[side];
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      // The home score sits left of the divider for whoever is looking, so the
      // far face is the same layout spun around: one rotation, no mirrored text.
      const groupX = side === 'near' ? -groupOffset : groupOffset;
      for (let face = 0; face < FACES; face++) {
        faceMatrix.makeRotationY(face === 0 ? 0 : Math.PI);
        for (let digit = 0; digit < DIGITS_PER_SCORE; digit++) {
          const digitX = groupX + (digit === 0 ? -1 : 1) * digitW * 0.68;
          for (let seg = 0; seg < SEGMENTS_PER_DIGIT; seg++) {
            const layout = SEGMENT_LAYOUT[seg];
            if (layout === undefined) continue;
            position.set(
              digitX + layout[0] * digitW * 0.5,
              digitsY + layout[1] * digitH * 0.5,
              panelD * 0.5 + digitW * 0.06,
            );
            rotation.setFromAxisAngle(zAxis, layout[2] ? Math.PI * 0.5 : 0);
            local.compose(position, rotation, unitScale);
            composed.multiplyMatrices(faceMatrix, local);
            mesh.setMatrixAt(
              face * DIGITS_PER_SCORE * SEGMENTS_PER_DIGIT + digit * SEGMENTS_PER_DIGIT + seg,
              composed,
            );
          }
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.object.add(mesh);
    }

    // --- labels -------------------------------------------------------------
    const signTexture = createSignTexture([
      { text: 'PONG ARCADE', fill: '#ffffff', glow: '#67e8f9' },
      { text: 'LOCAL', fill: '#ffffff', glow: '#22d3ee' },
      { text: 'VISITANTE', fill: '#ffffff', glow: '#f43f5e' },
      { text: `PRIMERO A ${rules.pointsToWin}`, fill: '#ffe9a6', glow: '#f59e0b' },
    ]);
    this.disposables.push(signTexture);
    this.labelMaterial = new THREE.MeshBasicMaterial({
      map: signTexture,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(this.labelMaterial);

    const labelParts: THREE.BufferGeometry[] = [];
    const addLabel = (row: number, x: number, y: number, w: number, h: number): void => {
      const { v0, v1 } = signRowUv(row, SIGN_ROWS);
      for (let face = 0; face < FACES; face++) {
        const quad = createUvQuad(w, h, 0, v0, 1, v1);
        quad.translate(x, y, panelD * 0.5 + digitW * 0.05);
        if (face === 1) quad.rotateY(Math.PI);
        labelParts.push(quad);
      }
    };
    addLabel(HEADER_ROW, 0, panelH * 0.4, panelW * 0.5, panelH * 0.14);
    addLabel(HOME_ROW, -groupOffset, -panelH * 0.28, panelW * 0.3, panelH * 0.13);
    addLabel(AWAY_ROW, groupOffset, -panelH * 0.28, panelW * 0.3, panelH * 0.13);
    addLabel(TARGET_ROW, 0, -panelH * 0.4, panelW * 0.28, panelH * 0.1);

    const labelGeometry = mergeAndDispose(labelParts);
    this.disposables.push(labelGeometry);
    this.labels = new THREE.Mesh(labelGeometry, this.labelMaterial);
    this.labels.renderOrder = 5;
    this.object.add(this.labels);

    this.setScore(0, 0);
  }

  /** Cheap: bails out unless the score actually moved. */
  setScore(near: number, far: number): void {
    if (near !== this.shownNear) {
      this.shownNear = near;
      this.applyDigits(this.digits.near, near);
    }
    if (far !== this.shownFar) {
      this.shownFar = far;
      this.applyDigits(this.digits.far, far);
    }
  }

  /** Flashes one half of the board and punches the whole thing up in scale. */
  celebrate(side: Side, strength: number): void {
    this.flash[side] = Math.min(1.6, this.flash[side] + strength);
    this.punch = Math.min(1.4, this.punch + strength);
  }

  update(time: number, dt: number, dim: number, reducedMotion: boolean): void {
    const motion = reducedMotion ? 0.2 : 1;
    const decay = reducedMotion ? 4.5 : 2.4;

    this.flash.near = Math.max(0, this.flash.near - dt * decay);
    this.flash.far = Math.max(0, this.flash.far - dt * decay);
    this.punch = Math.max(0, this.punch - dt * 3.4);

    // A springy overshoot on the punch is what makes a score land as a joke.
    const punchCurve = this.punch * Math.cos(this.punch * 7.5) * 0.14;
    this.object.scale.setScalar(1 + punchCurve);
    this.object.position.y = this.centreY + Math.sin(time * 0.7) * this.bob * motion;
    this.object.rotation.z = Math.sin(time * 0.53) * 0.014 * motion;

    const visible = 1 - dim * 0.72;
    this.scanlines.offset.y = (this.scanlines.offset.y - dt * 0.06 * motion) % 1;

    for (const side of ['near', 'far'] as const) {
      const glow = Math.min(1, this.flash[side]);
      this.digitMaterials[side].color.lerpColors(this.baseColor[side], WHITE, glow * 0.85);
      this.digitMaterials[side].opacity = (0.9 + glow * 0.1) * visible;
      this.halfMaterials[side].opacity = (0.1 + glow * 0.55) * visible;
    }

    this.frameMaterial.emissiveIntensity = 0.85 * visible;
    this.labelMaterial.opacity = 0.95 * visible;
  }

  setQuality(level: QualityLevel): void {
    // Text banners are the first thing to go: they are the only textured surface
    // on the board and the score itself is pure geometry.
    this.labels.visible = level !== 'low';
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }

  private applyDigits(mesh: THREE.InstancedMesh, value: number): void {
    const clamped = Math.max(0, Math.min(99, Math.round(value)));
    const tens = Math.floor(clamped / 10);
    const units = clamped % 10;
    for (let face = 0; face < FACES; face++) {
      for (let digit = 0; digit < DIGITS_PER_SCORE; digit++) {
        // A leading zero is blanked, the way stadium hardware does it.
        const shown = digit === 0 ? (tens > 0 ? tens : -1) : units;
        const mask = shown >= 0 ? SEGMENT_MASKS[shown] ?? 0 : 0;
        const base = face * DIGITS_PER_SCORE * SEGMENTS_PER_DIGIT + digit * SEGMENTS_PER_DIGIT;
        for (let seg = 0; seg < SEGMENTS_PER_DIGIT; seg++) {
          mesh.setColorAt(base + seg, (mask & (1 << seg)) !== 0 ? SEGMENT_ON : SEGMENT_OFF);
        }
      }
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  /**
   * One chamfered bar serves every segment.
   *
   * The digit cell is exactly twice as tall as it is wide, which makes the
   * horizontal and the vertical segments the same length — so a single geometry
   * covers all seven and the instances only ever rotate, never scale, and the
   * chamfer never stretches.
   */
  private createSegmentGeometry(digitW: number, digitH: number): THREE.BufferGeometry {
    // Horizontal segments span the cell width, vertical ones span half its
    // height; taking the minimum keeps a single bar correct for both.
    const span = Math.min(digitW, digitH * 0.5);
    const thickness = span * 0.16;
    const length = span - thickness * 1.15;
    const depth = thickness * 0.85;
    const chamfer = thickness * 0.5;
    const halfLength = length * 0.5;
    const halfThickness = thickness * 0.5;

    const shape = new THREE.Shape();
    shape.moveTo(-halfLength, 0);
    shape.lineTo(-halfLength + chamfer, halfThickness);
    shape.lineTo(halfLength - chamfer, halfThickness);
    shape.lineTo(halfLength, 0);
    shape.lineTo(halfLength - chamfer, -halfThickness);
    shape.lineTo(-halfLength + chamfer, -halfThickness);
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geometry.translate(0, 0, -depth * 0.5);
    // `digitH` only enters through the layout table, but asserting the ratio here
    // documents why one geometry is enough.
    geometry.scale(1, 1, digitH > 0 ? 1 : 1);
    return withWhiteVertexColors(geometry);
  }

  private createDigitMaterial(side: Side): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({
      color: SIDE_THEME[side].core,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(material);
    return material;
  }

  private createHalfMaterial(side: Side): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({
      map: this.scanlines,
      color: SIDE_THEME[side].core,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.disposables.push(material);
    return material;
  }
}
