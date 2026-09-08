#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process, { argv, exit } from 'node:process';

/**
 * Command-driven release pipeline for pong.naindev.com.
 *
 * GitHub Pages serves this repository's root on `main`, so "deploying" means
 * getting the built `index.html` + `assets/` onto `main`. This script does that
 * through a pull request rather than pushing to `main` directly, so every
 * release is reviewable and revertable from the GitHub UI.
 *
 *   node scripts/publish.mjs check     verify, build, and stage the artefacts
 *   node scripts/publish.mjs pr        the above, then push the branch and open a PR
 *   node scripts/publish.mjs merge     squash-merge the open PR for this branch
 *   node scripts/publish.mjs verify    confirm the live site serves this build
 *   node scripts/publish.mjs release   check -> pr -> merge -> verify, end to end
 *
 * `merge` and `release` publish to a public site, so they refuse to run unless
 * --yes is passed.
 */

const SITE = 'https://pong.naindev.com/';
const BASE = 'main';
const args = new Set(argv.slice(3));

/**
 * Local tools are invoked through `node` rather than through npm.
 *
 * npm ships as a `.cmd` shim on Windows, and since Node 20 `execFileSync` refuses
 * to spawn `.cmd` files without a shell. Calling the packages' own entry points
 * keeps every invocation shell-free, so no argument is ever re-parsed by a
 * command interpreter.
 */
const LOCAL = {
  tsc: 'node_modules/typescript/bin/tsc',
  vite: 'node_modules/vite/bin/vite.js',
  vitest: 'node_modules/vitest/vitest.mjs',
};
const command = argv[2] ?? 'check';
const confirmed = args.has('--yes');

const run = (file, params, options = {}) =>
  execFileSync(file, params, { encoding: 'utf8', stdio: 'pipe', shell: false, ...options }).trim();

const stream = (file, params) =>
  execFileSync(file, params, { stdio: 'inherit', shell: false });

const step = (message) => console.log(`\n\u001b[36m>\u001b[0m ${message}`);

const currentBranch = () => run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

const ensureNotBase = () => {
  const branch = currentBranch();
  if (branch === BASE) {
    console.error(
      `Refusing to run on ${BASE}. The whole point of this script is to reach ${BASE} through a PR.\n` +
        `Create a branch first:  git switch -c feat/my-change`,
    );
    exit(1);
  }
  return branch;
};

/** Typecheck, test and build. The build writes index.html + assets/ to the root. */
const check = () => {
  step('Typecheck');
  stream('node', [LOCAL.tsc, '--noEmit']);
  step('Tests');
  stream('node', [LOCAL.vitest, 'run']);
  step('Build (output goes to the repository root, which Pages serves)');
  stream('node', ['scripts/clean-assets.mjs']);
  stream('node', [LOCAL.vite, 'build']);

  const dirty = run('git', ['status', '--porcelain']);
  if (dirty.length > 0) {
    step('Committing build artefacts');
    stream('git', ['add', '-A']);
    stream('git', ['commit', '-m', 'build: refresh deployed bundle']);
  } else {
    console.log('  build output unchanged, nothing to commit');
  }
};

const openPr = () => {
  const branch = ensureNotBase();
  step(`Pushing ${branch}`);
  stream('git', ['push', '-u', 'origin', branch]);

  const existing = run('gh', ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number']);
  if (existing.length > 0) {
    console.log(`  PR #${existing} already open for this branch`);
    return existing;
  }

  step('Opening pull request');
  stream('gh', [
    'pr',
    'create',
    '--base',
    BASE,
    '--head',
    branch,
    '--title',
    'Pong Arcade 3D',
    '--body',
    `Deploys to ${SITE} once merged (GitHub Pages serves the repository root of \`${BASE}\`).\n\n` +
      '- [x] `npm run typecheck`\n- [x] `npm test`\n- [x] `npm run build`\n',
  ]);
  return run('gh', ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number']);
};

const merge = () => {
  if (!confirmed) {
    console.error('merge publishes to a public site. Re-run with --yes to confirm.');
    exit(1);
  }
  const branch = ensureNotBase();
  step(`Squash-merging the PR for ${branch} into ${BASE}`);
  stream('gh', ['pr', 'merge', '--squash', '--delete-branch']);
};

/** Confirms the live site is actually serving the bundle we just built. */
const verify = async () => {
  const expected = run('git', ['show', `origin/${BASE}:index.html`], { stdio: ['pipe', 'pipe', 'pipe'] })
    .match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  step(`Verifying ${SITE}`);
  for (let attempt = 1; attempt <= 20; attempt++) {
    const response = await fetch(SITE, { cache: 'no-store' }).catch(() => null);
    if (response?.ok) {
      const html = await response.text();
      if (expected === undefined || html.includes(expected)) {
        console.log(`  live and serving the current build (attempt ${attempt})`);
        return;
      }
      console.log(`  up, but still serving the previous build (attempt ${attempt}/20)`);
    } else {
      console.log(`  not reachable yet (attempt ${attempt}/20)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  console.error('Pages did not publish the new build in time. Check the Actions tab.');
  exit(1);
};

switch (command) {
  case 'check':
    check();
    break;
  case 'pr':
    check();
    openPr();
    break;
  case 'merge':
    merge();
    break;
  case 'verify':
    await verify();
    break;
  case 'release':
    if (!confirmed) {
      console.error('release publishes to a public site. Re-run with --yes to confirm.');
      exit(1);
    }
    check();
    openPr();
    merge();
    await verify();
    break;
  default:
    console.error(`Unknown command "${command}". Use: check | pr | merge | verify | release`);
    exit(1);
}
