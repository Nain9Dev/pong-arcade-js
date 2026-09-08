import type { GameModeId } from '../application/ports';
import type { DifficultyId } from '../domain/ai/difficulty';
import type { DomainEvent } from '../domain/events';
import { DEFAULT_MATCH_RULES } from '../domain/rules';
import { el, setHidden, setText } from './dom';
import './personality.css';

/**
 * The voice of the arena: colour commentary, opponent trash talk, rally hype and
 * medals.
 *
 * This layer is pure flavour built on top of the same `DomainEvent` stream the
 * renderer and the audio adapter consume. It owns no game state, decides nothing
 * and reads no physics: it is handed the events plus a small read-only context
 * and turns them into words. Removing the module removes jokes and nothing else.
 *
 * Three rules shape the whole implementation:
 *
 * 1. **One bubble at a time.** Commentary and taunts share a single queue, so
 *    two voices never talk over each other. Cues carry a priority; a much more
 *    important line cuts the current one short, an unimportant one is dropped
 *    rather than delayed into irrelevance.
 * 2. **No immediate repetition.** Every line lives in a pool and each pool
 *    remembers the index it used last, so the same joke never lands twice in a
 *    row.
 * 3. **Readable timing.** A cue stays on screen for a delay that scales with its
 *    length, clamped so a short line is never a flash and a long one never
 *    overstays the point it is commenting on.
 */

// ---------------------------------------------------------------- Contract --

export interface CommentaryContext {
  /** Hits in the current rally, mirroring `MatchSnapshot.rally`. */
  readonly rally: number;
  readonly score: { readonly near: number; readonly far: number };
  /** Ball speed over the rule set's maximum, in `[0, 1]`. */
  readonly speedRatio: number;
  readonly difficulty: DifficultyId;
  readonly mode: GameModeId;
  readonly playerLabels: { readonly near: string; readonly far: string };
  /**
   * Points needed to win, only used to detect match point. Defaults to the
   * standard rule set when the caller has no reason to override it.
   */
  readonly pointsToWin?: number;
}

export type MedalId =
  | 'first-point'
  | 'rally-15'
  | 'supersonic'
  | 'edge-artist'
  | 'match-point-saved'
  | 'shutout'
  | 'comeback';

export interface Medal {
  readonly id: MedalId;
  /** Single text glyph — no emoji, so it renders identically everywhere. */
  readonly glyph: string;
  readonly label: string;
  readonly note: string;
}

export const MEDALS: Readonly<Record<MedalId, Medal>> = {
  'first-point': {
    id: 'first-point',
    glyph: '★',
    label: 'Primer punto',
    note: 'El estreno oficial de la noche.',
  },
  'rally-15': {
    id: 'rally-15',
    glyph: '◆',
    label: 'Peloteo de quince',
    note: 'Quince golpes sin pestañear.',
  },
  supersonic: {
    id: 'supersonic',
    glyph: '»',
    label: 'Supersónico',
    note: 'La bola pasó el punto de no retorno.',
  },
  'edge-artist': {
    id: 'edge-artist',
    glyph: '▲',
    label: 'Filo de artista',
    note: 'Cinco devoluciones con el borde de la pala.',
  },
  'match-point-saved': {
    id: 'match-point-saved',
    glyph: '●',
    label: 'Salvado por los pelos',
    note: 'Punto de partido en contra, y sigues aquí.',
  },
  shutout: {
    id: 'shutout',
    glyph: '■',
    label: 'Puerta cerrada',
    note: 'Victoria sin encajar ni un punto.',
  },
  comeback: {
    id: 'comeback',
    glyph: '↺',
    label: 'Remontada',
    note: 'Ibas perdiendo por tres. Ya no.',
  },
};

export interface CommentaryModule {
  /** Called once per frame with the events of that frame; empty is free. */
  handleEvents(events: readonly DomainEvent[], ctx: CommentaryContext): void;
  /** Silences every bubble. Tracking (and therefore medals) keeps running. */
  setMuted(muted: boolean): void;
  /** Drops everything on screen and the pending queue. Match progress is kept. */
  clear(): void;
  dispose(): void;
  /** Replaces the medal listener. Fires once per medal, as it is earned. */
  onMedal(handler: (medal: Medal) => void): void;
  /** Every medal earned since the module was created, in order. */
  readonly earned: readonly MedalId[];
}

// -------------------------------------------------------------------- Copy --
//
// Pools are plain arrays so they read like a script instead of like code. Tokens
// in braces are filled in at draw time; only tokens that survive Spanish grammar
// in every mode are used — that is why "you scored" and "the opponent scored"
// are separate pools instead of one pool with a name in it.

const OPENERS: readonly string[] = [
  '¡Empieza el duelo! Que gane quien menos parpadee.',
  'Bola en juego. Respira hondo, que esto se pone bonito.',
  'Arranca la partida y las palas ya están calentitas.',
  'Señoras, señores: hay bola en la pista.',
  'Se abre el telón. Dentro neón.',
  'Primera bola de la noche. Que no se diga.',
  'Todo a cero, todo por decidir.',
  'Silencio en la grada... ¡y a jugar!',
  'La bola sale del centro con toda la ilusión del mundo.',
  'Empezamos. Prometo narrarlo todo, incluso lo feo.',
];

const RALLY_LONG: readonly string[] = [
  '¡{rally} golpes y ninguno se cansa!',
  '{rally} intercambios. Alguien tendrá que ceder.',
  'Llevamos {rally} y la bola sigue sin tocar el suelo. Tampoco es que haya suelo.',
  '¡{rally} idas y venidas! Esto ya no es un punto, es una relación.',
  'Peloteo de {rally}. La bola está pidiendo un descanso.',
  '{rally} golpes y el marcador empieza a aburrirse.',
  '¡{rally}! Y aquí seguimos, sin pestañear.',
  'A los {rally} golpes estos dos ya se conocen de toda la vida.',
  '{rally} veces ida y vuelta. Esa bola tiene más kilómetros que yo.',
  '¡{rally} golpes! Que alguien avise a mantenimiento.',
  'Van {rally}. La física empieza a mirar el reloj.',
  '{rally} y subiendo. Esto acabará en libro.',
];

const FAST_BALL: readonly string[] = [
  '¡Esa bola ya no vuela, se teletransporta!',
  'Va tan rápida que llega antes el susto que la bola.',
  '¡Menuda velocidad! Se le está rizando el neón.',
  'A esta velocidad la bola necesita carné.',
  '¡Va lanzada! Que alguien ponga un límite de ciento veinte.',
  'La bola ha decidido que hoy es su día.',
  '¡Uf! Eso ha pasado en dos fotogramas y medio.',
  'Esa bola va más rápida que una excusa.',
  '¡Acelerón! Aquí ya no se juega, se reacciona.',
  'Ha adelantado a la banda sonora por la derecha.',
  'A esa velocidad, parpadear es una decisión arriesgada.',
];

const EDGE_HIT: readonly string[] = [
  '¡Con el filo! Eso ha sido puro descaro.',
  'Tocada con el borde: milímetros de talento.',
  '¡Al canto! Y encima con ángulo.',
  'Devolución de esquina. Muy bonita, muy peligrosa.',
  'Ha entrado por el borde y ha salido con efecto.',
  '¡Filo puro! La pala ha llegado con una uña.',
  'Roce mínimo, ángulo máximo.',
  'Ha rozado la pala lo justo para presumir.',
  '¡Por la esquinita! Eso se ensaya, o se reza.',
  'Contacto en el borde: la bola sale con opinión propia.',
];

const CLOSE_MISS_NEAR: readonly string[] = [
  '¡Por un pelo! Un pelo muy fino, además.',
  'Le ha pasado rozando la pintura.',
  '¡Casi! Un centímetro más y lo cuentan los nietos.',
  'Se ha ido por nada. Por nadita.',
  'La bola ha esquivado la pala con muy mala idea.',
  '¡Uy! Eso ha dolido hasta a la cámara.',
  'Tan cerca que la pala ha notado el viento.',
  'Un suspiro. Un suspiro entero.',
  'Ha pasado tan cerca que se han saludado.',
  '¡Casi, casi, casi! Pero no.',
];

const CLOSE_MISS_FAR: readonly string[] = [
  'La ha rozado con la punta y se le ha escapado.',
  '¡No llega! Y mira que lo ha intentado.',
  'Se le ha ido por milímetros. Qué manera de sufrir.',
  '¡Uy, uy, uy! Eso ha entrado por la rendija.',
  'La pala ha llegado tarde por un fotograma.',
  'Ha estirado hasta donde le daba el chasis.',
  'Punto por la mínima, de los que se celebran dos veces.',
  'Casi la saca. Casi.',
  'Milímetros. La historia se escribe en milímetros.',
  'Ha pasado silbando junto a la pala.',
];

const POINT_NEAR: readonly string[] = [
  '¡Punto para ti, y con estilo!',
  '¡Ahí está! Eso se llama cerrar la jugada.',
  '¡Punto! La máquina se ha quedado pensando.',
  '¡Toma! Directo y sin preguntar.',
  'Punto tuyo. La grada digital enloquece.',
  '¡Buen punto! Ha entrado como en su casa.',
  '¡Dentro! Eso ha sido puntería. Y un poquito de suerte.',
  'Punto arriba. Sigue así y esto se pone interesante.',
  '¡Al fondo! La bola ha encontrado la puerta abierta.',
  'Punto para el humano. Que conste en acta.',
];

const POINT_FAR: readonly string[] = [
  'Punto para la máquina. Tampoco pasa nada.',
  'Se lleva el punto. Toca devolverle el favor.',
  'Punto de la CPU, que juega con ventaja: no tiene manos.',
  'Se apunta uno. Le habrá costado, seguro.',
  'Punto en contra. Respira. Otra vez dentro.',
  'La máquina suma. Nada que un buen resto no arregle.',
  'Punto para el otro lado. Detalle sin importancia.',
  'Ahí ha estado rápida, hay que concedérselo.',
  'Punto suyo. La revancha empieza en el saque.',
  'Uno para la máquina. Que lo disfrute mientras dure.',
];

const POINT_VERSUS: readonly string[] = [
  '¡Punto para {scorer}!',
  'Se lo lleva {scorer}, y con razón.',
  '¡Punto de {scorer}! El marcador cambia de humor.',
  '{scorer} suma. Esto se anima.',
  'Punto para {scorer}. Alguien va a querer venganza.',
  '¡Dentro! {scorer} lo celebra.',
  '{scorer} cierra el intercambio.',
  'Punto para {scorer}. Silencio en el otro lado.',
  '¡Ahí está! {scorer} no perdona.',
  'Se apunta {scorer}. La mesa se inclina.',
];

const MATCH_POINT: readonly string[] = [
  '¡Punto de partido! Se masca la tensión.',
  'Una bola. Solo una bola separa esto del final.',
  '¡Punto de partido! Que nadie mire el marcador.',
  'Estamos a un punto y las palas ya tiemblan.',
  '¡Bola de partido! Aquí se decide todo.',
  'Un punto. Uno. Ni más ni menos.',
  '¡Punto de partido! Si tuviera uñas, me las comía.',
  'La siguiente bola vale una partida entera.',
  '¡Bola de partido! O como decimos aquí: ay, madre.',
  'Un punto para el título. Sin presión, eh.',
];

const COMEBACK: readonly string[] = [
  '¡Ojo, que esto huele a remontada!',
  'Estaba fuera del partido y ha vuelto por la puerta grande.',
  '¡Vuelve al partido! Aquí nadie da nada por nadie.',
  'De estar lejos a estar cerquísima. Esto cambia.',
  '¡Se acerca! El marcador ya no se ríe tanto.',
  'Remontada en marcha. Que alguien lo grabe.',
  'La diferencia se derrite como el hielo en agosto.',
  '¡Punto a punto se está dando la vuelta a esto!',
  'Empezó de espaldas y ahora mira de frente.',
  'Esto ya no es una goleada: es un partido.',
];

const SHUTOUT_RUN: readonly string[] = [
  'El rival sigue a cero. Esa portería está cerrada con llave.',
  'Ni un punto para el otro lado. Qué crueldad tan bonita.',
  'Ese cero da un poco de pena y mucha envidia.',
  'Por aquí no pasa nadie, ni con cita previa.',
  'El otro lado del marcador está criando polvo.',
  'Puerta cerrada y cartel de completo.',
  'A este ritmo el cero se queda fijo en plantilla.',
  'Nadie ha marcado ahí enfrente. Nadie.',
  'El rival lleva toda la partida buscando el primer punto.',
  'Cero a la vista, y no se mueve.',
];

const SAVED: readonly string[] = [
  '¡Salvado! Tenía el partido en la mano y se le ha escapado.',
  '¡Anulada la bola de partido! Esto sigue vivo.',
  '¡Qué manera de aguantar! El partido continúa.',
  'Ha levantado un punto de partido con dos palas y mucha cara.',
  '¡Sigue en pie! No se lo esperaba nadie, ni él.',
  'Bola de partido salvada. El corazón, en la garganta.',
  '¡No, no, no! Esto no se acaba todavía.',
  'Ha dicho "aún no", y lo ha dicho con la pala.',
];

const WIN_NEAR: readonly string[] = [
  '¡Victoria! Que alguien traiga confeti de neón.',
  '¡Ganas! Y la máquina ya está pidiendo la revancha.',
  '¡Se acabó! Hoy manda el humano.',
  '¡Partido! Bien jugado, de verdad.',
  '¡Victoria limpia! A guardarla en la vitrina.',
  '¡Se cierra el partido y la arena entera lo ha visto!',
  '¡Ganador! Y casi sin despeinarse.',
  '¡Fin! Eso ha sido un partido con mayúsculas.',
];

const WIN_FAR: readonly string[] = [
  'Gana la máquina. Hoy tocaba; mañana ya veremos.',
  'Partido para el otro lado. Nos lo llevamos aprendido.',
  'Se acabó. La revancha está a un botón de distancia.',
  'Victoria de la CPU. Que disfrute su momento.',
  'Fin del partido. Buen intento, y van muchos.',
  'Gana el otro lado, pero la arena sigue aquí para la próxima.',
  'Cae el telón. Solo por esta vez.',
  'Partido perdido, orgullo intacto.',
];

const WIN_VERSUS: readonly string[] = [
  '¡Gana {winner}! Que se note.',
  'Partido para {winner}. Aplausos.',
  '¡{winner} se lleva el duelo!',
  'Fin del partido: manda {winner}.',
  '{winner} cierra la partida con autoridad.',
  '¡Victoria de {winner}! El teclado echa humo.',
  'Se acabó. {winner} lo celebra por todo lo alto.',
  'Gana {winner}. La revancha se pide con la mirada.',
];

/** What the opponent says after winning a point, by difficulty. */
const TAUNTS: Readonly<Record<DifficultyId, readonly string[]>> = {
  rookie: [
    'Perdona, no quería. Ha entrado sola.',
    'Ay. ¿Eso ha sido punto mío? Lo siento muchísimo.',
    'Estoy aprendiendo, ten paciencia conmigo.',
    'Creo que le he dado con el borde. ¿Vale igual?',
    'No sé qué he hecho, pero lo repito si funciona.',
    'Perdón, perdón, me he emocionado.',
    'Tú juegas muy bien. Yo hago lo que puedo.',
    '¿Podemos repetir ese punto? Es broma. ¿O no?',
    'Me dijeron que hay que darle a la bola. Voy mejorando.',
    'Uy. Otra vez. Qué vergüenza.',
  ],
  pro: [
    'Buen punto antes. Este es mío.',
    'Vale, ya te tengo leído. Ahora empieza lo bueno.',
    'Me gusta este partido. Súbelo un poco.',
    'Ese ángulo lo tenía fichado desde el saque.',
    'Vas bien. Yo también, mira qué casualidad.',
    'Cambio de plan: ahora todo al otro lado.',
    'No bajes el brazo, que esto acaba de empezar.',
    'Te aviso: la siguiente va cruzada.',
    'Bonito intercambio. Otro igual y me convences.',
    'Buena defensa. Insisto por arriba.',
  ],
  elite: [
    'Ese rebote lo calculé hace tres segundos.',
    'Te dejo el centro a propósito. Es una trampa.',
    'Devolví la bola antes de que decidieras el tiro.',
    'Interesante: repites el mismo ángulo cada cuatro golpes.',
    'La pared me obedece. Lo has visto tú también.',
    'Podría ponerlo más difícil. Todavía no hace falta.',
    'Tu muñeca me lo cuenta todo antes del golpe.',
    'Esa esquina llevaba tu nombre desde el saque.',
    'Buen tiro. Lo he devuelto con medio brazo.',
    'Ahórrate el efecto: lo veo venir en el giro.',
  ],
  singularity: [
    'No es personal. Es aritmética.',
    'He simulado este punto once mil veces. En tres te iba mejor.',
    'Tranquilo: la derrota también es un dato valioso.',
    'Tu trayectoria era preciosa. Y predecible.',
    'Admiro tu insistencia. La documentaré con cariño.',
    'Decidí el resultado en el saque. Sigue jugando, es bonito.',
    'La bola y yo tenemos un acuerdo. Aún no estás invitado.',
    'Te concedo el siguiente. Necesito la variable.',
    'Existe un universo en el que ganas. Lo he visitado. Es agradable.',
    'Mi paciencia es infinita. Tu partida, no.',
  ],
};

/** What the opponent says after conceding a point, by difficulty. */
const RESPECT: Readonly<Record<DifficultyId, readonly string[]>> = {
  rookie: [
    'Buen punto. Yo me quedé mirando la bola.',
    '¡Qué bonito! Lo apunto para copiarlo.',
    'Ni la vi. Enhorabuena, de verdad.',
    'Ese ha sido mérito tuyo. Yo estaba a mis cosas.',
    'Vale, ese lo he hecho fatal. Perdón.',
    'Me has pillado con la pala fría.',
    'Te lo mereces. Yo sigo intentándolo.',
    'Ahora entiendo cómo se hace. Creo.',
  ],
  pro: [
    'Buen punto. Ya sabía que ibas a cruzarla.',
    'Concedido. El siguiente es mío.',
    'Bien jugado. Ajusto y volvemos.',
    'Ese lo has ganado tú, sin excusas.',
    'Buena mano. Subo un punto la intensidad.',
    'Me has movido de sitio. Reconocido.',
    'Punto justo. Repítelo si puedes.',
    'Anotado. Eso no cae dos veces.',
  ],
  elite: [
    'Interesante. No estaba en mi lista.',
    'Correcto. He tardado once milisegundos de más.',
    'Un fallo mío. Ya está corregido.',
    'Buen tiro. Lo archivo para no repetirlo.',
    'Ese ángulo era el bueno. Enhorabuena.',
    'Aceptable. Muy aceptable.',
    'Me has sacado del guion. Dura poco.',
    'Bien. Ahora juego en serio.',
  ],
  singularity: [
    'Precioso. Lo guardaré en la memoria a largo plazo.',
    'Un punto tuyo. El universo lo permite de vez en cuando.',
    'Has encontrado la única trayectoria posible. Bravo.',
    'Concedido con elegancia. La mía.',
    'Estadísticamente improbable. Estéticamente impecable.',
    'Ese punto era tuyo desde el principio. Lo dejé ahí.',
    'Disfrútalo: es un momento bonito y breve.',
    'Bien hecho. Añado tu nombre al informe.',
  ],
};

interface HypeTier {
  readonly at: number;
  readonly label: string;
}

/** Escalating labels for the rally counter. Ordered from low to high. */
const HYPE_TIERS: readonly HypeTier[] = [
  { at: 4, label: 'calentando' },
  { at: 7, label: 'esto promete' },
  { at: 10, label: 'esto ya es serio' },
  { at: 14, label: 'que alguien lo pare' },
  { at: 18, label: 'modo leyenda' },
  { at: 22, label: '¿pero esto qué es?' },
  { at: 28, label: 'ya es filosofía' },
  { at: 36, label: 'he perdido la cuenta' },
];

// ---------------------------------------------------------------- Tuning ----

/** Priorities: a cue only interrupts one that is at least two steps below it. */
const P_CHATTER = 1;
const P_FLAVOUR = 2;
const P_NOTABLE = 3;
const P_POINT = 4;
const P_TENSION = 5;
const P_CLOSER = 6;
const P_FINAL = 7;

/** Rally lengths worth a line. Anything longer is handled by `RALLY_STEP`. */
const RALLY_BEATS: readonly number[] = [8, 12, 16, 20, 25, 30];
const RALLY_STEP = 10;

/** Speed ratios that each trigger one "the ball is flying" line per rally. */
const SPEED_BEATS: readonly number[] = [0.3, 0.45, 0.62, 0.8];

const WHISKER = 0.75;
const SUPERSONIC_RATIO = 0.7;
const EDGE_MEDAL_HITS = 5;
const COMEBACK_DEFICIT = 3;

const READ_BASE_MS = 1700;
const READ_PER_CHAR_MS = 42;
const READ_MAX_MS = 5400;
const MIN_VISIBLE_MS = 650;
const EXIT_MS = 240;
const GAP_MS = 180;
const CHATTER_COOLDOWN_MS = 2600;
const TAUNT_COOLDOWN_MS = 11000;
const MEDAL_MS = 2900;
const QUEUE_LIMIT = 2;

type Phase = 'idle' | 'showing' | 'leaving' | 'gap';

interface Cue {
  readonly channel: 'say' | 'taunt';
  readonly text: string;
  /** Speaker name for the taunt bubble; empty for the announcer. */
  readonly who: string;
  readonly mood: DifficultyId | null;
  readonly priority: number;
}

const clampMs = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const chance = (probability: number): boolean => Math.random() < probability;

/**
 * True when the side holding `points` wins the match with the next point, under
 * the win-by-two rule the default rule set uses.
 */
const isMatchPoint = (points: number, rival: number, target: number): boolean =>
  points + 1 >= target && points + 1 - rival >= 2;

// ------------------------------------------------------------------ Module --

export const createCommentary = (root: HTMLElement): CommentaryModule => {
  // --- Structure ------------------------------------------------------------
  // Built once and reused for the whole session: showing a line only writes
  // `textContent` and toggles a class, never touches the tree.

  const sayLine = el('p', { class: 'pers__line' });
  const sayBubble = el('div', { class: 'pers__bubble pers__bubble--say' }, [sayLine]);
  const say = el('div', { class: 'pers__slot pers__slot--say', 'aria-hidden': 'true' }, [
    sayBubble,
  ]);

  const tauntWho = el('span', { class: 'pers__who' });
  const tauntLine = el('p', { class: 'pers__line' });
  const tauntBubble = el('div', { class: 'pers__bubble pers__bubble--taunt' }, [
    tauntWho,
    tauntLine,
  ]);
  const taunt = el('div', { class: 'pers__slot pers__slot--taunt', 'aria-hidden': 'true' }, [
    tauntBubble,
  ]);

  const hypeCount = el('span', { class: 'pers__hype-count' }, ['0']);
  const hypeLabel = el('span', { class: 'pers__hype-label' });
  const hype = el('div', { class: 'pers__hype', 'aria-hidden': 'true' }, [hypeCount, hypeLabel]);

  const medalGlyph = el('span', { class: 'pers__medal-glyph', 'aria-hidden': 'true' });
  const medalLabel = el('span', { class: 'pers__medal-label' });
  const medalNote = el('span', { class: 'pers__medal-note' });
  // The only part of this layer exposed to assistive tech: the rest duplicates
  // information the HUD already announces, and would only add noise.
  const medalCard = el('div', { class: 'pers__medal', role: 'status' }, [
    medalGlyph,
    el('span', { class: 'pers__medal-text' }, [medalLabel, medalNote]),
  ]);

  const stack = el('div', { class: 'pers__stack' }, [medalCard, say]);
  const layer = el('div', { class: 'pers' }, [taunt, hype, stack]);

  setHidden(say, true);
  setHidden(taunt, true);
  setHidden(hype, true);
  setHidden(medalCard, true);

  // --- State ----------------------------------------------------------------

  /** Last index drawn from each pool, so a line never repeats back to back. */
  const lastIndex = new Map<readonly string[], number>();
  const queue: Cue[] = [];
  const earnedMedals: MedalId[] = [];
  const medalQueue: Medal[] = [];
  const matchMedals = new Set<MedalId>();

  let medalHandler: ((medal: Medal) => void) | null = null;
  let muted = false;
  let disposed = false;

  let phase: Phase = 'idle';
  let active: Cue | null = null;
  let shownAt = 0;
  // Seeded so the very first line of a session is never eaten by a cooldown:
  // `performance.now()` is already well past zero by the time a match starts.
  let lastCueAt = Number.NEGATIVE_INFINITY;
  let lastTauntAt = Number.NEGATIVE_INFINITY;
  let bubbleTimer: number | null = null;
  let medalTimer: number | null = null;
  let medalBusy = false;
  let animFlip = false;

  // Per-match tracking. Reset on the opening serve of every match.
  let speedBeat = 0;
  let nextRallyBeat = 0;
  let edgeHits = 0;
  let deficit = 0;
  let comebackCalled = false;
  let farMatchPoint = false;
  /** Which sides were on match point last time we said so: '', 'n', 'f' or 'nf'. */
  let matchPointKey = '';
  let hypeTier = -1;

  // --- Pools ----------------------------------------------------------------

  const draw = (pool: readonly string[]): string => {
    const count = pool.length;
    if (count === 0) return '';
    let index = Math.floor(Math.random() * count);
    if (index >= count) index = count - 1;
    if (count > 1 && index === lastIndex.get(pool)) index = (index + 1) % count;
    lastIndex.set(pool, index);
    return pool[index] ?? '';
  };

  const format = (line: string, tokens: Readonly<Record<string, string>>): string =>
    line.replace(/\{(\w+)\}/g, (whole: string, key: string) => tokens[key] ?? whole);

  // --- Animation ------------------------------------------------------------
  //
  // Entry and exit come in two identically-keyframed variants. Alternating
  // between them restarts the animation without the classic
  // `remove class → force reflow → add class` dance, which would trash layout
  // in the middle of a frame.

  const animate = (node: HTMLElement, kind: 'in' | 'out'): void => {
    animFlip = !animFlip;
    const variant = animFlip ? 'a' : 'b';
    node.classList.remove('is-in-a', 'is-in-b', 'is-out-a', 'is-out-b');
    node.classList.add(`is-${kind}-${variant}`);
  };

  const stopTimer = (handle: number | null): null => {
    if (handle !== null) window.clearTimeout(handle);
    return null;
  };

  // --- Bubble queue ---------------------------------------------------------

  const readMs = (text: string): number =>
    clampMs(READ_BASE_MS + text.length * READ_PER_CHAR_MS, READ_BASE_MS, READ_MAX_MS);

  const slotFor = (cue: Cue): HTMLElement => (cue.channel === 'taunt' ? taunt : say);

  const finishGap = (): void => {
    phase = 'idle';
    pump();
  };

  const afterExit = (): void => {
    if (active !== null) setHidden(slotFor(active), true);
    active = null;
    phase = 'gap';
    bubbleTimer = window.setTimeout(finishGap, GAP_MS);
  };

  const startExit = (): void => {
    bubbleTimer = stopTimer(bubbleTimer);
    if (active === null) {
      phase = 'idle';
      return;
    }
    phase = 'leaving';
    animate(slotFor(active), 'out');
    bubbleTimer = window.setTimeout(afterExit, EXIT_MS);
  };

  const show = (cue: Cue): void => {
    active = cue;
    phase = 'showing';
    shownAt = performance.now();
    lastCueAt = shownAt;

    if (cue.channel === 'taunt') {
      setText(tauntWho, cue.who);
      setText(tauntLine, cue.text);
      tauntBubble.dataset['mood'] = cue.mood ?? 'pro';
      setHidden(say, true);
      setHidden(taunt, false);
      animate(taunt, 'in');
    } else {
      setText(sayLine, cue.text);
      setHidden(taunt, true);
      setHidden(say, false);
      animate(say, 'in');
    }

    bubbleTimer = window.setTimeout(startExit, readMs(cue.text));
  };

  function pump(): void {
    if (disposed || muted || phase !== 'idle') return;
    const next = queue.shift();
    if (next !== undefined) show(next);
  }

  const enqueue = (cue: Cue): void => {
    if (disposed || muted || cue.text === '') return;

    const now = performance.now();
    // Small talk only when the arena has been quiet for a moment; otherwise the
    // box turns into a wall of text nobody reads.
    if (cue.priority <= P_FLAVOUR && now - lastCueAt < CHATTER_COOLDOWN_MS) return;
    if (cue.priority <= P_CHATTER && (phase !== 'idle' || queue.length > 0)) return;

    if (queue.length >= QUEUE_LIMIT) {
      let weakest = 0;
      for (let i = 1; i < queue.length; i += 1) {
        const candidate = queue[i];
        const current = queue[weakest];
        if (candidate !== undefined && current !== undefined && candidate.priority < current.priority) {
          weakest = i;
        }
      }
      const current = queue[weakest];
      if (current === undefined || current.priority >= cue.priority) return;
      queue.splice(weakest, 1);
    }

    queue.push(cue);

    // A far more important line cuts the current one short, once it has been on
    // screen long enough to have been read.
    if (
      phase === 'showing' &&
      active !== null &&
      cue.priority >= active.priority + 2 &&
      now - shownAt >= MIN_VISIBLE_MS
    ) {
      startExit();
      return;
    }
    pump();
  };

  const announce = (pool: readonly string[], priority: number, tokens?: Record<string, string>): void => {
    const line = tokens === undefined ? draw(pool) : format(draw(pool), tokens);
    enqueue({ channel: 'say', text: line, who: '', mood: null, priority });
  };

  const speakOpponent = (
    pool: readonly string[],
    ctx: CommentaryContext,
    priority: number,
  ): void => {
    lastTauntAt = performance.now();
    enqueue({
      channel: 'taunt',
      text: draw(pool),
      who: ctx.playerLabels.far,
      mood: ctx.difficulty,
      priority,
    });
  };

  // --- Medals ---------------------------------------------------------------

  const nextMedal = (): void => {
    const medal = medalQueue.shift();
    if (medal === undefined) {
      medalBusy = false;
      return;
    }
    medalBusy = true;
    setText(medalGlyph, medal.glyph);
    setText(medalLabel, medal.label);
    setText(medalNote, medal.note);
    medalCard.dataset['medal'] = medal.id;
    setHidden(medalCard, false);
    animate(medalCard, 'in');
    medalTimer = window.setTimeout(() => {
      animate(medalCard, 'out');
      medalTimer = window.setTimeout(() => {
        setHidden(medalCard, true);
        nextMedal();
      }, EXIT_MS);
    }, MEDAL_MS);
  };

  const award = (id: MedalId): void => {
    if (matchMedals.has(id)) return;
    matchMedals.add(id);
    const medal = MEDALS[id];
    earnedMedals.push(id);
    // The listener fires even while muted: persistence is the integrator's
    // business, and a silenced commentator is not a reason to lose a trophy.
    if (medalHandler !== null) medalHandler(medal);
    if (muted || disposed) return;
    medalQueue.push(medal);
    if (!medalBusy) nextMedal();
  };

  // --- Rally hype -----------------------------------------------------------

  const showHype = (rally: number): void => {
    let tier = -1;
    for (let i = 0; i < HYPE_TIERS.length; i += 1) {
      const step = HYPE_TIERS[i];
      if (step !== undefined && rally >= step.at) tier = i;
    }
    if (tier < 0) {
      hideHype();
      return;
    }
    const step = HYPE_TIERS[tier];
    if (step === undefined) return;

    const wasHidden = hype.hidden;
    setText(hypeCount, String(rally));
    if (tier !== hypeTier) {
      setText(hypeLabel, step.label);
      hype.dataset['tier'] = String(tier);
      hypeTier = tier;
    }

    if (wasHidden) {
      setHidden(hype, false);
      animate(hype, 'in');
      return;
    }
    // Restart the beat by alternating two identically-keyframed animations.
    hype.classList.toggle('is-beat-a', animFlip);
    hype.classList.toggle('is-beat-b', !animFlip);
    animFlip = !animFlip;
  };

  function hideHype(): void {
    if (hype.hidden) return;
    setHidden(hype, true);
    hype.classList.remove('is-beat-a', 'is-beat-b');
    hypeTier = -1;
  }

  // --- Per-match bookkeeping ------------------------------------------------

  const resetMatch = (): void => {
    speedBeat = 0;
    nextRallyBeat = 0;
    edgeHits = 0;
    deficit = 0;
    comebackCalled = false;
    farMatchPoint = false;
    matchPointKey = '';
    matchMedals.clear();
  };

  const resetRally = (): void => {
    speedBeat = 0;
    nextRallyBeat = 0;
    hideHype();
  };

  /** True when `near` is a human seat, which is what medals are awarded for. */
  const humanPlays = (ctx: CommentaryContext): boolean => ctx.mode !== 'demo';

  const rallyBeatFor = (rally: number): boolean => {
    const beat = RALLY_BEATS[nextRallyBeat];
    if (beat !== undefined) {
      if (rally < beat) return false;
      nextRallyBeat += 1;
      return true;
    }
    // Past the scripted beats, keep celebrating every `RALLY_STEP` hits.
    const last = RALLY_BEATS[RALLY_BEATS.length - 1] ?? 0;
    const overflow = last + (nextRallyBeat - RALLY_BEATS.length + 1) * RALLY_STEP;
    if (rally < overflow) return false;
    nextRallyBeat += 1;
    return true;
  };

  // --- Event handling -------------------------------------------------------

  const onServe = (score: CommentaryContext['score']): void => {
    resetRally();
    if (score.near === 0 && score.far === 0) {
      resetMatch();
      announce(OPENERS, P_FLAVOUR);
    }
  };

  const onPaddleHit = (
    side: 'near' | 'far',
    rally: number,
    edge: boolean,
    ctx: CommentaryContext,
  ): void => {
    showHype(rally);

    if (side === 'near' && edge) edgeHits += 1;
    if (humanPlays(ctx)) {
      if (rally >= 15) award('rally-15');
      if (ctx.speedRatio >= SUPERSONIC_RATIO) award('supersonic');
      if (edgeHits >= EDGE_MEDAL_HITS) award('edge-artist');
    }

    // Speed beats first: a ball at terminal velocity is a better story than the
    // hit count that produced it.
    const beat = SPEED_BEATS[speedBeat];
    if (beat !== undefined && ctx.speedRatio >= beat) {
      speedBeat += 1;
      announce(FAST_BALL, P_FLAVOUR);
      return;
    }
    if (rallyBeatFor(rally)) {
      announce(RALLY_LONG, P_FLAVOUR, { rally: String(rally) });
      return;
    }
    if (edge) announce(EDGE_HIT, P_CHATTER);
  };

  const onMiss = (side: 'near' | 'far', distance: number): void => {
    if (distance > WHISKER) return;
    announce(side === 'near' ? CLOSE_MISS_NEAR : CLOSE_MISS_FAR, P_NOTABLE);
  };

  const onPoint = (
    scorer: 'near' | 'far',
    score: CommentaryContext['score'],
    ctx: CommentaryContext,
  ): void => {
    hideHype();
    resetRally();

    const target = ctx.pointsToWin ?? DEFAULT_MATCH_RULES.pointsToWin;
    const savedMatchPoint = scorer === 'near' && farMatchPoint;
    const versus = ctx.mode !== 'single';

    if (versus) {
      announce(POINT_VERSUS, P_POINT, {
        scorer: scorer === 'near' ? ctx.playerLabels.near : ctx.playerLabels.far,
      });
    } else {
      announce(scorer === 'near' ? POINT_NEAR : POINT_FAR, P_POINT);
    }

    if (savedMatchPoint) {
      announce(SAVED, P_TENSION);
      if (humanPlays(ctx)) award('match-point-saved');
    }

    if (humanPlays(ctx) && scorer === 'near' && score.near === 1) award('first-point');

    // Deficit is tracked from the human's seat, which is also the seat the
    // comeback line is written from.
    const behind = score.far - score.near;
    if (behind > deficit) deficit = behind;
    if (
      !comebackCalled &&
      deficit >= COMEBACK_DEFICIT &&
      scorer === 'near' &&
      score.near >= score.far
    ) {
      comebackCalled = true;
      announce(COMEBACK, P_TENSION);
    }

    if (score.far === 0 && score.near >= 3) announce(SHUTOUT_RUN, P_NOTABLE);

    const nearMatchPoint = isMatchPoint(score.near, score.far, target);
    farMatchPoint = isMatchPoint(score.far, score.near, target);
    // Keyed rather than a flag, so match point changing hands is worth a line
    // while the same standing match point is not repeated every point.
    const key = `${nearMatchPoint ? 'n' : ''}${farMatchPoint ? 'f' : ''}`;
    if (key !== '' && key !== matchPointKey) announce(MATCH_POINT, P_TENSION);
    matchPointKey = key;

    if (ctx.mode === 'single' && performance.now() - lastTauntAt > TAUNT_COOLDOWN_MS) {
      if (scorer === 'far' && chance(0.42)) {
        speakOpponent(TAUNTS[ctx.difficulty], ctx, P_NOTABLE);
      } else if (scorer === 'near' && chance(0.34)) {
        speakOpponent(RESPECT[ctx.difficulty], ctx, P_NOTABLE);
      }
    }
  };

  const onMatchWon = (
    winner: 'near' | 'far',
    score: CommentaryContext['score'],
    ctx: CommentaryContext,
  ): void => {
    hideHype();
    queue.length = 0;

    if (ctx.mode !== 'single') {
      announce(WIN_VERSUS, P_FINAL, {
        winner: winner === 'near' ? ctx.playerLabels.near : ctx.playerLabels.far,
      });
    } else {
      announce(winner === 'near' ? WIN_NEAR : WIN_FAR, P_FINAL);
    }

    if (humanPlays(ctx) && winner === 'near') {
      if (score.far === 0) award('shutout');
      if (deficit >= COMEBACK_DEFICIT) award('comeback');
    }

    if (ctx.mode === 'single') {
      speakOpponent(winner === 'far' ? TAUNTS[ctx.difficulty] : RESPECT[ctx.difficulty], ctx, P_CLOSER);
    }
  };

  const handleEvents = (events: readonly DomainEvent[], ctx: CommentaryContext): void => {
    if (disposed || events.length === 0) return;
    for (const event of events) {
      switch (event.type) {
        case 'serve':
          onServe(ctx.score);
          break;
        case 'paddle-hit':
          onPaddleHit(event.side, event.rally, event.edge, ctx);
          break;
        case 'paddle-miss':
          onMiss(event.side, event.distance);
          break;
        case 'point-scored':
          onPoint(event.scorer, event.score, ctx);
          break;
        case 'match-won':
          onMatchWon(event.winner, event.score, ctx);
          break;
        case 'wall-bounce':
          break;
      }
    }
  };

  const clear = (): void => {
    bubbleTimer = stopTimer(bubbleTimer);
    medalTimer = stopTimer(medalTimer);
    queue.length = 0;
    medalQueue.length = 0;
    medalBusy = false;
    active = null;
    phase = 'idle';
    setHidden(say, true);
    setHidden(taunt, true);
    setHidden(medalCard, true);
    hideHype();
  };

  root.append(layer);

  return {
    handleEvents,
    setMuted(next: boolean): void {
      if (muted === next) return;
      muted = next;
      if (muted) clear();
    },
    clear,
    dispose(): void {
      disposed = true;
      clear();
      layer.remove();
      medalHandler = null;
      lastIndex.clear();
    },
    onMedal(handler: (medal: Medal) => void): void {
      medalHandler = handler;
    },
    get earned(): readonly MedalId[] {
      return [...earnedMedals];
    },
  };
};
