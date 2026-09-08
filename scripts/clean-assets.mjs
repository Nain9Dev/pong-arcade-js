import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Vite builds into the repository root with `emptyOutDir: false`, because that
 * directory also holds CNAME, the sources and the docs. Without this step the
 * hashed bundles from previous builds would pile up forever, so the asset folder
 * is the one thing we clear by hand before each build.
 */
const assets = fileURLToPath(new URL('../assets', import.meta.url));
await rm(assets, { recursive: true, force: true });
console.log('cleaned', assets);
