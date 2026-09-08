import type { Side } from '../../domain/arena';
import type {
  DomainEvent,
  MatchWonEvent,
  PaddleHitEvent,
  PaddleMissEvent,
  PointScoredEvent,
} from '../../domain/events';
import type { MatchPhase } from '../../domain/match';
import { clamp } from '../../domain/math/vec3';

/**
 * Comedy audio layer — the cartoon painted on top of the gameplay mix.
 *
 * `web-audio.ts` answers "what just happened" with clean, readable feedback:
 * impacts, bounces, a serve sweep. This layer answers "how does the arena feel
 * about it" — two robots barking gibberish at each other, a crowd that swells
 * and groans, and the slapstick punctuation (boing, slide whistle, drum roll,
 * fanfare) that turns a rally into a Saturday-morning cartoon.
 *
 * It is strictly additive: it owns no `AudioPort`, never touches the base mix,
 * and is handed both the `AudioContext` and the node it should sing into. If the
 * host mutes, disposes or never unlocks its audio, this layer simply goes quiet.
 *
 * Three constraints shape every routine below:
 *
 * 1. **Everything is scheduled on `AudioContext.currentTime`.** `setTimeout`
 *    jitters by whole frames, which is exactly the resolution comic timing lives
 *    at — a punchline 30 ms late stops being a punchline.
 * 2. **Gains are always ramped, never assigned.** Writing `AudioParam.value`
 *    while a node is audible is a step discontinuity, and the ear hears a click.
 *    Exponential ramps also refuse a target of zero, hence the `EPS` floor.
 * 3. **Every gesture is a pooled voice.** A gesture reserves a slot, tracks each
 *    node it created, and disconnects all of them when its last source ends. A
 *    seven-point match fires hundreds of gestures; without the pool that is
 *    hundreds of leaked nodes and a steadily thickening mix.
 */

// --------------------------------------------------------------------------
// Tuning
// --------------------------------------------------------------------------

/** Floor for exponential ramps: `exponentialRampToValueAtTime(0)` throws. */
const EPS = 0.0001;

/** The layer sits under the gameplay mix — it comments, it does not compete. */
const LAYER_LEVEL = 0.72;
const MUTE_RAMP = 0.06;
const CROWD_RAMP = 0.55;
const NOISE_SECONDS = 2;

/**
 * Concurrent gesture budget. A gesture is one comic beat (a bark, a boing, a
 * roar), not one node, so this is the number the ear actually counts.
 *
 * Rally chatter is refused at `MAX_VOICES`. Story beats keep a reserve on top,
 * because the busiest moment in the game is also the one that must never be
 * clipped: a point already spends six slots on whistle, groan, wail, roll, roar
 * and laugh before the fanfare has said a word.
 */
const MAX_VOICES = 6;
const MAX_PRIORITY_VOICES = 10;

/** Mirrors `DEFAULT_ARENA.halfWidth`; maps world x onto the stereo field. */
const HALF_WIDTH = 9;

/**
 * Mirrors `DEFAULT_MATCH_RULES.serveDelay`. Duplicated rather than injected
 * because this layer is never handed the rules; it only decides when the drum
 * roll lands, so drift changes comic timing, never play.
 */
const SERVE_DELAY = 1.1;

/**
 * Practical ball-speed window. `DEFAULT_BALL_RULES` allows up to 140 u/s, but a
 * human rally lives near the bottom of that range, so the whoosh threshold is
 * fitted to what actually happens rather than to the theoretical ceiling.
 */
const SPEED_CALM = 24;
const SPEED_HOT = 62;

/** A miss closer than this reads as "so close" — that is what the crowd groans at. */
const NEAR_MISS_DISTANCE = 1.15;

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

/** The two performers. `near` is the player's robot, `far` the opponent. */
export type RobotId = 'chispa' | 'tornillo';

export const ROBOT_BY_SIDE: Readonly<Record<Side, RobotId>> = {
  near: 'chispa',
  far: 'tornillo',
};

/**
 * The slice of the render frame this layer can use.
 *
 * Deliberately narrower than the renderer's `FrameContext`, which is
 * structurally assignable to it: the audio layer must not depend on the render
 * module contract (and therefore on Three.js) just to read three numbers.
 * Passing it is optional — every cue has an event-only fallback.
 */
export interface ComedyContext {
  readonly phase: MatchPhase;
  readonly rally: number;
  /** True while a menu or pause overlay covers the arena; damps idle comedy. */
  readonly dimmed: boolean;
  readonly ball: { readonly speedRatio: number };
}

export interface ComedyLayer {
  /**
   * Reacts to one frame of domain events. Safe to call with an empty array every
   * frame — that is the cheap path, and passing `ctx` each time is what lets the
   * layer notice the serve countdown starting.
   */
  handleEvents(events: readonly DomainEvent[], ctx?: ComedyContext): void;
  /** Crowd bed level and brightness, `[0, 1]`. Call once per frame. */
  setCrowdIntensity(value: number): void;
  setMuted(muted: boolean): void;
  /** Releases every node this layer created. Never closes the shared context. */
  dispose(): void;
}

/** Used whenever the platform, the context or the graph lets us down. */
const SILENT: ComedyLayer = {
  handleEvents: () => undefined,
  setCrowdIntensity: () => undefined,
  setMuted: () => undefined,
  dispose: () => undefined,
};

// --------------------------------------------------------------------------
// Robot voices
// --------------------------------------------------------------------------

/**
 * A "melodic contour": the pitch multipliers a bark walks through, one per
 * syllable. Meaning comes from the shape, not from any phonetics — a rising
 * contour reads as triumph and a falling one as complaint in every language,
 * which is why cartoon gibberish works at all.
 */
type Contour = 'rise' | 'fall' | 'bounce' | 'chatter' | 'wail';

const CONTOUR_STEPS: Readonly<Record<Contour, readonly number[]>> = {
  rise: [1, 1.26, 1.5, 1.89],
  fall: [1.68, 1.33, 1.06, 0.84],
  bounce: [1.2, 0.94, 1.38, 1.0],
  chatter: [1.1, 1.0, 1.19, 1.04],
  wail: [1.52, 1.44, 1.06, 0.7],
};

interface Partial {
  /** Multiplier on the voice fundamental. */
  readonly ratio: number;
  /** Detune in cents; the beating between partials is what sounds electronic. */
  readonly detune: number;
}

interface RobotVoice {
  readonly base: number;
  readonly wave: OscillatorType;
  readonly partials: readonly Partial[];
  /** Bandpass centre — the formant that gives the robot its mouth shape. */
  readonly formant: number;
  readonly q: number;
  readonly syllable: number;
  readonly gap: number;
  readonly level: number;
}

/**
 * Chispa speaks in bright, clipped square-wave chirps an octave above Tornillo,
 * who answers through a sawtooth with a sub-octave partial — the same contour
 * played by both robots reads as "excited" from one and "grumbling" from the
 * other purely through timbre and pace.
 */
const VOICE_BY_SIDE: Readonly<Record<Side, RobotVoice>> = {
  near: {
    base: 268,
    wave: 'square',
    partials: [
      { ratio: 1, detune: 0 },
      { ratio: 1, detune: 14 },
      { ratio: 1.99, detune: -9 },
    ],
    formant: 1580,
    q: 7.5,
    syllable: 0.082,
    gap: 0.032,
    level: 0.2,
  },
  far: {
    base: 132,
    wave: 'sawtooth',
    partials: [
      { ratio: 1, detune: 0 },
      { ratio: 1, detune: -13 },
      { ratio: 0.5, detune: 7 },
    ],
    formant: 760,
    q: 5.5,
    syllable: 0.135,
    gap: 0.052,
    level: 0.23,
  },
};

// --------------------------------------------------------------------------
// Cue throttling
// --------------------------------------------------------------------------

type Cue =
  | 'bark-near'
  | 'bark-far'
  | 'boing'
  | 'whistle'
  | 'whoosh'
  | 'roar'
  | 'groan'
  | 'roll';

/**
 * Minimum seconds between repeats of the same cue. Comedy is timing, and timing
 * is mostly restraint: a boing on every one of a twenty-hit rally is not funnier
 * than a boing on four of them, it is just noise.
 */
const COOLDOWN: Readonly<Record<Cue, number>> = {
  'bark-near': 0.62,
  'bark-far': 0.62,
  boing: 0.24,
  whistle: 0.7,
  whoosh: 0.5,
  roar: 1.4,
  groan: 1.6,
  roll: 0.9,
};

const BARK_CUE: Readonly<Record<Side, Cue>> = { near: 'bark-near', far: 'bark-far' };

// --------------------------------------------------------------------------
// Small numeric helpers
// --------------------------------------------------------------------------

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback;

const norm01 = (value: number, min: number, max: number): number =>
  clamp((finite(value, min) - min) / (max - min), 0, 1);

const panOf = (value: number): number => clamp(finite(value), -1, 1);

/**
 * Deterministic hash in `[0, 1)`. A bark schedules its pitch three times — once
 * per partial oscillator — plus once for the gain envelope, and all four passes
 * must agree on the same "random" syllable. `Math.random()` inside those loops
 * would desynchronise them into a chord instead of a word.
 */
const hash01 = (seed: number, index: number): number => {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return ((x % 1) + 1) % 1;
};

// --------------------------------------------------------------------------
// Graph
// --------------------------------------------------------------------------

interface Voice {
  readonly nodes: AudioNode[];
  readonly sources: AudioScheduledSourceNode[];
  /** Sources still scheduled; the voice is released when this reaches zero. */
  pending: number;
  /** Latest scheduled stop, used by the stale-voice sweep. */
  deadline: number;
  released: boolean;
}

interface Layer {
  readonly ctx: AudioContext;
  /** Mute stage, and the only node connected to the host's destination. */
  readonly root: GainNode;
  readonly voiceBus: GainNode;
  readonly sfxBus: GainNode;
  readonly crowdBus: GainNode;
  readonly bedGain: GainNode;
  readonly bedTone: BiquadFilterNode;
  readonly bedChatter: GainNode;
  readonly bedBreath: GainNode;
  readonly noise: AudioBuffer;
  /** Lifetime nodes: the crowd bed and the buses. */
  readonly permanent: AudioNode[];
  readonly permanentSources: AudioScheduledSourceNode[];
  readonly voices: Set<Voice>;
  readonly nextAt: Record<Cue, number>;
  phase: MatchPhase | null;
  disposed: boolean;
}

const buildNoise = (ctx: AudioContext): AudioBuffer => {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) channel[i] = Math.random() * 2 - 1;
  return buffer;
};

const keep = <T extends AudioNode>(layer: Layer, node: T): T => {
  layer.permanent.push(node);
  return node;
};

const addNode = <T extends AudioNode>(voice: Voice, node: T): T => {
  voice.nodes.push(node);
  return node;
};

const releaseVoice = (layer: Layer, voice: Voice): void => {
  if (voice.released) return;
  voice.released = true;
  layer.voices.delete(voice);
  for (const node of voice.nodes) {
    try {
      node.disconnect();
    } catch {
      // Already detached — nothing left to unwind.
    }
  }
  voice.nodes.length = 0;
  voice.sources.length = 0;
};

const stopVoice = (layer: Layer, voice: Voice): void => {
  for (const source of voice.sources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Never started, or already stopped.
    }
  }
  releaseVoice(layer, voice);
};

/**
 * Reclaims voices whose sources should have finished. `onended` is the normal
 * path, but a context suspended mid-gesture (tab hidden, host pause) never fires
 * it, and without this sweep those slots would stay reserved forever and the
 * layer would fall permanently silent.
 */
const sweepVoices = (layer: Layer, now: number): void => {
  if (layer.voices.size === 0) return;
  for (const voice of layer.voices) {
    if (now > voice.deadline + 0.75) stopVoice(layer, voice);
  }
};

const beginVoice = (layer: Layer, now: number, priority: boolean): Voice | null => {
  if (layer.disposed) return null;
  sweepVoices(layer, now);
  if (layer.voices.size >= (priority ? MAX_PRIORITY_VOICES : MAX_VOICES)) return null;
  const voice: Voice = {
    nodes: [],
    sources: [],
    pending: 0,
    deadline: now,
    released: false,
  };
  layer.voices.add(voice);
  return voice;
};

/**
 * Schedules a source that the `oscillator` helper already tracked. Sources are
 * never created inline: going through the helpers is what guarantees every node
 * ends up in the voice's disconnect list.
 */
const playSource = (
  layer: Layer,
  voice: Voice,
  node: AudioScheduledSourceNode,
  when: number,
  stopAt: number,
): void => {
  voice.sources.push(node);
  voice.pending += 1;
  voice.deadline = Math.max(voice.deadline, stopAt);
  node.onended = () => {
    node.onended = null;
    voice.pending -= 1;
    if (voice.pending <= 0) releaseVoice(layer, voice);
  };
  node.start(when);
  node.stop(stopAt);
};

const oscillator = (
  layer: Layer,
  voice: Voice,
  type: OscillatorType,
): OscillatorNode => {
  const osc = addNode(voice, layer.ctx.createOscillator());
  osc.type = type;
  return osc;
};

const noiseSource = (layer: Layer, voice: Voice, rate: number): AudioBufferSourceNode => {
  const source = addNode(voice, layer.ctx.createBufferSource());
  source.buffer = layer.noise;
  source.playbackRate.value = rate;
  return source;
};

/**
 * Starts a one-shot noise burst at a random offset into the shared buffer.
 * Replaying the same samples on every wall of a long rally is audible as a
 * mechanical repetition — the "machine gun" artefact.
 */
const playNoise = (
  layer: Layer,
  voice: Voice,
  source: AudioBufferSourceNode,
  when: number,
  duration: number,
): void => {
  const span = Math.max(0, layer.noise.duration - duration - 0.05);
  voice.sources.push(source);
  voice.pending += 1;
  voice.deadline = Math.max(voice.deadline, when + duration);
  source.onended = () => {
    source.onended = null;
    voice.pending -= 1;
    if (voice.pending <= 0) releaseVoice(layer, voice);
  };
  source.start(when, Math.random() * span, duration);
};

const isPanner = (node: AudioNode): node is StereoPannerNode => 'pan' in node;

/** Stereo placement; falls back to a bare gain where panning is unsupported. */
const panStage = (
  layer: Layer,
  voice: Voice,
  bus: AudioNode,
  pan: number,
  when: number,
): AudioNode => {
  if (typeof layer.ctx.createStereoPanner === 'function') {
    const panner = addNode(voice, layer.ctx.createStereoPanner());
    panner.pan.setValueAtTime(panOf(pan), when);
    panner.connect(bus);
    return panner;
  }
  const passthrough = addNode(voice, layer.ctx.createGain());
  passthrough.connect(bus);
  return passthrough;
};

/** Flyby: the sound crosses the stereo field while it plays. */
const sweepPan = (
  node: AudioNode,
  from: number,
  to: number,
  when: number,
  duration: number,
): void => {
  if (!isPanner(node)) return;
  node.pan.setValueAtTime(panOf(from), when);
  node.pan.linearRampToValueAtTime(panOf(to), when + duration);
};

// --------------------------------------------------------------------------
// Envelopes
// --------------------------------------------------------------------------

/** Percussive: instant attack, exponential tail towards (but never to) zero. */
const strike = (
  param: AudioParam,
  when: number,
  peak: number,
  attack: number,
  decay: number,
): void => {
  const top = Math.max(EPS * 2, peak);
  param.setValueAtTime(EPS, when);
  param.linearRampToValueAtTime(top, when + Math.max(0.002, attack));
  param.exponentialRampToValueAtTime(EPS, when + Math.max(0.002, attack) + Math.max(0.01, decay));
};

/** Sustained gesture: swells in, holds, falls away. */
const swell = (
  param: AudioParam,
  when: number,
  peak: number,
  duration: number,
  attackShare = 0.3,
): void => {
  const top = Math.max(EPS * 2, peak);
  const span = Math.max(0.05, duration);
  const attack = span * clamp(attackShare, 0.05, 0.8);
  param.setValueAtTime(EPS, when);
  param.linearRampToValueAtTime(top, when + attack);
  param.linearRampToValueAtTime(top * 0.78, when + span * 0.62);
  param.exponentialRampToValueAtTime(EPS, when + span);
};

// --------------------------------------------------------------------------
// Robot barks
// --------------------------------------------------------------------------

const syllableSeconds = (persona: RobotVoice, index: number): number =>
  persona.syllable * (index % 2 === 0 ? 1 : 0.74) * (index === 0 ? 1.15 : 1);

const glideOf = (index: number): number => (index % 2 === 0 ? 1.07 : 0.92);

/**
 * One robot says something.
 *
 * A single pair of long-lived oscillators plays the whole line: the syllables
 * come from stepping the carrier frequency and re-striking the gain envelope, so
 * a four-syllable bark costs the same three sources as a one-syllable one. The
 * bandpass tracks the same contour a little flatter than the pitch, which is
 * what turns a beeping arpeggio into something that sounds spoken.
 */
const speak = (
  layer: Layer,
  side: Side,
  contour: Contour,
  syllables: number,
  when: number,
  level: number,
  pan: number,
  priority: boolean,
): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, priority);
  if (!voice) return;

  const persona = VOICE_BY_SIDE[side];
  const steps = CONTOUR_STEPS[contour];
  const count = Math.max(1, Math.min(steps.length, Math.floor(syllables)));
  const seed = Math.random() * 997;
  // Per-bark accent: same robot, slightly different mood each time.
  const accent = 0.92 + hash01(seed, 97) * 0.2;

  const filter = addNode(voice, layer.ctx.createBiquadFilter());
  filter.type = 'bandpass';
  filter.Q.setValueAtTime(persona.q, when);

  const gain = addNode(voice, layer.ctx.createGain());
  gain.gain.setValueAtTime(EPS, when);

  const out = panStage(layer, voice, layer.voiceBus, pan, when);
  filter.connect(gain).connect(out);

  for (const partial of persona.partials) {
    const osc = oscillator(layer, voice, persona.wave);
    osc.detune.setValueAtTime(partial.detune, when);
    let cursor = when;
    for (let i = 0; i < count; i += 1) {
      const step = (steps[i] ?? 1) * (0.94 + hash01(seed, i) * 0.13);
      const span = syllableSeconds(persona, i);
      const freq = Math.max(20, persona.base * accent * partial.ratio * step);
      osc.frequency.setValueAtTime(freq, cursor);
      osc.frequency.exponentialRampToValueAtTime(freq * glideOf(i), cursor + span);
      cursor += span + persona.gap;
    }
    osc.connect(filter);
    playSource(layer, voice, osc, when, cursor + 0.06);
  }

  let cursor = when;
  for (let i = 0; i < count; i += 1) {
    const step = (steps[i] ?? 1) * (0.94 + hash01(seed, i) * 0.13);
    const span = syllableSeconds(persona, i);
    // The formant follows the melody at a fraction of its range: vowels move
    // less than pitch does, and tracking one-to-one sounds like a siren.
    const centre = Math.max(80, persona.formant * accent * step ** 0.55);
    filter.frequency.setValueAtTime(centre, cursor);
    filter.frequency.linearRampToValueAtTime(centre * glideOf(i), cursor + span);
    strike(gain.gain, cursor, persona.level * level, 0.011, span * 0.86);
    cursor += span + persona.gap;
  }
};

// --------------------------------------------------------------------------
// Crowd
// --------------------------------------------------------------------------

/**
 * The roar after a point: a broad noise swell that opens bright and settles,
 * with a clapping layer on top. The clap texture is a tremolo — noise through a
 * highpass, amplitude-modulated at 11 Hz — which is far cheaper and far more
 * convincing than trying to schedule individual hand claps.
 */
const playRoar = (layer: Layer, strength: number, when: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, true);
  if (!voice) return;
  const { ctx } = layer;
  const heat = clamp(strength, 0, 1);
  const span = 1.15 + heat * 0.5;

  const out = panStage(layer, voice, layer.crowdBus, 0, when);

  const body = noiseSource(layer, voice, 0.9);
  const bodyFilter = addNode(voice, ctx.createBiquadFilter());
  bodyFilter.type = 'bandpass';
  bodyFilter.Q.setValueAtTime(0.75, when);
  bodyFilter.frequency.setValueAtTime(480, when);
  bodyFilter.frequency.linearRampToValueAtTime(950 + heat * 850, when + span * 0.28);
  bodyFilter.frequency.exponentialRampToValueAtTime(430, when + span);

  const bodyGain = addNode(voice, ctx.createGain());
  swell(bodyGain.gain, when, 0.2 + heat * 0.24, span, 0.2);
  body.connect(bodyFilter).connect(bodyGain).connect(out);
  playNoise(layer, voice, body, when, span);

  const claps = noiseSource(layer, voice, 1.25);
  const clapFilter = addNode(voice, ctx.createBiquadFilter());
  clapFilter.type = 'highpass';
  clapFilter.frequency.setValueAtTime(2100, when);

  const clapGain = addNode(voice, ctx.createGain());
  swell(clapGain.gain, when, 0.05 + heat * 0.09, span * 0.9, 0.25);

  const tremolo = oscillator(layer, voice, 'sine');
  tremolo.frequency.setValueAtTime(9 + heat * 4, when);
  const tremoloDepth = addNode(voice, ctx.createGain());
  // Modulation is summed onto the param's automated value, so the depth matches
  // the envelope peak: the claps punch through without ever inverting phase.
  tremoloDepth.gain.setValueAtTime(0.05 + heat * 0.09, when);
  tremolo.connect(tremoloDepth).connect(clapGain.gain);
  playSource(layer, voice, tremolo, when, when + span);

  claps.connect(clapFilter).connect(clapGain).connect(out);
  playNoise(layer, voice, claps, when, span * 0.9);
};

/**
 * The "ohhhh" after a near miss. Two resonant bandpasses sitting at the first
 * and second formant of an /o/ turn plain noise into a vowel; sliding both down
 * together is the whole trick — the crowd deflates rather than exhales.
 */
const playGroan = (layer: Layer, when: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, true);
  if (!voice) return;
  const { ctx } = layer;
  const span = 0.95;

  const out = panStage(layer, voice, layer.crowdBus, 0, when);
  const env = addNode(voice, ctx.createGain());
  swell(env.gain, when, 0.3, span, 0.18);
  env.connect(out);

  const source = noiseSource(layer, voice, 0.85);

  const f1 = addNode(voice, ctx.createBiquadFilter());
  f1.type = 'bandpass';
  f1.Q.setValueAtTime(9, when);
  f1.frequency.setValueAtTime(540, when);
  f1.frequency.exponentialRampToValueAtTime(300, when + span);

  const f2 = addNode(voice, ctx.createBiquadFilter());
  f2.type = 'bandpass';
  f2.Q.setValueAtTime(12, when);
  f2.frequency.setValueAtTime(940, when);
  f2.frequency.exponentialRampToValueAtTime(610, when + span);

  const f2Gain = addNode(voice, ctx.createGain());
  f2Gain.gain.setValueAtTime(0.55, when);

  source.connect(f1).connect(env);
  source.connect(f2).connect(f2Gain).connect(env);
  playNoise(layer, voice, source, when, span);

  // A quiet sine under the formants gives the groan a body, so it reads as a
  // hundred throats rather than a filter sweep.
  const body = oscillator(layer, voice, 'sine');
  body.frequency.setValueAtTime(208, when);
  body.frequency.exponentialRampToValueAtTime(152, when + span);
  const bodyGain = addNode(voice, ctx.createGain());
  swell(bodyGain.gain, when, 0.06, span, 0.2);
  body.connect(bodyGain).connect(out);
  playSource(layer, voice, body, when, when + span + 0.05);
};

// --------------------------------------------------------------------------
// Slapstick
// --------------------------------------------------------------------------

/** Edge hit: the paddle rim behaves like a cartoon spring. */
const playBoing = (layer: Layer, when: number, pan: number, heat: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, false);
  if (!voice) return;
  const { ctx } = layer;
  const span = 0.34;

  const osc = oscillator(layer, voice, 'sine');
  // Snap up, then a long sag: the up-blip is what sells "sprung", the sag is
  // what sells "and now it is wobbling".
  osc.frequency.setValueAtTime(210, when);
  osc.frequency.exponentialRampToValueAtTime(760 + heat * 340, when + 0.04);
  osc.frequency.exponentialRampToValueAtTime(150, when + span);

  const vibrato = oscillator(layer, voice, 'sine');
  vibrato.frequency.setValueAtTime(7.5, when);
  const vibratoDepth = addNode(voice, ctx.createGain());
  vibratoDepth.gain.setValueAtTime(20, when);
  vibratoDepth.gain.linearRampToValueAtTime(95, when + span);
  vibrato.connect(vibratoDepth).connect(osc.frequency);
  playSource(layer, voice, vibrato, when, when + span + 0.05);

  const gain = addNode(voice, ctx.createGain());
  strike(gain.gain, when, 0.22 + heat * 0.1, 0.006, span);

  osc.connect(gain).connect(panStage(layer, voice, layer.sfxBus, pan, when));
  playSource(layer, voice, osc, when, when + span + 0.05);
};

/** The miss. A whistle falling off a cliff, with a small plop at the bottom. */
const playSlideWhistle = (layer: Layer, when: number, pan: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, false);
  if (!voice) return;
  const { ctx } = layer;
  const span = 0.72;
  const out = panStage(layer, voice, layer.sfxBus, pan, when);

  const osc = oscillator(layer, voice, 'sine');
  osc.frequency.setValueAtTime(1780, when);
  osc.frequency.exponentialRampToValueAtTime(255, when + span);

  const gain = addNode(voice, ctx.createGain());
  gain.gain.setValueAtTime(EPS, when);
  gain.gain.linearRampToValueAtTime(0.17, when + 0.05);
  gain.gain.linearRampToValueAtTime(0.14, when + span * 0.8);
  gain.gain.exponentialRampToValueAtTime(EPS, when + span);
  osc.connect(gain).connect(out);
  playSource(layer, voice, osc, when, when + span + 0.05);

  // Breath: a real slide whistle is mostly air, and the noise layer is what
  // keeps the sine from sounding like a test tone.
  const air = noiseSource(layer, voice, 1);
  const airFilter = addNode(voice, ctx.createBiquadFilter());
  airFilter.type = 'bandpass';
  airFilter.Q.setValueAtTime(4.5, when);
  airFilter.frequency.setValueAtTime(1780, when);
  airFilter.frequency.exponentialRampToValueAtTime(255, when + span);
  const airGain = addNode(voice, ctx.createGain());
  swell(airGain.gain, when, 0.055, span, 0.1);
  air.connect(airFilter).connect(airGain).connect(out);
  playNoise(layer, voice, air, when, span);

  const plop = oscillator(layer, voice, 'sine');
  plop.frequency.setValueAtTime(220, when + span);
  plop.frequency.exponentialRampToValueAtTime(96, when + span + 0.12);
  const plopGain = addNode(voice, ctx.createGain());
  strike(plopGain.gain, when + span, 0.15, 0.004, 0.13);
  plop.connect(plopGain).connect(out);
  playSource(layer, voice, plop, when + span, when + span + 0.2);
};

/** Very fast ball: air tearing past the camera, left to right. */
const playWhoosh = (layer: Layer, when: number, pan: number, heat: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, false);
  if (!voice) return;
  const { ctx } = layer;
  const span = 0.26;

  const source = noiseSource(layer, voice, 1 + heat * 0.35);
  const filter = addNode(voice, ctx.createBiquadFilter());
  filter.type = 'bandpass';
  filter.Q.setValueAtTime(1.15, when);
  filter.frequency.setValueAtTime(320, when);
  filter.frequency.exponentialRampToValueAtTime(1900 + heat * 1400, when + span * 0.45);
  filter.frequency.exponentialRampToValueAtTime(430, when + span);

  const gain = addNode(voice, ctx.createGain());
  swell(gain.gain, when, 0.13 + heat * 0.1, span, 0.35);

  const out = panStage(layer, voice, layer.sfxBus, pan, when);
  sweepPan(out, pan, -pan * 0.7, when, span);
  source.connect(filter).connect(gain).connect(out);
  playNoise(layer, voice, source, when, span);
};

/**
 * The drum roll before a serve.
 *
 * The roll is one noise burst whose gain is modulated by an accelerating sine —
 * scheduling forty individual hits would burn the entire voice pool for a sound
 * the ear reads as a single texture. It crescendos into an accent that is timed
 * to land on the serve itself.
 */
const playDrumRoll = (layer: Layer, when: number, span: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, true);
  if (!voice) return;
  const { ctx } = layer;
  const end = when + span;
  const out = panStage(layer, voice, layer.sfxBus, 0, when);

  const source = noiseSource(layer, voice, 1);
  const filter = addNode(voice, ctx.createBiquadFilter());
  filter.type = 'bandpass';
  filter.Q.setValueAtTime(1.6, when);
  filter.frequency.setValueAtTime(1700, when);
  filter.frequency.linearRampToValueAtTime(2600, end);

  const gain = addNode(voice, ctx.createGain());
  gain.gain.setValueAtTime(EPS, when);
  gain.gain.linearRampToValueAtTime(0.075, end);

  const beater = oscillator(layer, voice, 'sine');
  beater.frequency.setValueAtTime(16, when);
  beater.frequency.linearRampToValueAtTime(27, end);
  const beaterDepth = addNode(voice, ctx.createGain());
  beaterDepth.gain.setValueAtTime(EPS, when);
  beaterDepth.gain.linearRampToValueAtTime(0.075, end);
  beater.connect(beaterDepth).connect(gain.gain);
  playSource(layer, voice, beater, when, end + 0.02);

  source.connect(filter).connect(gain).connect(out);
  playNoise(layer, voice, source, when, span);

  const crack = noiseSource(layer, voice, 1.4);
  const crackFilter = addNode(voice, ctx.createBiquadFilter());
  crackFilter.type = 'highpass';
  crackFilter.frequency.setValueAtTime(1400, end);
  const crackGain = addNode(voice, ctx.createGain());
  strike(crackGain.gain, end, 0.2, 0.002, 0.16);
  crack.connect(crackFilter).connect(crackGain).connect(out);
  playNoise(layer, voice, crack, end, 0.2);

  const thump = oscillator(layer, voice, 'sine');
  thump.frequency.setValueAtTime(150, end);
  thump.frequency.exponentialRampToValueAtTime(52, end + 0.16);
  const thumpGain = addNode(voice, ctx.createGain());
  strike(thumpGain.gain, end, 0.26, 0.003, 0.18);
  thump.connect(thumpGain).connect(out);
  playSource(layer, voice, thump, end, end + 0.26);
};

/** Match won: five notes of brass and a timpani, played by nobody in particular. */
const playFanfare = (layer: Layer, when: number): void => {
  const voice = beginVoice(layer, layer.ctx.currentTime, true);
  if (!voice) return;
  const { ctx } = layer;

  const notes: readonly number[] = [392, 523.25, 659.25, 783.99, 1046.5];
  const offsets: readonly number[] = [0, 0.13, 0.26, 0.39, 0.56];
  const last = notes.length - 1;
  const tail = (offsets[last] ?? 0) + 0.95;

  const out = panStage(layer, voice, layer.sfxBus, 0, when);

  const shape = addNode(voice, ctx.createBiquadFilter());
  shape.type = 'lowpass';
  shape.Q.setValueAtTime(0.9, when);
  shape.frequency.setValueAtTime(1100, when);
  shape.frequency.linearRampToValueAtTime(4200, when + tail * 0.7);

  const gain = addNode(voice, ctx.createGain());
  gain.gain.setValueAtTime(EPS, when);
  shape.connect(gain).connect(out);

  for (const detune of [-7, 8]) {
    const osc = oscillator(layer, voice, 'sawtooth');
    osc.detune.setValueAtTime(detune, when);
    for (let i = 0; i < notes.length; i += 1) {
      osc.frequency.setValueAtTime(notes[i] ?? 440, when + (offsets[i] ?? 0));
    }
    osc.connect(shape);
    playSource(layer, voice, osc, when, when + tail + 0.1);
  }

  for (let i = 0; i < notes.length; i += 1) {
    const at = when + (offsets[i] ?? 0);
    strike(gain.gain, at, i === last ? 0.24 : 0.17, 0.012, i === last ? 0.9 : 0.13);
  }

  const timpani = oscillator(layer, voice, 'sine');
  timpani.frequency.setValueAtTime(120, when);
  timpani.frequency.exponentialRampToValueAtTime(48, when + 0.22);
  timpani.frequency.setValueAtTime(120, when + (offsets[last] ?? 0));
  timpani.frequency.exponentialRampToValueAtTime(46, when + (offsets[last] ?? 0) + 0.3);
  const timpaniGain = addNode(voice, ctx.createGain());
  strike(timpaniGain.gain, when, 0.24, 0.004, 0.24);
  strike(timpaniGain.gain, when + (offsets[last] ?? 0), 0.3, 0.004, 0.34);
  timpani.connect(timpaniGain).connect(out);
  playSource(layer, voice, timpani, when, when + tail + 0.1);
};

// --------------------------------------------------------------------------
// Cue routing
// --------------------------------------------------------------------------

const gate = (layer: Layer, cue: Cue, now: number): boolean => {
  if (now < layer.nextAt[cue]) return false;
  layer.nextAt[cue] = now + COOLDOWN[cue];
  return true;
};

const bark = (
  layer: Layer,
  side: Side,
  contour: Contour,
  syllables: number,
  delay: number,
  level: number,
  pan: number,
  priority: boolean,
): void => {
  const now = layer.ctx.currentTime;
  if (!gate(layer, BARK_CUE[side], now + delay)) return;
  speak(layer, side, contour, syllables, now + delay, level, pan, priority);
};

const armServeRoll = (layer: Layer): void => {
  const now = layer.ctx.currentTime;
  if (!gate(layer, 'roll', now)) return;
  // Starts after the point has landed and ends on the serve, so the accent and
  // the ball leaving the paddle are the same beat.
  playDrumRoll(layer, now + 0.36, Math.max(0.35, SERVE_DELAY - 0.36));
};

const onPaddleHit = (layer: Layer, event: PaddleHitEvent, quiet: boolean): void => {
  const now = layer.ctx.currentTime;
  const heat = norm01(event.speed, SPEED_CALM, SPEED_HOT);
  const pan = panOf(event.offset.x * 0.8 + event.position.x / HALF_WIDTH * 0.4);

  if (event.edge && !quiet && gate(layer, 'boing', now)) {
    playBoing(layer, now, pan, heat);
  }
  if (heat > 0.55 && !quiet && gate(layer, 'whoosh', now)) {
    playWhoosh(layer, now + 0.02, pan, heat);
  }
  if (quiet) return;

  // Not every return deserves a comment. Long rallies get chattier, edge saves
  // always earn a yelp, and the rest is left to silence so the barks land.
  const chance = event.edge ? 1 : 0.24 + Math.min(0.4, event.rally * 0.035);
  if (Math.random() > chance) return;
  bark(
    layer,
    event.side,
    event.edge ? 'bounce' : 'chatter',
    event.edge ? 3 : 2,
    0.015,
    event.edge ? 1 : 0.78,
    pan,
    false,
  );
};

const onPaddleMiss = (layer: Layer, event: PaddleMissEvent): void => {
  const now = layer.ctx.currentTime;
  const pan = panOf(event.position.x / HALF_WIDTH);

  if (gate(layer, 'whistle', now)) playSlideWhistle(layer, now + 0.03, pan);
  if (finite(event.distance, 99) < NEAR_MISS_DISTANCE && gate(layer, 'groan', now)) {
    playGroan(layer, now + 0.18);
  }
  // Beat one of the joke: the ball sails past and its owner complains. The
  // laugh belongs to the point, which lands a few frames later — putting it
  // here as well would reserve the winner's voice slot and silence it there.
  bark(layer, event.side, 'wail', 3, 0.12, 1, pan, true);
};

const onPointScored = (layer: Layer, event: PointScoredEvent, finale: boolean): void => {
  const now = layer.ctx.currentTime;
  const homeCrowd = event.scorer === 'near';
  if (gate(layer, 'roar', now)) {
    // The stands are on the player's side: the robot scoring gets applause, but
    // a politely disappointed version of it.
    playRoar(layer, homeCrowd ? 1 : 0.5, now + 0.06);
  }
  // Beats two and three, spaced so they read as two separate thoughts: the
  // winner gloats over the roar, the loser gets the last, unhappy word.
  bark(
    layer,
    event.scorer,
    Math.random() < 0.5 ? 'bounce' : 'rise',
    4,
    0.45,
    1,
    homeCrowd ? -0.25 : 0.25,
    true,
  );
  bark(layer, event.conceded, 'fall', 3, 0.82, 0.9, homeCrowd ? 0.25 : -0.25, true);
  if (!finale) armServeRoll(layer);
};

const onMatchWon = (layer: Layer, event: MatchWonEvent): void => {
  const now = layer.ctx.currentTime;
  playFanfare(layer, now + 0.1);
  playRoar(layer, event.winner === 'near' ? 1 : 0.6, now + 0.12);
  bark(layer, event.winner, 'rise', 4, 0.75, 1.1, 0, true);
  bark(layer, event.winner === 'near' ? 'far' : 'near', 'wail', 4, 1.3, 0.95, 0, true);
};

// --------------------------------------------------------------------------
// Construction
// --------------------------------------------------------------------------

const buildLayer = (ctx: AudioContext, destination: AudioNode): Layer => {
  const now = ctx.currentTime;

  const root = ctx.createGain();
  root.gain.value = 0;
  root.connect(destination);

  // Gentle glue, not a loudness effect: a roar, a fanfare and two barks can land
  // in the same 200 ms, and this keeps that stack from swamping the gameplay mix.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -22;
  compressor.knee.value = 24;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.25;
  compressor.connect(root);

  const voiceBus = ctx.createGain();
  voiceBus.gain.value = 1;
  voiceBus.connect(compressor);

  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.9;
  sfxBus.connect(compressor);

  const crowdBus = ctx.createGain();
  crowdBus.gain.value = 1;
  crowdBus.connect(compressor);

  const bedGain = ctx.createGain();
  bedGain.gain.value = 0;
  bedGain.connect(crowdBus);

  const bedTone = ctx.createBiquadFilter();
  bedTone.type = 'lowpass';
  bedTone.frequency.value = 500;
  bedTone.Q.value = 0.6;
  bedTone.connect(bedGain);

  const bedChatter = ctx.createGain();
  bedChatter.gain.value = 0;
  bedChatter.connect(bedTone);

  const bedBreath = ctx.createGain();
  bedBreath.gain.value = 0;
  bedBreath.connect(bedGain.gain);

  const layer: Layer = {
    ctx,
    root,
    voiceBus,
    sfxBus,
    crowdBus,
    bedGain,
    bedTone,
    bedChatter,
    bedBreath,
    noise: buildNoise(ctx),
    permanent: [],
    permanentSources: [],
    voices: new Set<Voice>(),
    nextAt: {
      'bark-near': 0,
      'bark-far': 0,
      boing: 0,
      whistle: 0,
      whoosh: 0,
      roar: 0,
      groan: 0,
      roll: 0,
    },
    phase: null,
    disposed: false,
  };

  keep(layer, root);
  keep(layer, compressor);
  keep(layer, voiceBus);
  keep(layer, sfxBus);
  keep(layer, crowdBus);
  keep(layer, bedGain);
  keep(layer, bedTone);
  keep(layer, bedChatter);
  keep(layer, bedBreath);

  // The bed runs for the lifetime of the layer and only its gains and cutoff
  // move, so raising the intensity can never restart a phase and click.
  const murmur = ctx.createBufferSource();
  murmur.buffer = layer.noise;
  murmur.loop = true;
  murmur.playbackRate.value = 0.68;
  const murmurFilter = ctx.createBiquadFilter();
  murmurFilter.type = 'bandpass';
  murmurFilter.frequency.value = 400;
  murmurFilter.Q.value = 0.55;
  murmur.connect(murmurFilter).connect(bedTone);
  keep(layer, murmur);
  keep(layer, murmurFilter);
  layer.permanentSources.push(murmur);

  // A brighter chatter layer on its own gain: an excited crowd is not just a
  // louder crowd, it is a crowd with more consonants in it.
  const chatter = ctx.createBufferSource();
  chatter.buffer = layer.noise;
  chatter.loop = true;
  chatter.playbackRate.value = 1.31;
  const chatterFilter = ctx.createBiquadFilter();
  chatterFilter.type = 'highpass';
  chatterFilter.frequency.value = 1500;
  chatter.connect(chatterFilter).connect(bedChatter);
  keep(layer, chatter);
  keep(layer, chatterFilter);
  layer.permanentSources.push(chatter);

  // Very slow breathing on the bed level, so a held intensity never sits
  // perfectly still and stops sounding like people.
  const breath = ctx.createOscillator();
  breath.type = 'sine';
  breath.frequency.value = 0.11;
  breath.connect(bedBreath);
  keep(layer, breath);
  layer.permanentSources.push(breath);

  murmur.start(now);
  chatter.start(now);
  breath.start(now);

  return layer;
};

/**
 * Builds the comedy layer on an existing graph.
 *
 * `context` and `destination` belong to the host: this layer connects one node
 * to `destination` and never closes or reconfigures the context, so it can be
 * dropped in and pulled out without disturbing the base mix.
 *
 * Returns a silent no-op if the graph cannot be built. Nothing in here is worth
 * failing a frame over.
 */
export const createComedyLayer = (
  context: AudioContext,
  destination: AudioNode,
): ComedyLayer => {
  let built: Layer | null = null;
  try {
    built = buildLayer(context, destination);
  } catch {
    return SILENT;
  }
  if (!built) return SILENT;

  const active = built;
  let muted = false;
  let intensity = 0;

  const applyMaster = (): void => {
    // A fresh `setTargetAtTime` supersedes the pending one from its own start
    // time and inherits the current smoothed value, so cancelling first would
    // only risk the documented revert-to-previous-value behaviour.
    active.root.gain.setTargetAtTime(
      muted ? 0 : LAYER_LEVEL,
      active.ctx.currentTime,
      MUTE_RAMP,
    );
  };

  const applyIntensity = (): void => {
    const now = active.ctx.currentTime;
    // Curved so a calm rally leaves the arena almost empty and only the last
    // stretch of the range fills the stands. Exactly zero at v = 0.
    active.bedGain.gain.setTargetAtTime(intensity ** 1.35 * 0.3, now, CROWD_RAMP);
    active.bedTone.frequency.setTargetAtTime(
      520 + intensity ** 1.2 * 4200,
      now,
      CROWD_RAMP,
    );
    active.bedChatter.gain.setTargetAtTime(intensity ** 2.2 * 0.5, now, CROWD_RAMP);
    active.bedBreath.gain.setTargetAtTime(intensity * 0.05, now, CROWD_RAMP);
  };

  applyMaster();
  applyIntensity();

  const dispatch = (event: DomainEvent, quiet: boolean, finale: boolean): void => {
    switch (event.type) {
      case 'paddle-hit':
        onPaddleHit(active, event, quiet);
        return;
      case 'paddle-miss':
        onPaddleMiss(active, event);
        return;
      case 'point-scored':
        onPointScored(active, event, finale);
        return;
      case 'match-won':
        onMatchWon(active, event);
        return;
      case 'wall-bounce':
      case 'serve':
        // Handled by the base mix; a second voice on top would only muddy it.
        return;
    }
  };

  const handleEvents = (events: readonly DomainEvent[], ctx?: ComedyContext): void => {
    if (active.disposed) return;
    try {
      if (active.ctx.state !== 'running') return;

      // Entering the serve countdown is the cue for the drum roll — including
      // the opening serve, which no event announces.
      if (ctx) {
        const phase = ctx.phase;
        if (phase !== active.phase) {
          active.phase = phase;
          if (phase === 'serving') armServeRoll(active);
        }
      }

      if (events.length === 0) return;

      // A point that ends the match must not arm a drum roll for a serve that
      // will never come, so the batch is scanned before anything is scheduled.
      let finale = false;
      for (let i = 0; i < events.length; i += 1) {
        if (events[i]?.type === 'match-won') {
          finale = true;
          break;
        }
      }

      // Rally chatter is suppressed behind menus (the demo match keeps playing
      // there); the story beats are not, so a win still gets its fanfare.
      const quiet = ctx?.dimmed === true;
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        if (event) dispatch(event, quiet, finale);
      }
    } catch {
      // Audio never breaks a frame.
    }
  };

  const setCrowdIntensity = (value: number): void => {
    if (active.disposed) return;
    const next = clamp(finite(value), 0, 1);
    // Called once per rendered frame; re-scheduling an identical target would
    // pile automation events onto the timeline for no audible difference.
    if (Math.abs(next - intensity) < 1e-3) return;
    intensity = next;
    try {
      applyIntensity();
    } catch {
      // Ignored: a rejected automation call is not worth a frame.
    }
  };

  const setMuted = (value: boolean): void => {
    if (active.disposed || muted === value) return;
    muted = value;
    try {
      applyMaster();
    } catch {
      // Ignored.
    }
  };

  const dispose = (): void => {
    if (active.disposed) return;
    active.disposed = true;
    try {
      for (const voice of [...active.voices]) stopVoice(active, voice);
      active.voices.clear();

      for (const source of active.permanentSources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      active.permanentSources.length = 0;

      for (const node of active.permanent) {
        try {
          node.disconnect();
        } catch {
          // Already detached.
        }
      }
      active.permanent.length = 0;
    } catch {
      // Teardown is best effort; the context belongs to the host either way.
    }
  };

  return { handleEvents, setCrowdIntensity, setMuted, dispose };
};
