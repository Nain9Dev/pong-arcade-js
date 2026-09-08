import type { AudioPort } from '../../application/ports';
import type {
  DomainEvent,
  PaddleHitEvent,
  PaddleMissEvent,
  PointScoredEvent,
  ServeEvent,
  WallBounceEvent,
} from '../../domain/events';
import { clamp } from '../../domain/math/vec3';

/**
 * Fully synthesised audio adapter — no sample files, no network.
 *
 * Every sound is built from oscillators and one shared noise buffer, so the game
 * ships as a single bundle and the mix reacts continuously to gameplay values
 * (ball speed, impact intensity, contact offset) instead of replaying a fixed
 * clip. All gain changes are ramped: assigning `AudioParam.value` while a node
 * is audible produces a step discontinuity that the ear hears as a click.
 */

const MASTER_LEVEL = 0.85;
const MUTE_RAMP = 0.06;
const AMBIENT_RAMP = 0.4;
const NOISE_SECONDS = 2;

/**
 * Ceiling on simultaneously scheduled one-shots. A stalled tab can flush a long
 * burst of queued events at once; without a cap that allocates hundreds of nodes
 * in a single frame and the compressor ducks the whole mix.
 */
const MAX_VOICES = 48;

/**
 * Ball speed window, mirroring `DEFAULT_BALL_RULES.serveSpeed`/`maxSpeed`.
 * Duplicated rather than injected because `AudioPort` is never handed the rules;
 * these values only map speed onto pitch, so drift changes timbre, never play.
 */
const SPEED_MIN = 22;
const SPEED_MAX = 62;

/** Mirrors `DEFAULT_ARENA.halfWidth`, used to normalise world x into stereo pan. */
const HALF_WIDTH = 9;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

interface AudioGraph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly noise: AudioBuffer;
  readonly ambientGain: GainNode;
  readonly ambientFilter: BiquadFilterNode;
  /** Live sources, so `dispose` can stop anything still scheduled. */
  readonly sources: Set<AudioScheduledSourceNode>;
}

const resolveContextCtor = (): AudioContextCtor | null => {
  const scope = globalThis as unknown as Record<string, unknown>;
  const candidate = scope['AudioContext'] ?? scope['webkitAudioContext'];
  return typeof candidate === 'function' ? (candidate as AudioContextCtor) : null;
};

const finite = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);

const norm01 = (value: number, min: number, max: number): number =>
  clamp((finite(value, min) - min) / (max - min), 0, 1);

const panOf = (value: number): number => clamp(finite(value), -1, 1);

const buildNoise = (ctx: AudioContext): AudioBuffer => {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) channel[i] = Math.random() * 2 - 1;
  return buffer;
};

const track = (graph: AudioGraph, node: AudioScheduledSourceNode): void => {
  graph.sources.add(node);
  node.onended = () => {
    graph.sources.delete(node);
    node.disconnect();
  };
};

const canPlay = (graph: AudioGraph): boolean =>
  graph.ctx.state !== 'closed' && graph.sources.size < MAX_VOICES;

const startOsc = (
  graph: AudioGraph,
  osc: OscillatorNode,
  when: number,
  stopAt: number,
): void => {
  track(graph, osc);
  osc.start(when);
  osc.stop(stopAt);
};

const createNoiseSource = (graph: AudioGraph): AudioBufferSourceNode => {
  const source = graph.ctx.createBufferSource();
  source.buffer = graph.noise;
  return source;
};

const startNoise = (
  graph: AudioGraph,
  source: AudioBufferSourceNode,
  when: number,
  duration: number,
): void => {
  track(graph, source);
  // Random window into the shared buffer: replaying the same samples every time
  // produces an obvious "machine gun" repetition on fast rallies.
  const span = Math.max(0, graph.noise.duration - duration);
  source.start(when, Math.random() * span, duration);
};

/**
 * Percussive envelope. The exponential tail needs a strictly positive target,
 * hence the epsilon floor rather than a ramp to zero.
 */
const strike = (
  param: AudioParam,
  when: number,
  peak: number,
  attack: number,
  decay: number,
): void => {
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.exponentialRampToValueAtTime(0.0001, when + attack + decay);
};

/** Swell envelope for sustained gestures (serve whoosh, whiff). */
const swell = (
  param: AudioParam,
  when: number,
  peak: number,
  duration: number,
): void => {
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(peak, when + duration * 0.55);
  param.exponentialRampToValueAtTime(0.0001, when + duration);
};

/** Stereo placement stage; falls back to a bare gain where panning is unsupported. */
const panStage = (graph: AudioGraph, pan: number): AudioNode => {
  if (typeof graph.ctx.createStereoPanner === 'function') {
    const panner = graph.ctx.createStereoPanner();
    panner.pan.setValueAtTime(panOf(pan), graph.ctx.currentTime);
    panner.connect(graph.master);
    return panner;
  }
  const passthrough = graph.ctx.createGain();
  passthrough.connect(graph.master);
  return passthrough;
};

const pluck = (
  graph: AudioGraph,
  freq: number,
  when: number,
  duration: number,
  peak: number,
  pan: number,
): void => {
  if (!canPlay(graph)) return;
  const { ctx } = graph;

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, when);

  const gain = ctx.createGain();
  strike(gain.gain, when, peak, 0.008, duration);

  osc.connect(gain).connect(panStage(graph, pan));
  startOsc(graph, osc, when, when + duration + 0.05);
};

const playPaddleHit = (graph: AudioGraph, event: PaddleHitEvent): void => {
  if (!canPlay(graph)) return;
  const { ctx } = graph;
  const now = ctx.currentTime;
  const heat = norm01(event.speed, SPEED_MIN, SPEED_MAX);
  const offsetX = panOf(event.offset.x);
  const freq = 200 + heat * 460;

  const body = ctx.createOscillator();
  body.type = 'triangle';
  // Downward pitch drop is what makes the transient read as an impact rather
  // than a note; the faster the ball, the higher the whole gesture sits.
  body.frequency.setValueAtTime(freq * 1.75, now);
  body.frequency.exponentialRampToValueAtTime(freq, now + 0.045);
  // Off-centre contacts are recognisable by ear, not only by stereo position.
  body.detune.setValueAtTime(offsetX * 150, now);

  const bodyGain = ctx.createGain();
  strike(bodyGain.gain, now, 0.42 + heat * 0.18, 0.003, 0.15);

  const out = panStage(graph, offsetX * 0.85);
  body.connect(bodyGain).connect(out);
  startOsc(graph, body, now, now + 0.24);

  if (!event.edge) return;
  // Inharmonic partial: an integer ratio would fuse into the body and just sound
  // louder, so the metallic edge cue uses a deliberately non-integer multiple.
  const clang = ctx.createOscillator();
  clang.type = 'square';
  clang.frequency.setValueAtTime(freq * 4.37, now);

  const clangGain = ctx.createGain();
  strike(clangGain.gain, now, 0.09, 0.002, 0.1);

  const clangFilter = ctx.createBiquadFilter();
  clangFilter.type = 'bandpass';
  clangFilter.frequency.setValueAtTime(freq * 4.37, now);
  clangFilter.Q.setValueAtTime(6, now);

  clang.connect(clangFilter).connect(clangGain).connect(out);
  startOsc(graph, clang, now, now + 0.16);
};

const playWallBounce = (graph: AudioGraph, event: WallBounceEvent): void => {
  if (!canPlay(graph)) return;
  const { ctx } = graph;
  const now = ctx.currentTime;
  const intensity = clamp(finite(event.intensity), 0, 1);

  const source = createNoiseSource(graph);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  // Ceiling and floor bounces sit lower so the two axes stay distinguishable.
  filter.frequency.setValueAtTime(event.axis === 'x' ? 1500 : 900, now);
  filter.Q.setValueAtTime(1.4, now);

  const gain = ctx.createGain();
  strike(gain.gain, now, 0.05 + intensity * 0.3, 0.002, 0.07 + intensity * 0.05);

  source.connect(filter).connect(gain).connect(panStage(graph, event.position.x / HALF_WIDTH));
  startNoise(graph, source, now, 0.18);
};

const playPaddleMiss = (graph: AudioGraph, event: PaddleMissEvent): void => {
  if (!canPlay(graph)) return;
  const { ctx } = graph;
  const now = ctx.currentTime;
  const duration = 0.5;
  const out = panStage(graph, event.position.x / HALF_WIDTH);

  const tone = ctx.createOscillator();
  tone.type = 'sawtooth';
  tone.frequency.setValueAtTime(340, now);
  tone.frequency.exponentialRampToValueAtTime(70, now + duration);

  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = 'lowpass';
  toneFilter.frequency.setValueAtTime(1800, now);
  toneFilter.frequency.exponentialRampToValueAtTime(260, now + duration);

  const toneGain = ctx.createGain();
  swell(toneGain.gain, now, 0.22, duration);

  tone.connect(toneFilter).connect(toneGain).connect(out);
  startOsc(graph, tone, now, now + duration + 0.05);

  const air = createNoiseSource(graph);
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = 'bandpass';
  airFilter.frequency.setValueAtTime(1600, now);
  airFilter.frequency.exponentialRampToValueAtTime(240, now + duration);
  airFilter.Q.setValueAtTime(2.2, now);

  const airGain = ctx.createGain();
  swell(airGain.gain, now, 0.14, duration);

  air.connect(airFilter).connect(airGain).connect(out);
  startNoise(graph, air, now, duration);
};

const playPointScored = (graph: AudioGraph, event: PointScoredEvent): void => {
  // Direction of the motif tells the player who scored without reading the HUD.
  const ascending = event.scorer === 'near';
  const first = ascending ? 523.25 : 659.25;
  const second = ascending ? 783.99 : 392.0;
  const now = graph.ctx.currentTime;
  pluck(graph, first, now, 0.16, 0.3, 0);
  pluck(graph, second, now + 0.13, 0.3, 0.28, 0);
};

const playServe = (graph: AudioGraph, event: ServeEvent): void => {
  if (!canPlay(graph)) return;
  const { ctx } = graph;
  const now = ctx.currentTime;
  const duration = 0.55;
  const heat = norm01(event.speed, SPEED_MIN, SPEED_MAX);

  const source = createNoiseSource(graph);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(180, now);
  filter.frequency.exponentialRampToValueAtTime(1800 + heat * 900, now + duration);
  filter.Q.setValueAtTime(3.5, now);

  const gain = ctx.createGain();
  swell(gain.gain, now, 0.26, duration);

  // A rising sweep panned towards the receiving end reads as the ball leaving.
  source.connect(filter).connect(gain).connect(panStage(graph, 0));
  startNoise(graph, source, now, duration);
};

const playMatchWon = (graph: AudioGraph): void => {
  const now = graph.ctx.currentTime;
  // Scheduled on the audio clock: setTimeout jitters by whole frames, which is
  // audible as sloppy timing on an arpeggio this fast.
  const notes: readonly number[] = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, index) => {
    pluck(graph, freq, now + index * 0.11, index === notes.length - 1 ? 0.55 : 0.2, 0.3, 0);
  });
};

const dispatch = (graph: AudioGraph, event: DomainEvent): void => {
  switch (event.type) {
    case 'paddle-hit':
      playPaddleHit(graph, event);
      return;
    case 'wall-bounce':
      playWallBounce(graph, event);
      return;
    case 'paddle-miss':
      playPaddleMiss(graph, event);
      return;
    case 'point-scored':
      playPointScored(graph, event);
      return;
    case 'serve':
      playServe(graph, event);
      return;
    case 'match-won':
      playMatchWon(graph);
      return;
  }
};

const buildGraph = (ctx: AudioContext): AudioGraph => {
  const compressor = ctx.createDynamicsCompressor();
  // Gentle settings: this is a safety net against overlapping transients, not a
  // loudness effect, so the ratio stays low and the knee wide.
  compressor.threshold.value = -20;
  compressor.knee.value = 26;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.22;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(compressor);

  const ambientGain = ctx.createGain();
  ambientGain.gain.value = 0;
  ambientGain.connect(master);

  const ambientFilter = ctx.createBiquadFilter();
  ambientFilter.type = 'lowpass';
  ambientFilter.frequency.value = 120;
  ambientFilter.Q.value = 0.7;
  ambientFilter.connect(ambientGain);

  const graph: AudioGraph = {
    ctx,
    master,
    noise: buildNoise(ctx),
    ambientGain,
    ambientFilter,
    sources: new Set<AudioScheduledSourceNode>(),
  };

  // The bed runs for the lifetime of the context; only its gain and cutoff move,
  // so raising intensity can never restart a phase and click.
  const now = ctx.currentTime;
  for (const detune of [-7, 7]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, now);
    osc.detune.setValueAtTime(detune, now);
    osc.connect(ambientFilter);
    track(graph, osc);
    osc.start(now);
  }

  return graph;
};

/**
 * Web Audio implementation of `AudioPort`.
 *
 * Degrades to a silent no-op when the platform has no `AudioContext` or when the
 * context cannot be constructed: audio is never worth failing a frame over.
 */
import type { ComedyLayer } from './comedy-audio';
import { createComedyLayer } from './comedy-audio';

export const createWebAudio = (): AudioPort => {
  let graph: AudioGraph | null = null;
  // The comedy layer shares this adapter's context and master bus, so muting and
  // disposal stay in one place and the game never sees two audio systems.
  let comedy: ComedyLayer | null = null;
  let muted = false;
  let intensity = 0;
  let disposed = false;
  let unavailable = false;

  const applyMaster = (): void => {
    comedy?.setMuted(muted);
    if (!graph) return;
    // A fresh `setTargetAtTime` supersedes the pending one from its own start
    // time and inherits the current smoothed value, so cancelling first would
    // only risk the documented revert-to-previous-value behaviour.
    const target = muted ? 0 : MASTER_LEVEL;
    graph.master.gain.setTargetAtTime(target, graph.ctx.currentTime, MUTE_RAMP);
  };

  const applyIntensity = (): void => {
    comedy?.setCrowdIntensity(intensity);
    if (!graph) return;
    const now = graph.ctx.currentTime;
    // Curved so the bed stays out of the way during calm rallies and only opens
    // up near the top of the range; exactly zero gain at v = 0 keeps it silent.
    const level = intensity ** 1.5 * 0.16;
    const cutoff = 110 + intensity ** 1.3 * 1500;
    graph.ambientGain.gain.setTargetAtTime(level, now, AMBIENT_RAMP);
    graph.ambientFilter.frequency.setTargetAtTime(cutoff, now, AMBIENT_RAMP);
  };

  const unlock = (): void => {
    if (disposed || unavailable) return;

    if (!graph) {
      const Ctor = resolveContextCtor();
      if (!Ctor) {
        unavailable = true;
        return;
      }
      try {
        graph = buildGraph(new Ctor());
        comedy = createComedyLayer(graph.ctx, graph.master);
      } catch {
        unavailable = true;
        return;
      }
      applyMaster();
      applyIntensity();
    }

    if (graph.ctx.state === 'suspended') {
      // Autoplay policy: the first resume only succeeds inside a user gesture,
      // and a rejection here is expected, not exceptional.
      void graph.ctx.resume().catch(() => undefined);
    }
  };

  const handleEvents = (events: readonly DomainEvent[]): void => {
    const active = graph;
    if (!active || active.ctx.state !== 'running') return;
    for (const event of events) dispatch(active, event);
  };

  const setIntensity = (value: number): void => {
    const next = clamp(finite(value), 0, 1);
    // Called once per rendered frame; re-scheduling an identical target would
    // pile automation events onto the timeline for no audible difference.
    if (Math.abs(next - intensity) < 1e-3) return;
    intensity = next;
    applyIntensity();
  };

  const setMuted = (value: boolean): void => {
    if (muted === value) return;
    muted = value;
    applyMaster();
  };

  const dispose = (): void => {
    disposed = true;
    const active = graph;
    graph = null;
    if (!active) return;

    for (const source of [...active.sources]) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped or never started; nothing to unwind.
      }
      source.disconnect();
    }
    active.sources.clear();
    comedy?.dispose();
    comedy = null;
    active.master.disconnect();
    if (active.ctx.state !== 'closed') void active.ctx.close().catch(() => undefined);
  };

  return {
    unlock,
    handleEvents(events) {
      handleEvents(events);
      comedy?.handleEvents(events);
    },
    setIntensity,
    setMuted,
    get muted(): boolean {
      return muted;
    },
    dispose,
  };
};
