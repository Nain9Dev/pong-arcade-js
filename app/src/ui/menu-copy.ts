import type { GameModeId } from '../application/ports';
import type { Side } from '../domain/arena';
import type { DifficultyId } from '../domain/ai/difficulty';

/**
 * Every player-facing string of the front-end, in one typed object.
 *
 * The shell (`dom-ui.ts`) is a rendering machine: it should read copy, never own
 * it. Keeping the text here means a wording pass touches one file, a translation
 * layer has a single seam to replace, and nothing in `domain/` ever grows a
 * Spanish string.
 *
 * Two editorial rules hold every line together:
 *
 * 1. The copy is *truthful*. Every number and every claim about an opponent maps
 *    to a value in `domain/ai/difficulty.ts` or `domain/rules.ts` — a joke that
 *    lies about the game is a bug report waiting to happen. The comments name the
 *    field each line is derived from so a tuning change is easy to trace back.
 * 2. The copy is *useful*. A player reading only the difficulty descriptions must
 *    still be able to pick the right one; the humour rides on top of the
 *    information, it never replaces it.
 *
 * Language: the strings are Spanish because they are shown to the player. The
 * identifiers, types and comments are English like the rest of the repository.
 */

// --------------------------------------------------------------------------
// Shapes
// --------------------------------------------------------------------------

export interface ModeCopy {
  readonly id: GameModeId;
  /** Short label for the button face. */
  readonly label: string;
  /** One line telling the player what they are about to start. */
  readonly hint: string;
}

export interface DifficultyCopy {
  readonly id: DifficultyId;
  /** Playful display name, used instead of the neutral `AiProfile.label`. */
  readonly name: string;
  /** Three-to-five word hook shown next to the name. */
  readonly tagline: string;
  /** One line that still says what the opponent actually does. */
  readonly description: string;
  /** Optional flag for the button corner: recommended, warning… `null` for none. */
  readonly badge: string | null;
}

export interface RobotCopy {
  readonly name: string;
  readonly side: Side;
  /** Hex string matching `render/palette.ts` — for HUD accents, not for Three.js. */
  readonly color: string;
  /** One line of personality. */
  readonly personality: string;
  /** Something the robot would say while the arena loads. */
  readonly catchphrase: string;
}

export interface ControlCopy {
  /** Rendered inside a `<kbd>`; keep it short enough for a keycap. */
  readonly keys: string;
  readonly action: string;
}

export interface MenuCopy {
  /** First half of the marquee. The shell renders `title` + `titleAccent`. */
  readonly title: string;
  readonly titleAccent: string;
  readonly tagline: string;
  readonly sections: {
    readonly mode: string;
    readonly difficulty: string;
    readonly controls: string;
  };
  readonly actions: {
    readonly play: string;
    readonly resume: string;
    readonly restart: string;
    readonly rematch: string;
    readonly menu: string;
    readonly pause: string;
  };
  readonly modes: Readonly<Record<GameModeId, ModeCopy>>;
  readonly difficulties: Readonly<Record<DifficultyId, DifficultyCopy>>;
  /** Shown under the difficulty group when two humans make the AI irrelevant. */
  readonly difficultyLockedNote: string;
  readonly robots: Readonly<Record<Side, RobotCopy>>;
  readonly controls: readonly ControlCopy[];
  /** Label above a tip, e.g. on the serve countdown or a loading screen. */
  readonly tipLabel: string;
  readonly tips: readonly string[];
}

// --------------------------------------------------------------------------
// Copy
// --------------------------------------------------------------------------

export const MENU_COPY: MenuCopy = {
  title: 'PONG',
  titleAccent: '3D',
  // Magnus effect: `DEFAULT_BALL_RULES.spinForce`. The two robots are the
  // characters that flank the arena.
  tagline: 'El clásico de 1972, ahora con eje Z, efecto Magnus y dos robots que se llevan fatal.',

  sections: {
    mode: 'Modo de juego',
    difficulty: 'Dificultad',
    controls: 'Controles',
  },

  actions: {
    play: 'Jugar',
    resume: 'Reanudar',
    restart: 'Reiniciar',
    rematch: 'Revancha',
    menu: 'Menú',
    pause: 'Pausa',
  },

  modes: {
    single: {
      id: 'single',
      label: '1 jugador',
      // The human takes the near paddle; the AI plays 'far', which is Tornillo.
      hint: 'Tú llevas la pala cian contra Tornillo. Él calcula parábolas; tú tienes pulgares.',
    },
    'local-versus': {
      id: 'local-versus',
      label: '2 jugadores',
      // Bindings live in `infrastructure/input/browser-input.ts`.
      hint: 'Dos humanos y un teclado: WASD contra IJKL. Sin máquina a la que culpar.',
    },
    demo: {
      id: 'demo',
      label: 'Demo CPU vs CPU',
      // `GameSession.start('demo', difficulty)` honours the selected difficulty.
      hint: 'Chispa y Tornillo se pelean solos con la dificultad que elijas. Tú comentas la jugada.',
    },
  },

  difficulties: {
    rookie: {
      id: 'rookie',
      name: 'Becario',
      tagline: 'Voluntad sí, reflejos no.',
      // reactionDelay 0.26 s · aimError 1.3 · lapseChance 0.08 (~1 de cada 12).
      description:
        'Reacciona un cuarto de segundo tarde, apunta a ojo y una de cada doce bolas se queda mirando. El sitio donde aprender a medir la profundidad.',
      badge: null,
    },
    pro: {
      id: 'pro',
      name: 'Rival de barrio',
      tagline: 'El duelo justo.',
      // horizon 2.2 s · anticipation 0.78 · aggression 0.35 · lapseChance 0.06.
      description:
        'Lee dos segundos de trayectoria y ya busca ángulo con el borde de la pala. Falla lo justo para que ganarle signifique algo.',
      badge: 'Recomendado',
    },
    elite: {
      id: 'elite',
      name: 'Cabeza de serie',
      tagline: 'Ya sabe dónde va a botar.',
      // horizon 3.2 s · anticipation 0.92 · aggression 0.62 · aimError 0.45.
      description:
        'Ve tres segundos de futuro, cuenta los rebotes en la pared antes de que ocurran y castiga cualquier bola devuelta al centro.',
      badge: null,
    },
    singularity: {
      id: 'singularity',
      name: 'Singularidad',
      tagline: 'Suerte con eso.',
      // aimError 0.08 · lapseChance 0 · anticipation 1 · speedBlindness 0.34:
      // the only crack left is that speed steals the time to correct a read.
      description:
        'Resuelve la trayectoria entera, efecto incluido, y no se distrae nunca. Su única grieta es la velocidad: a tope no le da tiempo a corregir la lectura.',
      badge: 'Sin piedad',
    },
  },

  difficultyLockedNote:
    'En 2 jugadores no hay máquina a la que graduar: la dificultad se queda mirando.',

  robots: {
    near: {
      name: 'Chispa',
      side: 'near',
      color: '#22d3ee',
      personality:
        'Optimista incurable: celebra los puntos antes de ganarlos y alguna vez los pierde justo por eso.',
      catchphrase: '¡Esta la tengo! …casi seguro.',
    },
    far: {
      name: 'Tornillo',
      side: 'far',
      color: '#f43f5e',
      personality:
        'Metódico y un poco rencoroso: lleva la cuenta exacta de tus fallos y los comenta con la pared.',
      catchphrase: 'Fallo número catorce. Anotado.',
    },
  },

  // Mirrors `infrastructure/input/browser-input.ts` binding by binding.
  controls: [
    { keys: 'W A S D', action: 'Mueve la pala cian, la que tienes delante.' },
    { keys: 'I J K L', action: 'Mueve la pala magenta. Solo tiene dueño en 2 jugadores.' },
    { keys: '↑ ↓ ← →', action: 'La pala cercana cuando juegas solo; la lejana en 2 jugadores.' },
    { keys: 'Ratón', action: 'Control directo de la pala cercana: apuntas y ella va.' },
    { keys: 'Mando', action: 'Stick izquierdo. Con un solo mando, el derecho lleva la pala lejana.' },
    { keys: 'A · B · Start', action: 'Confirmar, volver atrás y pausar desde el mando.' },
    { keys: 'Espacio', action: 'Pausa y reanuda sin soltar la partida.' },
    { keys: 'Esc', action: 'Cierra la pausa; en plena partida te devuelve al menú.' },
    { keys: 'Enter', action: 'Confirma: reanuda en pausa, pide revancha al final.' },
    { keys: 'R', action: 'Reinicia el marcador sin pasar por el menú.' },
    { keys: 'C', action: 'Cambia de cámara: persecución, cabina y retransmisión.' },
    { keys: 'M', action: 'Silencia el audio. Vuelve a pulsarla cuando te arrepientas.' },
  ],

  tipLabel: 'Consejo',
  tips: [
    // rallyGain 1.075.
    'La bola acelera un 7,5 % en cada devolución. El rally no decide quién juega mejor, sino quién aguanta.',
    // deflection 0.8 · the strong profiles punish a centred return.
    'Golpea con el borde de la pala para abrir ángulo. Con el centro se la devuelves servida.',
    // spinTransfer 0.055 + spinForce 1.35 (Magnus).
    'Mueve la pala en el instante del impacto: le transfieres efecto y la bola se curva sola.',
    // pointsToWin 7 · winByTwo true.
    'Se gana a 7 puntos y con dos de ventaja. Aquí los empates se hacen largos.',
    // maxSpeed 140 over an arena 44 units deep.
    'A máxima velocidad la bola cruza la pista entera en medio segundo. Ahí ya no se mira: se adivina.',
    // Both paddles share `DEFAULT_PADDLE_RULES.maxSpeed`; difficulty is expressed
    // as human-like limitations, never as extra speed.
    'Tu pala y la suya corren exactamente igual de rápido. Lo único que cambia es cuánto se equivoca él.',
    // speedBlindness 0.34.
    'La Singularidad no falla, pero tampoco corrige: cuanto más rápida va la bola, más se compromete con su lectura.',
    // CAMERA_MODES in `application/ports.ts`.
    'Pulsa C en plena bola. La cámara de cabina no es cómoda, y precisamente por eso hay que probarla.',
    'Chispa sostiene que sus derrotas son decisiones artísticas.',
    'Nadie ha visto parpadear a Tornillo. Tampoco tiene párpados.',
  ],
};

/**
 * Deterministic tip picker.
 *
 * The rest of the game is seeded and reproducible, so the loading screen has no
 * business calling `Math.random()`: pass the serve number, the rally count or
 * anything else that already advances, and the same session replays identically.
 */
export const tipAt = (index: number): string => {
  const { tips } = MENU_COPY;
  if (tips.length === 0) return '';
  const wrapped = ((Math.trunc(index) % tips.length) + tips.length) % tips.length;
  return tips[wrapped] ?? '';
};
