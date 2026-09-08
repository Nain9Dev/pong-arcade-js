import * as THREE from 'three';

/**
 * Procedurally generated textures.
 *
 * The game ships as a single bundle with no binary assets, so every gradient,
 * halo and sprite used by the renderer is painted into an offscreen canvas at
 * mount time. They are tiny (64–128 px) and uploaded once.
 */

/**
 * A soft radial falloff, white in the centre and transparent at the rim.
 * Meshes tint it through `material.color`, so one texture serves every glow.
 *
 * `power` shapes the curve: higher values give a tighter, brighter core.
 */
export const createRadialGlowTexture = (size = 128, power = 2.4): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable for glow texture');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    gradient.addColorStop(t, `rgba(255,255,255,${(1 - t) ** power})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

/**
 * A vertical band that is opaque in the middle and fades at both ends — used
 * behind the paddles so their glow reads as a slab of light rather than a disc.
 */
export const createBandGlowTexture = (size = 128): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable for band texture');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1;
      const v = (y / (size - 1)) * 2 - 1;
      // Superellipse falloff: soft on both axes but flat across the middle.
      const d = Math.min(1, Math.hypot(u ** 3, v) ** 0.9);
      const alpha = Math.round(255 * (1 - d) ** 2.2);
      const offset = (y * size + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};
