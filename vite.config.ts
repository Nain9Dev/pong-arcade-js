import { defineConfig } from 'vite';

/**
 * GitHub Pages serves this repository's root directly (`main` branch, `/`), and
 * the `CNAME` file there binds it to pong.naindev.com. So the build must land in
 * the repository root: `index.html` + `assets/` next to `CNAME`.
 *
 * `base: './'` keeps every asset reference relative, so the same build also works
 * if the game is ever moved under a sub-path such as /demos/pong-arcade/.
 */
export default defineConfig({
  root: 'app',
  base: './',
  publicDir: false,
  build: {
    // Resolved from `root`, so this is the repository root.
    outDir: '..',
    // The repository root holds CNAME, README, sources — never wipe it.
    emptyOutDir: false,
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
