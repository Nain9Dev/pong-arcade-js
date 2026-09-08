import * as THREE from 'three';

/**
 * Full-screen colour washes: the additive flash fired when a point is scored and
 * the dark veil that settles over the arena while a menu is open.
 *
 * Both are quads parented to the camera and resized to exactly cover the frustum,
 * which keeps them inside the scene — so the flash blooms like any other light
 * instead of being pasted on top of the image.
 */
export class ScreenOverlay {
  private readonly flashMaterial: THREE.MeshBasicMaterial;
  private readonly veilMaterial: THREE.MeshBasicMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly flash: THREE.Mesh;
  private readonly veil: THREE.Mesh;
  private readonly distance: number;

  private strength = 0;

  constructor(camera: THREE.PerspectiveCamera) {
    this.distance = camera.near * 2.5;
    this.geometry = new THREE.PlaneGeometry(1, 1);

    this.flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.flash = new THREE.Mesh(this.geometry, this.flashMaterial);
    this.flash.position.z = -this.distance;
    this.flash.renderOrder = 900;
    this.flash.visible = false;

    this.veilMaterial = new THREE.MeshBasicMaterial({
      color: 0x02030a,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.veil = new THREE.Mesh(this.geometry, this.veilMaterial);
    this.veil.position.z = -this.distance;
    this.veil.renderOrder = 901;
    this.veil.visible = false;

    camera.add(this.flash, this.veil);
  }

  /** Fires a flash of `color`; `strength` accumulates and then decays. */
  pulse(color: THREE.ColorRepresentation, strength: number): void {
    this.flashMaterial.color.set(color);
    this.strength = Math.min(1.2, this.strength + strength);
  }

  update(camera: THREE.PerspectiveCamera, dt: number, dim: number): void {
    this.strength *= Math.exp(-4.5 * dt);
    if (this.strength < 1e-3) this.strength = 0;

    const height = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * this.distance;
    const width = height * camera.aspect;
    this.flash.scale.set(width, height, 1);
    this.veil.scale.set(width, height, 1);

    this.flashMaterial.opacity = Math.min(1, this.strength);
    this.flash.visible = this.strength > 0;
    this.veilMaterial.opacity = dim * 0.42;
    this.veil.visible = dim > 1e-3;
  }

  dispose(): void {
    this.flash.removeFromParent();
    this.veil.removeFromParent();
    this.geometry.dispose();
    this.flashMaterial.dispose();
    this.veilMaterial.dispose();
  }
}
