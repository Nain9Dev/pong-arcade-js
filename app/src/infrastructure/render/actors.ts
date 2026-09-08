import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { Side } from '../../domain/arena';
import { paddlePlaneZ, sideSign } from '../../domain/arena';
import type { Vec3 } from '../../domain/math/vec3';
import type { Arena } from '../../domain/arena';
import type { MatchRules } from '../../domain/rules';
import { PALETTE, SIDE_THEME } from './palette';

/**
 * The two moving actors of the game.
 *
 * Both own their meshes, lights and materials and dispose of them; the renderer
 * only feeds them interpolated state.
 */

/** A rounded neon slab with an outline and a soft glow panel behind it. */
export class PaddleVisual {
  readonly object = new THREE.Group();

  private readonly material: THREE.MeshStandardMaterial;
  private readonly outline: THREE.LineSegments;
  private readonly outlineMaterial: THREE.LineBasicMaterial;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private readonly light: THREE.PointLight;
  private readonly baseEmissive: number;
  private readonly disposables: { dispose(): void }[] = [];

  /** Impact flash in `[0, 1]`, decayed every frame. */
  private flash = 0;

  constructor(side: Side, arena: Arena, rules: MatchRules, glowTexture: THREE.Texture) {
    const theme = SIDE_THEME[side];
    const { halfWidth, halfHeight, thickness } = rules.paddle;
    const width = halfWidth * 2;
    const height = halfHeight * 2;
    const radius = Math.min(thickness * 0.4, halfWidth * 0.25, halfHeight * 0.25);

    const slab = new RoundedBoxGeometry(width, height, thickness, 3, radius);
    this.material = new THREE.MeshStandardMaterial({
      color: 0x0a1024,
      emissive: theme.core,
      emissiveIntensity: 1.35,
      metalness: 0.45,
      roughness: 0.25,
    });
    this.baseEmissive = this.material.emissiveIntensity;
    this.disposables.push(slab, this.material);
    this.object.add(new THREE.Mesh(slab, this.material));

    // A plain box gives a clean rectangular outline; edges extracted from the
    // rounded slab would trace every bevel facet instead.
    const outlineBox = new THREE.BoxGeometry(width, height, thickness);
    const edges = new THREE.EdgesGeometry(outlineBox);
    outlineBox.dispose();
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: theme.glow,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(edges, this.outlineMaterial);
    this.outline = new THREE.LineSegments(edges, this.outlineMaterial);
    this.outline.renderOrder = 2;
    this.object.add(this.outline);

    const sign = sideSign(side);
    const glowGeometry = new THREE.PlaneGeometry(width * 1.9, height * 2.1);
    this.glowMaterial = new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: theme.core,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.disposables.push(glowGeometry, this.glowMaterial);
    const glow = new THREE.Mesh(glowGeometry, this.glowMaterial);
    glow.position.z = sign * (thickness * 0.5 + 0.12);
    glow.renderOrder = 1;
    this.object.add(glow);

    this.light = new THREE.PointLight(theme.core, 12, arena.halfDepth * 0.9, 2);
    this.light.position.z = -sign * 1.2;
    this.object.add(this.light);

    this.object.position.z = sign * paddlePlaneZ(arena);
  }

  setPosition(x: number, y: number): void {
    this.object.position.x = x;
    this.object.position.y = y;
  }

  /** Called on a paddle hit; `strength` in `[0, 1]`. */
  pulse(strength: number): void {
    this.flash = Math.min(1.6, this.flash + strength);
  }

  update(dt: number, dim: number): void {
    this.flash *= Math.exp(-7 * dt);
    const fade = 1 - dim * 0.7;
    this.material.emissiveIntensity = (this.baseEmissive + this.flash * 3.2) * fade;
    this.outlineMaterial.opacity = Math.min(1, (0.9 + this.flash) * fade);
    this.glowMaterial.opacity = Math.min(1, (0.5 + this.flash * 0.8) * fade);
    this.light.intensity = (12 + this.flash * 55) * fade;
  }

  dispose(): void {
    this.light.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }
}

/** The ball: emissive shell, blown-out core, wireframe cage, halo and light. */
export class BallVisual {
  readonly object = new THREE.Group();

  private readonly spinner = new THREE.Group();
  private readonly shell: THREE.MeshStandardMaterial;
  private readonly cage: THREE.MeshBasicMaterial;
  private readonly halo: THREE.Sprite;
  private readonly haloMaterial: THREE.SpriteMaterial;
  private readonly light: THREE.PointLight;
  private readonly axis = new THREE.Vector3();
  private readonly tint = new THREE.Color();
  private readonly disposables: { dispose(): void }[] = [];

  private lightEnabled = false;

  constructor(radius: number, haloTexture: THREE.Texture) {
    const sphere = new THREE.SphereGeometry(radius, 24, 16);
    this.shell = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      emissive: PALETTE.ball,
      emissiveIntensity: 1.5,
      metalness: 0.2,
      roughness: 0.18,
    });
    this.disposables.push(sphere, this.shell);
    this.spinner.add(new THREE.Mesh(sphere, this.shell));

    const core = new THREE.SphereGeometry(radius * 0.55, 16, 12);
    const coreMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.ball, toneMapped: false });
    this.disposables.push(core, coreMaterial);
    this.spinner.add(new THREE.Mesh(core, coreMaterial));

    // The cage is what makes the spin readable — a smooth emissive sphere looks
    // identical no matter how fast it rotates.
    const cageGeometry = new THREE.SphereGeometry(radius * 1.04, 12, 8);
    this.cage = new THREE.MeshBasicMaterial({
      color: PALETTE.ballHalo,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(cageGeometry, this.cage);
    this.spinner.add(new THREE.Mesh(cageGeometry, this.cage));

    this.object.add(this.spinner);

    this.haloMaterial = new THREE.SpriteMaterial({
      map: haloTexture,
      color: PALETTE.ballHalo,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(this.haloMaterial);
    this.halo = new THREE.Sprite(this.haloMaterial);
    this.halo.scale.setScalar(radius * 8);
    this.object.add(this.halo);

    this.light = new THREE.PointLight(PALETTE.ballHalo, 0, radius * 60, 2);
  }

  setLightEnabled(enabled: boolean): void {
    if (enabled === this.lightEnabled) return;
    this.lightEnabled = enabled;
    if (enabled) this.object.add(this.light);
    else this.object.remove(this.light);
  }

  /** Rotates the mesh by the domain's angular velocity vector. */
  roll(spin: Vec3, dt: number): void {
    const magnitude = Math.hypot(spin.x, spin.y, spin.z);
    if (magnitude < 1e-4 || dt <= 0) return;
    this.axis.set(spin.x / magnitude, spin.y / magnitude, spin.z / magnitude);
    this.spinner.rotateOnWorldAxis(this.axis, magnitude * dt);
  }

  update(dim: number, speed01: number, color: THREE.ColorRepresentation): void {
    const fade = 1 - dim * 0.75;
    this.tint.set(color);
    this.haloMaterial.color.copy(this.tint);
    this.haloMaterial.opacity = (0.55 + speed01 * 0.35) * fade;
    this.cage.color.copy(this.tint);
    this.cage.opacity = (0.4 + speed01 * 0.3) * fade;
    this.shell.emissiveIntensity = (1.2 + speed01 * 1.4) * fade;
    if (this.lightEnabled) this.light.intensity = (24 + speed01 * 60) * fade;
  }

  dispose(): void {
    this.light.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }
}
