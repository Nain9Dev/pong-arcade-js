import type {
  CameraMode,
  GameModeId,
  HudView,
  ScreenId,
  UiIntent,
  UiPort,
} from '../application/ports';
import type { DifficultyId } from '../domain/ai/difficulty';
import { AI_PROFILES, DIFFICULTY_ORDER } from '../domain/ai/difficulty';
import { el, focusablesIn, setClass, setFlag, setHidden, setText } from './dom';

/**
 * Arena units per second translated into a plausible-looking km/h. The arena has
 * no real-world scale, so this is pure flavour: it maps the 22..62 speed range
 * onto ~115..320 km/h, which reads like a table-tennis smash.
 */
const SPEED_TO_KMH = 5.2;

const CAMERA_LABELS: Readonly<Record<CameraMode, string>> = {
  chase: 'Persecución',
  cockpit: 'Cabina',
  broadcast: 'Retransmisión',
};

interface ModeOption {
  readonly id: GameModeId;
  readonly label: string;
  readonly hint: string;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  { id: 'single', label: '1 jugador', hint: 'Tú contra la máquina.' },
  { id: 'local-versus', label: '2 jugadores', hint: 'Dos humanos, un teclado.' },
  { id: 'demo', label: 'Demo CPU vs CPU', hint: 'La máquina juega sola.' },
];

/** Mirrors the bindings in `infrastructure/input/browser-input.ts`. */
const CONTROLS: readonly (readonly [string, string])[] = [
  ['W A S D', 'Pala cercana (cian)'],
  ['I J K L', 'Pala lejana (magenta)'],
  ['↑ ↓ ← →', 'Pala cercana a solas, lejana en 2 jugadores'],
  ['Ratón', 'Control directo de la pala cercana'],
  ['Mando', 'Stick izquierdo · A confirma · Start pausa'],
  ['Esc / Espacio', 'Pausa'],
  ['R', 'Reiniciar'],
  ['C', 'Cambiar cámara'],
  ['M', 'Silenciar'],
];

const DEFAULT_MODE: GameModeId = 'single';
const DEFAULT_DIFFICULTY: DifficultyId = 'pro';

const toKmh = (speed: number): number => Math.round(speed * SPEED_TO_KMH);

/**
 * Builds the whole presentation shell — menu, HUD and overlays — as a single
 * detached layer that is appended over the renderer canvas.
 *
 * The shell owns no game state: it renders whatever `HudView` it is handed and
 * reports player decisions back as `UiIntent`. The only state it does keep is
 * the pending menu selection, which has no meaning until "Jugar" is pressed.
 */
export const createDomUi = (root: HTMLElement): UiPort => {
  let handler: ((intent: UiIntent) => void) | null = null;
  const emit = (intent: UiIntent): void => {
    if (handler !== null) handler(intent);
  };

  let mode: GameModeId = DEFAULT_MODE;
  let difficulty: DifficultyId = DEFAULT_DIFFICULTY;
  let previous: HudView | null = null;
  let activeDialog: HTMLElement | null = null;
  let restoreTarget: HTMLElement | null = null;

  const layer = el('div', { class: 'ui', 'data-screen': 'menu' });

  // ---------------------------------------------------------------- HUD ----
  const nearName = el('span', { class: 'score__name' }, ['Cerca']);
  const nearValue = el('span', { class: 'score__value' }, ['0']);
  const farName = el('span', { class: 'score__name' }, ['Lejos']);
  const farValue = el('span', { class: 'score__value' }, ['0']);

  const scoreboard = el(
    'div',
    { class: 'score', 'aria-live': 'polite', 'aria-atomic': 'true' },
    [
      el('div', { class: 'score__side score__side--near' }, [nearName, nearValue]),
      el('span', { class: 'score__sep', 'aria-hidden': 'true' }, ['·']),
      el('div', { class: 'score__side score__side--far' }, [farName, farValue]),
    ],
  );

  const targetNote = el('p', { class: 'score__target' }, ['Primero a 7']);

  const rallyValue = el('span', { class: 'stat__value' }, ['0']);
  const speedValue = el('span', { class: 'stat__value' }, ['0']);
  const fpsValue = el('span', { class: 'stat__value' }, ['0']);

  const stat = (key: string, value: HTMLElement, unit?: string): HTMLElement =>
    el('div', { class: 'stat' }, [
      el('span', { class: 'stat__key' }, [key]),
      el(
        'span',
        { class: 'stat__figure' },
        unit === undefined ? [value] : [value, el('span', { class: 'stat__unit' }, [unit])],
      ),
    ]);

  const stats = el('div', { class: 'hud__stats' }, [
    stat('Rally', rallyValue),
    stat('Velocidad', speedValue, 'km/h'),
    stat('FPS', fpsValue),
  ]);

  const pauseButton = el('button', { type: 'button', class: 'chip chip--solo' }, ['Pausa']);
  pauseButton.addEventListener('click', () => emit({ type: 'pause' }));

  const cameraValue = el('span', { class: 'chip__value' }, [CAMERA_LABELS.chase]);
  const cameraButton = el('button', { type: 'button', class: 'chip' }, [
    el('span', { class: 'chip__key' }, ['Cámara']),
    cameraValue,
  ]);
  cameraButton.addEventListener('click', () => emit({ type: 'cycle-camera' }));

  const audioValue = el('span', { class: 'chip__value' }, ['Activo']);
  const audioButton = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, [
    el('span', { class: 'chip__key' }, ['Audio']),
    audioValue,
  ]);
  audioButton.addEventListener('click', () => emit({ type: 'toggle-audio' }));

  const serveValue = el('span', { class: 'serve__count' }, ['0']);
  // Updated several times per second; announcing it would flood a screen reader.
  const serveNotice = el('div', { class: 'serve', 'aria-hidden': 'true' }, [
    el('span', { class: 'serve__label' }, ['Saque en']),
    serveValue,
  ]);
  serveNotice.hidden = true;

  const hud = el('div', { class: 'hud' }, [
    el('div', { class: 'hud__top' }, [scoreboard, targetNote]),
    el('div', { class: 'hud__controls' }, [pauseButton, cameraButton, audioButton]),
    stats,
    serveNotice,
  ]);

  // --------------------------------------------------------------- Menu ----
  const modeButtons = new Map<GameModeId, HTMLButtonElement>();
  const modeGroup = el('div', {
    class: 'options options--modes',
    role: 'group',
    'aria-labelledby': 'ui-mode-title',
  });

  for (const option of MODE_OPTIONS) {
    const button = el('button', { type: 'button', class: 'option', 'aria-pressed': 'false' }, [
      el('span', { class: 'option__label' }, [option.label]),
      el('span', { class: 'option__hint' }, [option.hint]),
    ]);
    button.addEventListener('click', () => {
      mode = option.id;
      syncMenu();
    });
    modeButtons.set(option.id, button);
    modeGroup.append(button);
  }

  const difficultyButtons = new Map<DifficultyId, HTMLButtonElement>();
  const difficultyGroup = el('div', {
    class: 'options options--difficulty',
    role: 'group',
    'aria-labelledby': 'ui-difficulty-title',
  });

  for (const id of DIFFICULTY_ORDER) {
    const profile = AI_PROFILES[id];
    const button = el('button', { type: 'button', class: 'option', 'aria-pressed': 'false' }, [
      el('span', { class: 'option__label' }, [profile.label]),
      el('span', { class: 'option__hint' }, [profile.description]),
    ]);
    button.addEventListener('click', () => {
      difficulty = id;
      syncMenu();
    });
    difficultyButtons.set(id, button);
    difficultyGroup.append(button);
  }

  const difficultyNote = el('p', { class: 'menu__note' }, ['']);

  const playButton = el(
    'button',
    { type: 'button', class: 'button button--primary', 'data-autofocus': '' },
    ['Jugar'],
  );
  playButton.addEventListener('click', () => emit({ type: 'start', mode, difficulty }));

  const legend = el(
    'ul',
    { class: 'legend' },
    CONTROLS.map(([keys, description]) =>
      el('li', { class: 'legend__row' }, [
        el('kbd', { class: 'legend__keys' }, [keys]),
        el('span', { class: 'legend__text' }, [description]),
      ]),
    ),
  );

  const menuDialog = el(
    'section',
    {
      class: 'overlay overlay--menu',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'ui-menu-title',
    },
    [
      el('div', { class: 'overlay__panel' }, [
        el('header', { class: 'menu__head' }, [
          el('h1', { class: 'menu__title', id: 'ui-menu-title' }, [
            'PONG ',
            el('span', { class: 'menu__title-accent' }, ['3D']),
          ]),
          el('p', { class: 'menu__tagline' }, [
            'El clásico, pero con profundidad. Física continua y cuatro oponentes distintos.',
          ]),
        ]),
        el('div', { class: 'menu__section' }, [
          el('h2', { class: 'menu__label', id: 'ui-mode-title' }, ['Modo de juego']),
          modeGroup,
        ]),
        el('div', { class: 'menu__section' }, [
          el('h2', { class: 'menu__label', id: 'ui-difficulty-title' }, ['Dificultad']),
          difficultyGroup,
          difficultyNote,
        ]),
        el('div', { class: 'overlay__actions' }, [playButton]),
        el('div', { class: 'menu__section menu__section--legend' }, [
          el('h2', { class: 'menu__label' }, ['Controles']),
          legend,
        ]),
      ]),
    ],
  );

  // -------------------------------------------------------------- Paused ----
  const resumeButton = el(
    'button',
    { type: 'button', class: 'button button--primary', 'data-autofocus': '' },
    ['Reanudar'],
  );
  resumeButton.addEventListener('click', () => emit({ type: 'resume' }));

  const pausedRestart = el('button', { type: 'button', class: 'button' }, ['Reiniciar']);
  pausedRestart.addEventListener('click', () => emit({ type: 'restart' }));

  const pausedQuit = el('button', { type: 'button', class: 'button button--ghost' }, ['Menú']);
  pausedQuit.addEventListener('click', () => emit({ type: 'quit-to-menu' }));

  const pausedDialog = el(
    'section',
    {
      class: 'overlay overlay--compact',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'ui-paused-title',
    },
    [
      el('div', { class: 'overlay__panel' }, [
        el('h2', { class: 'overlay__title', id: 'ui-paused-title' }, ['Pausa']),
        el('p', { class: 'overlay__lead' }, ['La partida está congelada. Nadie ha ganado todavía.']),
        el('div', { class: 'overlay__actions' }, [resumeButton, pausedRestart, pausedQuit]),
      ]),
    ],
  );

  // ---------------------------------------------------------------- Over ----
  const overTitle = el('h2', { class: 'overlay__title', id: 'ui-over-title' }, ['Fin de la partida']);
  const overNearName = el('span', { class: 'score__name' }, ['Cerca']);
  const overNearValue = el('span', { class: 'score__value' }, ['0']);
  const overFarName = el('span', { class: 'score__name' }, ['Lejos']);
  const overFarValue = el('span', { class: 'score__value' }, ['0']);
  const overRally = el('span', { class: 'stat__value' }, ['0']);

  const rematchButton = el(
    'button',
    { type: 'button', class: 'button button--primary', 'data-autofocus': '' },
    ['Revancha'],
  );
  rematchButton.addEventListener('click', () => emit({ type: 'restart' }));

  const overQuit = el('button', { type: 'button', class: 'button button--ghost' }, ['Menú']);
  overQuit.addEventListener('click', () => emit({ type: 'quit-to-menu' }));

  const overDialog = el(
    'section',
    {
      class: 'overlay overlay--compact',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'ui-over-title',
    },
    [
      el('div', { class: 'overlay__panel' }, [
        overTitle,
        el('div', { class: 'score score--final' }, [
          el('div', { class: 'score__side score__side--near' }, [overNearName, overNearValue]),
          el('span', { class: 'score__sep', 'aria-hidden': 'true' }, ['·']),
          el('div', { class: 'score__side score__side--far' }, [overFarName, overFarValue]),
        ]),
        el('div', { class: 'overlay__stats' }, [stat('Rally más largo', overRally)]),
        el('div', { class: 'overlay__actions' }, [rematchButton, overQuit]),
      ]),
    ],
  );

  layer.append(hud, menuDialog, pausedDialog, overDialog);
  menuDialog.hidden = false;
  pausedDialog.hidden = true;
  overDialog.hidden = true;
  hud.hidden = true;

  // ------------------------------------------------------ Menu selection ----
  function syncMenu(): void {
    for (const [id, button] of modeButtons) setFlag(button, 'aria-pressed', id === mode);

    // Two humans means no AI at all, so the difficulty choice is inert.
    const aiDriven = mode !== 'local-versus';
    for (const [id, button] of difficultyButtons) {
      setFlag(button, 'aria-pressed', aiDriven && id === difficulty);
      button.disabled = !aiDriven;
    }
    setClass(difficultyGroup, 'options--off', !aiDriven);
    setText(
      difficultyNote,
      aiDriven
        ? AI_PROFILES[difficulty].description
        : 'En 2 jugadores no interviene la máquina: la dificultad no se aplica.',
    );
  }

  syncMenu();

  // --------------------------------------------------- Focus management ----
  const captureRestoreTarget = (): void => {
    const active = document.activeElement;
    restoreTarget =
      active instanceof HTMLElement && active !== document.body && !layer.contains(active)
        ? active
        : null;
  };

  const enterDialog = (dialog: HTMLElement): void => {
    if (activeDialog === null) captureRestoreTarget();
    const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
    const fallback = focusablesIn(dialog)[0] ?? null;
    (preferred ?? fallback)?.focus({ preventScroll: true });
  };

  const leaveDialogs = (): void => {
    // Focus must not stay on a menu button once play resumes: Space and Enter
    // are gameplay keys and would silently re-fire the button.
    const active = document.activeElement;
    if (active instanceof HTMLElement && layer.contains(active)) active.blur();
    const target = restoreTarget;
    restoreTarget = null;
    if (target !== null && target.isConnected) target.focus({ preventScroll: true });
  };

  const trapTab = (event: KeyboardEvent, dialog: HTMLElement): void => {
    const items = focusablesIn(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const inside = dialog.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const dialog = activeDialog;
    if (dialog === null) return;

    // A modal owns the keyboard: without this, WASD and the arrows would still
    // be steering the paddles behind the overlay.
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      if (dialog === pausedDialog) emit({ type: 'resume' });
      return;
    }
    if (event.key === 'Tab') trapTab(event, dialog);
  };

  layer.addEventListener('keydown', onKeyDown);

  const applyScreen = (screen: ScreenId): void => {
    layer.setAttribute('data-screen', screen);
    setHidden(hud, screen === 'menu' || screen === 'over');
    setHidden(menuDialog, screen !== 'menu');
    setHidden(pausedDialog, screen !== 'paused');
    setHidden(overDialog, screen !== 'over');

    const next =
      screen === 'menu'
        ? menuDialog
        : screen === 'paused'
          ? pausedDialog
          : screen === 'over'
            ? overDialog
            : null;

    // The HUD stays visible behind the pause overlay, so it must be taken out
    // of the tab order while the dialog is up.
    hud.toggleAttribute('inert', next !== null);

    if (next === activeDialog) return;
    if (next === null) leaveDialogs();
    else enterDialog(next);
    activeDialog = next;
  };

  // -------------------------------------------------------------- Render ----
  const render = (view: HudView): void => {
    const prev = previous;

    if (prev === null || prev.labels.near !== view.labels.near) {
      setText(nearName, view.labels.near);
      setText(overNearName, view.labels.near);
    }
    if (prev === null || prev.labels.far !== view.labels.far) {
      setText(farName, view.labels.far);
      setText(overFarName, view.labels.far);
    }
    if (prev === null || prev.score.near !== view.score.near) {
      const value = String(view.score.near);
      setText(nearValue, value);
      setText(overNearValue, value);
    }
    if (prev === null || prev.score.far !== view.score.far) {
      const value = String(view.score.far);
      setText(farValue, value);
      setText(overFarValue, value);
    }
    if (prev === null || prev.pointsToWin !== view.pointsToWin) {
      setText(targetNote, `Primero a ${view.pointsToWin}`);
    }
    if (prev === null || prev.rally !== view.rally) {
      setText(rallyValue, String(view.rally));
    }
    if (prev === null || prev.longestRally !== view.longestRally) {
      setText(overRally, String(view.longestRally));
    }
    if (prev === null || toKmh(prev.ballSpeed) !== toKmh(view.ballSpeed)) {
      setText(speedValue, String(toKmh(view.ballSpeed)));
    }
    if (prev === null || Math.round(prev.fps) !== Math.round(view.fps)) {
      setText(fpsValue, String(Math.round(view.fps)));
    }
    if (prev === null || prev.cameraMode !== view.cameraMode) {
      setText(cameraValue, CAMERA_LABELS[view.cameraMode]);
    }
    if (prev === null || prev.muted !== view.muted) {
      setFlag(audioButton, 'aria-pressed', view.muted);
      setText(audioValue, view.muted ? 'Silencio' : 'Activo');
    }

    const countdown = view.serveCountdown > 0 ? Math.max(1, Math.ceil(view.serveCountdown)) : 0;
    const previousCountdown =
      prev === null ? -1 : prev.serveCountdown > 0 ? Math.max(1, Math.ceil(prev.serveCountdown)) : 0;
    if (countdown !== previousCountdown) {
      setHidden(serveNotice, countdown === 0);
      if (countdown > 0) setText(serveValue, String(countdown));
    }

    if (prev === null || prev.winner !== view.winner) {
      setText(
        overTitle,
        view.winner === null
          ? 'Fin de la partida'
          : `¡Gana ${view.winner === 'near' ? view.labels.near : view.labels.far}!`,
      );
      setClass(overDialog, 'overlay--near', view.winner === 'near');
      setClass(overDialog, 'overlay--far', view.winner === 'far');
    }

    // Screen changes last, so an overlay is already showing final content when
    // focus moves into it and assistive tech reads the dialog.
    if (prev === null || prev.screen !== view.screen) applyScreen(view.screen);

    previous = view;
  };

  root.append(layer);
  applyScreen('menu');

  return {
    render,
    onIntent(next: (intent: UiIntent) => void): void {
      handler = next;
    },
    dispose(): void {
      layer.removeEventListener('keydown', onKeyDown);
      layer.remove();
      handler = null;
      previous = null;
      activeDialog = null;
      restoreTarget = null;
    },
  };
};
