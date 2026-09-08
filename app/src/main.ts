import type { DifficultyId } from './domain/ai/difficulty';
import type { Side } from './domain/arena';
import type { PaddleIntent } from './domain/entities';
import type { DomainEvent } from './domain/events';
import type { MatchSnapshot } from './domain/match';
import { createRng, randomSeed } from './domain/rng';
import { GameLoop } from './application/game-loop';
import type { CameraMode, GameModeId, HudView, QualityLevel, UiIntent } from './application/ports';
import { CAMERA_MODES } from './application/ports';
import type { SessionStats } from './application/session';
import { EMPTY_STATS, GameSession, pointerIntent } from './application/session';
import { createWebAudio } from './infrastructure/audio/web-audio';
import { createRafClock } from './infrastructure/clock/raf-clock';
import { createBrowserInput } from './infrastructure/input/browser-input';
import { createThreeRenderer } from './infrastructure/render/three-renderer';
import { createLocalStorage } from './infrastructure/storage/local-storage';
import { createDomUi } from './ui/dom-ui';
import { createCommentary } from './ui/personality';
import './ui/styles.css';
import './ui/hud-3d.css';
import './ui/personality.css';

/**
 * Composition root.
 *
 * This is the only module in the project that is allowed to know about both the
 * pure game and the browser. Everything above it talks through the interfaces in
 * `application/ports.ts`, which is what makes the domain testable in Node and
 * the renderer replaceable without touching a line of game logic.
 */

const STATS_KEY = 'stats';
const PREFS_KEY = 'prefs';

interface Preferences {
  readonly difficulty: DifficultyId;
  readonly cameraMode: CameraMode;
  readonly muted: boolean;
}

const DEFAULT_PREFS: Preferences = { difficulty: 'pro', cameraMode: 'chase', muted: false };

const bootstrap = (): void => {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app container in index.html');

  const storage = createLocalStorage('neon-pong-3d');
  const prefs = { ...DEFAULT_PREFS, ...(storage.read<Preferences>(PREFS_KEY) ?? {}) };
  const stats = storage.read<SessionStats>(STATS_KEY) ?? EMPTY_STATS;

  const session = new GameSession(createRng(randomSeed()), { difficulty: prefs.difficulty });
  // A second, fully independent session drives the CPU-vs-CPU match that plays
  // behind the main menu. Reusing the same use-case keeps the attract mode free
  // of special cases inside the domain.
  const attract = new GameSession(createRng(randomSeed()), { difficulty: 'elite' });
  attract.start('demo', 'elite');
  session.setStats(stats);

  const renderer = createThreeRenderer();
  const audio = createWebAudio();
  const input = createBrowserInput({ target: root });
  const clock = createRafClock();
  const ui = createDomUi(root);
  const commentary = createCommentary(root);

  renderer.mount(root, session.arena, session.rules);
  renderer.setCameraMode(prefs.cameraMode);
  renderer.setPerspective('near');
  audio.setMuted(prefs.muted);

  let cameraMode: CameraMode = prefs.cameraMode;
  let quality: QualityLevel = 'high';
  let previous: MatchSnapshot = session.snapshot();
  let current: MatchSnapshot = previous;
  let lowFpsFor = 0;
  let highFpsFor = 0;

  const savePrefs = (): void => {
    storage.write<Preferences>(PREFS_KEY, {
      difficulty: session.difficulty,
      cameraMode,
      muted: audio.muted,
    });
  };

  const activeSession = (): GameSession => (session.screen === 'menu' ? attract : session);

  const cycleCamera = (): void => {
    const index = CAMERA_MODES.indexOf(cameraMode);
    cameraMode = CAMERA_MODES[(index + 1) % CAMERA_MODES.length] ?? 'chase';
    renderer.setCameraMode(cameraMode);
    savePrefs();
  };

  const startMatch = (mode: GameModeId, difficulty: DifficultyId): void => {
    audio.unlock();
    session.start(mode, difficulty);
    input.setLayout(mode === 'local-versus' ? 'versus' : 'single');
    renderer.setPerspective('near');
    previous = session.snapshot();
    current = previous;
    savePrefs();
  };

  const handleUiIntent = (intent: UiIntent): void => {
    switch (intent.type) {
      case 'start':
        startMatch(intent.mode, intent.difficulty as DifficultyId);
        break;
      case 'resume':
        session.resume();
        break;
      case 'pause':
        session.pause();
        break;
      case 'restart':
        session.restart();
        break;
      case 'quit-to-menu':
        commentary.clear();
        session.quitToMenu();
        storage.write<SessionStats>(STATS_KEY, session.currentStats);
        break;
      case 'cycle-camera':
        cycleCamera();
        break;
      case 'toggle-audio':
        audio.unlock();
        audio.setMuted(!audio.muted);
        savePrefs();
        break;
    }
  };

  ui.onIntent(handleUiIntent);

  // --- Frame-level input, sampled once and shared by every fixed step --------
  let frameIntents: Record<Side, PaddleIntent> = { near: { x: 0, y: 0 }, far: { x: 0, y: 0 } };

  const sampleInput = (): void => {
    const frame = input.sample();
    let near = frame.near;

    // Pointer steering is positional, so it is resolved against the live paddle.
    const target = input.pointerTarget;
    if (target && input.pointerActive && Math.abs(near.x) < 0.01 && Math.abs(near.y) < 0.01) {
      near = pointerIntent(
        session.arena,
        session.rules,
        session.snapshot().paddles.near,
        target,
      );
    }
    frameIntents = { near, far: frame.far };

    for (const action of frame.actions) {
      switch (action) {
        case 'pause':
          if (session.screen === 'playing' || session.screen === 'paused') session.togglePause();
          break;
        case 'restart':
          if (session.screen !== 'menu') session.restart();
          break;
        case 'back':
          if (session.screen !== 'menu') {
            session.quitToMenu();
            storage.write<SessionStats>(STATS_KEY, session.currentStats);
          }
          break;
        case 'cycle-camera':
          cycleCamera();
          break;
        case 'toggle-audio':
          audio.unlock();
          audio.setMuted(!audio.muted);
          savePrefs();
          break;
        case 'confirm':
          if (session.screen === 'paused') session.resume();
          else if (session.screen === 'over') session.restart();
          break;
      }
    }
  };

  const dispatch = (events: readonly DomainEvent[]): void => {
    if (events.length === 0) return;
    renderer.handleEvents(events);
    audio.handleEvents(events);
    const snapshot = session.snapshot();
    commentary.handleEvents(events, {
      rally: snapshot.rally,
      score: snapshot.score,
      speedRatio: Math.min(1, snapshot.ballSpeed / session.rules.ball.maxSpeed),
      difficulty: session.difficulty,
      mode: session.mode,
      playerLabels: session.labels,
      pointsToWin: session.rules.pointsToWin,
    });
    for (const event of events) {
      if (event.type === 'match-won') {
        storage.write<SessionStats>(STATS_KEY, session.currentStats);
      }
    }
  };

  /** Drops render quality when the frame budget is missed for long enough. */
  const adaptQuality = (delta: number): void => {
    const fps = renderer.fps;
    if (fps > 0 && fps < 46) {
      lowFpsFor += delta;
      highFpsFor = 0;
    } else if (fps > 57) {
      highFpsFor += delta;
      lowFpsFor = 0;
    }

    if (lowFpsFor > 2.5 && quality !== 'low') {
      quality = quality === 'high' ? 'medium' : 'low';
      renderer.setQuality(quality);
      lowFpsFor = 0;
    } else if (highFpsFor > 12 && quality !== 'high') {
      quality = quality === 'low' ? 'medium' : 'high';
      renderer.setQuality(quality);
      highFpsFor = 0;
    }
  };

  const loop = new GameLoop({
    update: (dt) => {
      const attractEvents = attract.step(dt, { near: { x: 0, y: 0 }, far: { x: 0, y: 0 } });
      if (session.screen === 'menu') {
        previous = current;
        current = attract.snapshot();
        // The attract match is silent scenery: only the renderer reacts to it.
        renderer.handleEvents(attractEvents);
        return;
      }

      previous = current;
      const events = session.step(dt, frameIntents);
      current = session.snapshot();
      dispatch(events);
    },
    render: (alpha, delta, elapsed) => {
      const live = activeSession();
      const snapshot = current;
      const dimmed = session.screen !== 'playing';

      renderer.render({ previous, current: snapshot, alpha, time: elapsed, delta, dimmed });

      // Ambient tension follows the rally length and the ball speed.
      const tension = Math.min(
        1,
        snapshot.rally / 12 + snapshot.ballSpeed / live.rules.ball.maxSpeed / 2,
      );
      audio.setIntensity(session.screen === 'playing' ? tension : 0);

      const view: HudView = {
        screen: session.screen,
        score: snapshot.score,
        labels: live.labels,
        rally: snapshot.rally,
        longestRally: Math.max(snapshot.longestRally, session.currentStats.bestRally),
        ballSpeed: snapshot.ballSpeed,
        pointsToWin: live.rules.pointsToWin,
        winner: snapshot.winner as Side | null,
        serveCountdown: snapshot.serveCountdown,
        fps: renderer.fps,
        muted: audio.muted,
        cameraMode,
      };
      ui.render(view);

      adaptQuality(delta);
    },
  });

  const resize = (): void => {
    const width = root.clientWidth || window.innerWidth;
    const height = root.clientHeight || window.innerHeight;
    renderer.resize(width, height, Math.min(window.devicePixelRatio, 2));
  };
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  // The window `resize` event misses container-only changes (a split pane, a
  // devtools dock, an embedded iframe), which leaves the canvas at a stale size.
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(root);

  // Never keep simulating a match nobody can see.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session.screen === 'playing') session.pause();
  });

  loop.start();
  clock.start((delta, elapsed) => {
    sampleInput();
    loop.frame(delta, elapsed);
  });

  window.addEventListener('beforeunload', () => {
    storage.write<SessionStats>(STATS_KEY, session.currentStats);
  });
};

bootstrap();
