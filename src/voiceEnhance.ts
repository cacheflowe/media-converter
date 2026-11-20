// Voice enhancement for the audio workspace, as a Mediabunny audio `process` hook.
// A small broadcast-style chain, all in plain TypeScript so it streams chunk by
// chunk (no OfflineAudioContext, and it respects trims and any output format):
//
//   low-cut (rumble/plosives) -> warmth + presence EQ -> compressor / gentle
//   noise gate -> loudness gain -> soft limiter
//
// Loudness normalization needs to know how loud the processed result is, so the
// caller first runs the chain over the clip in a measuring pass, then converts
// with the resulting gain.

import { AudioSample, AudioSampleSink } from "mediabunny";
import type { InputAudioTrack } from "mediabunny";

export type VoiceEnhanceOptions = {
  lowCut: boolean;
  eq: boolean;
  compress: boolean;
  gate: boolean;
  /** Target average loudness in dBFS (gated RMS), or null to leave the level alone. */
  targetDb: number | null;
  /** AI noise reduction: how much of the denoised audio to blend in (0-1), or null for off. */
  neuralMix: number | null;
};

type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

// RBJ audio-EQ-cookbook filters, normalized so a0 = 1
function normalize(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highpass(fs: number, f0: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  return normalize((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function shelf(type: "low" | "high", fs: number, f0: number, gainDb: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w);
  const alpha = (Math.sin(w) / 2) * Math.SQRT2; // shelf slope S = 1
  const k = 2 * Math.sqrt(A) * alpha;
  if (type === "low") {
    return normalize(
      A * (A + 1 - (A - 1) * cos + k),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - k),
      A + 1 + (A - 1) * cos + k,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - k,
    );
  }
  return normalize(
    A * (A + 1 + (A - 1) * cos + k),
    -2 * A * (A - 1 + (A + 1) * cos),
    A * (A + 1 + (A - 1) * cos - k),
    A + 1 - (A - 1) * cos + k,
    2 * (A - 1 - (A + 1) * cos),
    A + 1 - (A - 1) * cos - k,
  );
}

class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private c: BiquadCoeffs) {}
  process(x: number) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }
}

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (lin: number) => 20 * Math.log10(Math.max(lin, 1e-9));

// Dynamics settings
const COMP_THRESHOLD_DB = -22;
const COMP_RATIO = 3;
const COMP_KNEE_DB = 8;
const GATE_THRESHOLD_DB = -48;
const GATE_RANGE_DB = 10; // never pull the floor down more than this, to avoid a "pumping" gate
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.2;
const LIMIT_CEILING = 0.89;
const LEVEL_BLOCK_SECONDS = 0.4;
const MAX_NORMALIZE_GAIN_DB = 24;

/** Soft clip above the ceiling so normalized peaks round off instead of hard clipping. */
function softLimit(x: number) {
  const a = Math.abs(x);
  if (a <= LIMIT_CEILING) return x;
  const over = (a - LIMIT_CEILING) / (1 - LIMIT_CEILING);
  return Math.sign(x) * (LIMIT_CEILING + (1 - LIMIT_CEILING) * Math.tanh(over));
}

/** Gain change in dB for a signal level in dB (compression above the threshold, downward expansion below the gate). */
function dynamicsGainDb(levelDb: number, compress: boolean, gate: boolean) {
  let gain = 0;
  if (compress) {
    const over = levelDb - COMP_THRESHOLD_DB;
    const slope = 1 / COMP_RATIO - 1;
    if (over > COMP_KNEE_DB / 2) gain += slope * over;
    else if (over > -COMP_KNEE_DB / 2) gain += (slope * (over + COMP_KNEE_DB / 2) ** 2) / (2 * COMP_KNEE_DB);
  }
  if (gate && levelDb < GATE_THRESHOLD_DB) {
    gain -= Math.min(GATE_RANGE_DB, (GATE_THRESHOLD_DB - levelDb) * 0.5);
  }
  return gain;
}

export function createVoiceEnhancer(opts: VoiceEnhanceOptions, gainDb = 0, limit = true) {
  let sampleRate = 0;
  let channels = 0;
  let filters: Biquad[][] = []; // per channel
  let envelope = 0;
  let attackCoef = 0;
  let releaseCoef = 0;
  const gain = dbToLin(gainDb);
  const useDynamics = opts.compress || opts.gate;

  // Loudness measurement: mean square per 400 ms block of the processed (pre-gain) signal
  const blocks: number[] = [];
  let blockSum = 0;
  let blockFrames = 0;
  let blockLength = 0;

  function init(s: AudioSample) {
    sampleRate = s.sampleRate;
    channels = s.numberOfChannels;
    attackCoef = Math.exp(-1 / (ATTACK_SECONDS * sampleRate));
    releaseCoef = Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
    blockLength = Math.round(LEVEL_BLOCK_SECONDS * sampleRate);
    filters = Array.from({ length: channels }, () => {
      const chain: Biquad[] = [];
      if (opts.lowCut) chain.push(new Biquad(highpass(sampleRate, 80)));
      if (opts.eq) {
        chain.push(new Biquad(shelf("low", sampleRate, 150, 2.5)));
        chain.push(new Biquad(shelf("high", sampleRate, 5000, 3)));
      }
      return chain;
    });
  }

  function process(sample: AudioSample): AudioSample {
    if (!sampleRate) init(sample);
    const frames = sample.numberOfFrames;
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(frames);
      sample.copyTo(plane, { planeIndex: Math.min(c, sample.numberOfChannels - 1), format: "f32-planar" });
      planes.push(plane);
    }

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        let x = planes[c][i];
        for (const f of filters[c]) x = f.process(x);
        planes[c][i] = x;
        const a = Math.abs(x);
        if (a > peak) peak = a;
      }

      // One linked envelope for all channels so the stereo image doesn't shift
      let dyn = 1;
      if (useDynamics) {
        envelope = peak > envelope ? attackCoef * envelope + (1 - attackCoef) * peak : releaseCoef * envelope + (1 - releaseCoef) * peak;
        dyn = dbToLin(dynamicsGainDb(linToDb(envelope), opts.compress, opts.gate));
      }

      let sq = 0;
      for (let c = 0; c < channels; c++) {
        const x = planes[c][i] * dyn;
        sq += x * x;
        const y = x * gain;
        planes[c][i] = limit ? softLimit(y) : y;
      }
      blockSum += sq / channels;
      if (++blockFrames >= blockLength) {
        blocks.push(blockSum / blockFrames);
        blockSum = 0;
        blockFrames = 0;
      }
    }

    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) data.set(planes[c], c * frames);
    return new AudioSample({
      data,
      format: "f32-planar",
      numberOfChannels: channels,
      sampleRate,
      timestamp: sample.timestamp,
    });
  }

  /** Average loudness (dBFS, power mean) of the blocks that aren't near-silence, or null if there were none. */
  function measuredLoudnessDb(): number | null {
    const audible = blocks.filter((ms) => linToDb(Math.sqrt(ms)) > -50);
    if (!audible.length) return null;
    const mean = audible.reduce((a, b) => a + b, 0) / audible.length;
    // Relative gate: ignore blocks well below the average (pauses between phrases)
    const kept = audible.filter((ms) => ms > mean * 0.1);
    const keptMean = kept.reduce((a, b) => a + b, 0) / kept.length;
    return linToDb(Math.sqrt(keptMean));
  }

  return { process, measuredLoudnessDb };
}

/**
 * Runs the chain over the given audio without output to find the gain that
 * brings it to `targetDb`. Returns 0 when there's nothing to measure.
 */
export async function measureNormalizeGainDb(
  opts: VoiceEnhanceOptions,
  samples: AsyncIterable<AudioSample>,
  isCancelled: () => boolean,
): Promise<number> {
  if (opts.targetDb === null) return 0;
  const enhancer = createVoiceEnhancer(opts, 0, false);
  for await (const sample of samples) {
    if (isCancelled()) {
      sample.close();
      return 0;
    }
    enhancer.process(sample).close();
    sample.close();
  }
  const loudness = enhancer.measuredLoudnessDb();
  if (loudness === null) return 0;
  return Math.max(-MAX_NORMALIZE_GAIN_DB, Math.min(MAX_NORMALIZE_GAIN_DB, opts.targetDb - loudness));
}

/** The track's audio over the given source spans (an empty list means all of it). */
async function* trackSamples(track: InputAudioTrack, ranges: { start: number; end: number }[]) {
  const sink = new AudioSampleSink(track);
  const spans: { start?: number; end?: number }[] = ranges.length ? ranges : [{}];
  for (const range of spans) yield* sink.samples(range.start, range.end);
}

type AudioProcess = (sample: AudioSample) => AudioSample | AudioSample[] | null | Promise<AudioSample | AudioSample[] | null>;

/**
 * Builds the audio `process` hook: `pre` (if any) runs first on each incoming
 * chunk, then the existing hook (e.g. section joining or speed change), then the enhancer.
 */
export function chainEnhancer(
  inner: AudioProcess | undefined,
  enhancer: ReturnType<typeof createVoiceEnhancer>,
  pre?: (sample: AudioSample) => AudioSample,
): AudioProcess {
  if (!inner && !pre) return (sample) => enhancer.process(sample);
  return async (original) => {
    const sample = pre ? pre(original) : original;
    const result = inner ? await inner(sample) : sample;
    if (!result) {
      if (sample !== original) sample.close();
      return null;
    }
    const list = Array.isArray(result) ? result : [result];
    // Intermediate samples we or the inner hook created are ours to close
    const out = list.map((s) => {
      const enhanced = enhancer.process(s);
      if (s !== original) s.close();
      return enhanced;
    });
    if (sample !== original && !list.includes(sample)) sample.close();
    return Array.isArray(result) ? out : out[0];
  };
}

const canceled = () => Object.assign(new Error("canceled"), { name: "ConversionCanceledError" });

/**
 * Does the up-front work for enhancing a track (AI denoise pre-pass, loudness
 * measurement) and returns what the conversion needs.
 *
 * `span` is the trimmed region the conversion covers (null for the whole track);
 * `ranges` are the source sections that end up in the output (empty for all).
 */
export async function setupVoiceEnhance(args: {
  track: InputAudioTrack;
  options: VoiceEnhanceOptions;
  span: { start: number; end: number } | null;
  ranges: { start: number; end: number }[];
  onStatus: (message: string) => void;
  isCancelled: () => boolean;
}) {
  const { track, options, span, ranges, onStatus, isCancelled } = args;
  let pre: ((sample: AudioSample) => AudioSample) | undefined;
  let denoised: import("./neuralDenoise").DenoisedAudio | null = null;
  let neural: typeof import("./neuralDenoise") | null = null;

  if (options.neuralMix !== null) {
    neural = await import("./neuralDenoise");
    denoised = await neural.prepareDenoisedAudio(track, span, (message) => onStatus(`🧠 ${message}`), isCancelled);
    if (isCancelled()) throw canceled();
    if (denoised) pre = neural.createDenoiseSubstitute(denoised, options.neuralMix);
  }

  let gainDb = 0;
  if (options.targetDb !== null) {
    onStatus("🎙️ Measuring loudness...");
    const samples = denoised && neural ? neural.denoisedSamples(denoised, ranges) : trackSamples(track, ranges);
    gainDb = await measureNormalizeGainDb(options, samples, isCancelled);
    if (isCancelled()) throw canceled();
  }

  const enhancer = createVoiceEnhancer(options, gainDb);
  return {
    /** The AI denoiser only runs at 44.1 kHz, so the conversion's sample rate must be set to this. */
    sampleRate: pre ? neural!.DENOISER_SAMPLE_RATE : undefined,
    gainDb,
    denoised: !!pre,
    wrap: (inner?: AudioProcess) => chainEnhancer(inner, enhancer, pre),
  };
}

/** Wires up one "Enhance Voice" card (see enhanceVoiceCard in the template) and reads its settings. */
export function bindEnhanceControls(root: Document | ShadowRoot, prefix: string) {
  const el = <T extends HTMLElement>(name: string) => {
    const found = root.getElementById(`${prefix}-enhance-${name}`);
    if (!found) throw new Error(`DOM element not found: #${prefix}-enhance-${name}`);
    return found as T;
  };
  const enable = el<HTMLInputElement>("enable");
  const controls = el<HTMLDivElement>("controls");
  const neural = el<HTMLInputElement>("neural");
  const neuralMix = el<HTMLSelectElement>("neural-mix");
  const lowCut = el<HTMLInputElement>("lowcut");
  const eq = el<HTMLInputElement>("eq");
  const compress = el<HTMLInputElement>("compress");
  const gate = el<HTMLInputElement>("gate");
  const loudness = el<HTMLSelectElement>("loudness");

  enable.addEventListener("change", () => {
    controls.style.display = enable.checked ? "block" : "none";
  });
  neural.addEventListener("change", () => {
    neuralMix.disabled = !neural.checked;
  });

  /** The chosen settings, or null when enhancement is off (or every stage is unticked). */
  function getOptions(): VoiceEnhanceOptions | null {
    if (!enable.checked) return null;
    const targetDb = loudness.value === "off" ? null : parseFloat(loudness.value);
    const opts: VoiceEnhanceOptions = {
      lowCut: lowCut.checked,
      eq: eq.checked,
      compress: compress.checked,
      gate: gate.checked,
      targetDb,
      neuralMix: neural.checked ? parseFloat(neuralMix.value) : null,
    };
    const any = opts.lowCut || opts.eq || opts.compress || opts.gate || targetDb !== null || opts.neuralMix !== null;
    return any ? opts : null;
  }

  return { getOptions, panel: root.getElementById(`panel-${prefix}-enhance`) as HTMLElement | null };
}

