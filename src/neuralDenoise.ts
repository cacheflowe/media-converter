// AI noise reduction using the Resemble Enhance denoiser (MIT), exported to ONNX by
// https://github.com/skeskinen/resemble-denoise-onnx-inference. This is the
// denoiser half of Resemble Enhance only: it cleans noise and room tone but, unlike
// the generative enhancer, doesn't invent audio, so it can't add artifacts of its own.
//
// The network works on STFT magnitude / cos / sin at 44.1 kHz (n_fft 1680, hop 420),
// so this file has a small FFT, the STFT/ISTFT (matching librosa's centered,
// reflect-padded transform), overlapped chunking for long audio, and the glue that
// swaps the denoised audio into a Mediabunny conversion.
//
// The denoiser needs the whole (trimmed) clip's audio up front, so it runs as a
// pre-pass: decode -> mono -> 44.1 kHz -> denoise. The conversion then replaces
// each audio chunk it sees with the matching denoised frames, in order.

import { AudioSample, AudioSampleSink } from "mediabunny";
import type { InputAudioTrack } from "mediabunny";
import { getModelSession, type ModelProgress, type OnnxModel } from "./onnxRuntime";

export const DENOISER_SAMPLE_RATE = 44_100;

export const DENOISER_MODEL: OnnxModel = {
  label: "Resemble denoiser",
  url: "https://raw.githubusercontent.com/skeskinen/resemble-denoise-onnx-inference/577726152f06c8d8d6a4137371a5bd29a9936a87/denoiser.onnx",
  bytes: 42_661_638,
};

const HOP = 420;
const N_FFT = 4 * HOP;
const BINS = N_FFT / 2 + 1;
const CHUNK_SECONDS = 12; // keeps the network's activations (which scale with length) modest
const OVERLAP_SECONDS = 0.5; // cross-faded between chunks

// ---------------------------------------------------------------------------
// FFT (mixed radix: 1680 = 2^4 * 3 * 5 * 7, so no power-of-two shortcut)
// ---------------------------------------------------------------------------

class MixedRadixFFT {
  private factors: number[] = [];
  private cos: Float64Array;
  private sin: Float64Array;
  private tmpRe = new Float64Array(16);
  private tmpIm = new Float64Array(16);

  constructor(readonly n: number) {
    let rest = n;
    for (const p of [4, 2, 3, 5, 7]) {
      while (rest % p === 0) {
        this.factors.push(p);
        rest /= p;
      }
    }
    for (let p = 11; rest > 1; p += 2) {
      while (rest % p === 0) {
        this.factors.push(p);
        rest /= p;
      }
    }
    if (this.factors.some((p) => p > 16)) throw new Error(`Unsupported FFT size ${n}`);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n); // forward transform: e^(-i...)
    }
  }

  /** Forward complex FFT of (inRe, inIm) into (outRe, outIm). */
  forward(inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array) {
    this.rec(inRe, inIm, 0, 1, outRe, outIm, 0, this.n, 0);
  }

  private rec(
    inRe: Float64Array,
    inIm: Float64Array,
    inOff: number,
    stride: number,
    outRe: Float64Array,
    outIm: Float64Array,
    outOff: number,
    n: number,
    fi: number,
  ) {
    if (n === 1) {
      outRe[outOff] = inRe[inOff];
      outIm[outOff] = inIm[inOff];
      return;
    }
    const p = this.factors[fi];
    const m = n / p;
    for (let r = 0; r < p; r++) {
      this.rec(inRe, inIm, inOff + r * stride, stride * p, outRe, outIm, outOff + r * m, m, fi + 1);
    }
    const { cos, sin, tmpRe, tmpIm } = this;
    const step = this.n / n; // W_n^j = W_N^(j*step)
    const pStep = this.n / p;
    for (let k = 0; k < m; k++) {
      for (let r = 0; r < p; r++) {
        const idx = outOff + r * m + k;
        const t = r * k * step;
        const wr = cos[t];
        const wi = sin[t];
        tmpRe[r] = outRe[idx] * wr - outIm[idx] * wi;
        tmpIm[r] = outRe[idx] * wi + outIm[idx] * wr;
      }
      for (let q = 0; q < p; q++) {
        let sr = 0;
        let si = 0;
        for (let r = 0; r < p; r++) {
          const t = ((r * q) % p) * pStep;
          sr += tmpRe[r] * cos[t] - tmpIm[r] * sin[t];
          si += tmpRe[r] * sin[t] + tmpIm[r] * cos[t];
        }
        outRe[outOff + k + q * m] = sr;
        outIm[outOff + k + q * m] = si;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STFT / ISTFT (librosa-compatible: periodic Hann, center=True, reflect padding)
// ---------------------------------------------------------------------------

const WINDOW = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

function reflect(i: number, len: number) {
  const period = 2 * (len - 1);
  let j = ((i % period) + period) % period;
  if (j >= len) j = period - j;
  return j;
}

type Spectrogram = { mag: Float32Array; cos: Float32Array; sin: Float32Array; frames: number };

/** STFT as (bins x frames) planes, dropping the final frame like the reference. */
function stft(x: Float32Array, fft: MixedRadixFFT): Spectrogram {
  const frames = Math.floor(x.length / HOP);
  const mag = new Float32Array(BINS * frames);
  const cos = new Float32Array(BINS * frames);
  const sin = new Float32Array(BINS * frames);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const outRe = new Float64Array(N_FFT);
  const outIm = new Float64Array(N_FFT);
  const half = N_FFT / 2;
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - half;
    for (let i = 0; i < N_FFT; i++) {
      const j = start + i;
      const v = j >= 0 && j < x.length ? x[j] : x[reflect(j, x.length)];
      re[i] = v * WINDOW[i];
      im[i] = 0;
    }
    fft.forward(re, im, outRe, outIm);
    for (let k = 0; k < BINS; k++) {
      const a = outRe[k];
      const b = outIm[k];
      const m = Math.hypot(a, b);
      const o = k * frames + t;
      mag[o] = m;
      cos[o] = m > 0 ? a / m : 1;
      sin[o] = m > 0 ? b / m : 0;
    }
  }
  return { mag, cos, sin, frames };
}

/** Inverse of stft(): repeats the last frame (as the reference does), overlap-adds, normalizes by the window envelope. */
function istft(spec: Spectrogram, length: number, fft: MixedRadixFFT): Float32Array {
  const frames = spec.frames + 1;
  const total = N_FFT + HOP * (frames - 1);
  const acc = new Float64Array(total);
  const env = new Float64Array(total);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const outRe = new Float64Array(N_FFT);
  const outIm = new Float64Array(N_FFT);
  for (let t = 0; t < frames; t++) {
    const src = Math.min(t, spec.frames - 1);
    for (let k = 0; k < BINS; k++) {
      const o = k * spec.frames + src;
      const a = spec.mag[o] * spec.cos[o];
      let b = spec.mag[o] * spec.sin[o];
      if (k === 0 || k === BINS - 1) b = 0; // irfft ignores the DC/Nyquist imaginary parts
      // Conjugated input, so a forward FFT gives the inverse transform (conjugated)
      re[k] = a;
      im[k] = -b;
      if (k > 0 && k < BINS - 1) {
        re[N_FFT - k] = a;
        im[N_FFT - k] = b;
      }
    }
    fft.forward(re, im, outRe, outIm);
    const base = t * HOP;
    for (let i = 0; i < N_FFT; i++) {
      acc[base + i] += (outRe[i] / N_FFT) * WINDOW[i];
      env[base + i] += WINDOW[i] * WINDOW[i];
    }
  }
  const out = new Float32Array(length);
  const half = N_FFT / 2;
  for (let i = 0; i < length; i++) {
    const j = i + half;
    if (j >= total) break;
    out[i] = env[j] > 1e-11 ? acc[j] / env[j] : acc[j];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running the network
// ---------------------------------------------------------------------------

type Session = Awaited<ReturnType<typeof getModelSession>>;

async function runChunk(handle: Session, fft: MixedRadixFFT, wav: Float32Array): Promise<Float32Array> {
  const { ort, session } = handle;
  // The reference pads 441 samples before the STFT and trims them afterwards
  const padded = new Float32Array(wav.length + 441);
  padded.set(wav);
  const spec = stft(padded, fft);
  const dims = [1, BINS, spec.frames];
  const results = await session.run({
    mag: new ort.Tensor("float32", spec.mag, dims),
    cos: new ort.Tensor("float32", spec.cos, dims),
    sin: new ort.Tensor("float32", spec.sin, dims),
  });
  const [m, c, s] = session.outputNames.map((name) => results[name].data as Float32Array);
  const out = istft({ mag: m, cos: c, sin: s, frames: spec.frames }, padded.length, fft);
  return out.subarray(0, wav.length);
}

/** Denoises mono 44.1 kHz audio. Long clips are processed in overlapping chunks and cross-faded. */
export async function denoiseMono(
  pcm: Float32Array,
  onProgress: ModelProgress,
  isCancelled: () => boolean,
): Promise<Float32Array> {
  onProgress("Loading AI denoiser…");
  const handle = await getModelSession(DENOISER_MODEL, onProgress);
  const fft = new MixedRadixFFT(N_FFT);

  const chunk = CHUNK_SECONDS * DENOISER_SAMPLE_RATE;
  const overlap = Math.round(OVERLAP_SECONDS * DENOISER_SAMPLE_RATE);
  const step = chunk - overlap;
  const out = new Float32Array(pcm.length);
  const total = Math.max(1, Math.ceil(Math.max(0, pcm.length - overlap) / step));

  for (let i = 0, start = 0; start < pcm.length; i++, start += step) {
    if (isCancelled()) return out;
    onProgress(`Reducing noise… ${Math.round((i / total) * 100)}%`, i / total);
    const end = Math.min(pcm.length, start + chunk);
    const input = pcm.slice(start, end);
    // The reference normalizes each chunk by its peak so quiet recordings still use the model's range
    let peak = 1e-7;
    for (const v of input) peak = Math.max(peak, Math.abs(v));
    for (let j = 0; j < input.length; j++) input[j] /= peak;
    const cleaned = await runChunk(handle, fft, input);
    const last = end === pcm.length;
    for (let j = 0; j < cleaned.length; j++) {
      // Linear cross-fade over the overlap with the previous / next chunk
      let w = 1;
      if (start > 0 && j < overlap) w = j / overlap;
      if (!last && j >= cleaned.length - overlap) w = Math.min(w, (cleaned.length - j) / overlap);
      out[start + j] += cleaned[j] * peak * w;
    }
    if (last) break;
  }
  onProgress("Reducing noise… 100%", 1);
  return out;
}

// ---------------------------------------------------------------------------
// Mediabunny integration
// ---------------------------------------------------------------------------

export type DenoisedAudio = {
  /** Denoised mono audio at 44.1 kHz, covering the conversion's span from its start. */
  pcm: Float32Array;
  /** Source timestamp (seconds) of the first frame. */
  start: number;
};

/** Resamples mono audio with the browser's resampler (a no-op at the same rate). */
async function resampleMono(pcm: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to || !pcm.length) return pcm;
  const ctx = new OfflineAudioContext(1, Math.ceil((pcm.length * to) / from), to);
  const buffer = ctx.createBuffer(1, pcm.length, from);
  buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * Decodes the audio the conversion will see (trimmed to `span`, using the same
 * frame rounding as Mediabunny's conversion), denoises it, and returns it.
 */
export async function prepareDenoisedAudio(
  track: InputAudioTrack,
  span: { start: number; end: number } | null,
  onProgress: ModelProgress,
  isCancelled: () => boolean,
): Promise<DenoisedAudio | null> {
  onProgress("Decoding audio…");
  const sink = new AudioSampleSink(track);
  const chunks: Float32Array[] = [];
  let total = 0;
  let sourceRate = DENOISER_SAMPLE_RATE;
  let firstTimestamp: number | null = null;

  for await (const sample of sink.samples(span?.start, span?.end)) {
    if (isCancelled()) {
      sample.close();
      return null;
    }
    sourceRate = sample.sampleRate;
    let startFrame = 0;
    let endFrame = sample.numberOfFrames;
    if (span && sample.timestamp < span.start) startFrame = Math.round((span.start - sample.timestamp) * sample.sampleRate);
    if (span && sample.timestamp + sample.duration > span.end) endFrame = Math.round((span.end - sample.timestamp) * sample.sampleRate);
    if (startFrame < endFrame) {
      firstTimestamp ??= Math.max(sample.timestamp, span?.start ?? 0);
      const frames = endFrame - startFrame;
      const mono = new Float32Array(frames);
      const plane = new Float32Array(sample.numberOfFrames);
      for (let c = 0; c < sample.numberOfChannels; c++) {
        sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        for (let i = 0; i < frames; i++) mono[i] += plane[startFrame + i] / sample.numberOfChannels;
      }
      chunks.push(mono);
      total += frames;
    }
    sample.close();
  }
  if (!total) return null;

  const raw = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    raw.set(c, offset);
    offset += c.length;
  }
  chunks.length = 0;

  const pcm44 = await resampleMono(raw, sourceRate, DENOISER_SAMPLE_RATE);
  const cleaned = await denoiseMono(pcm44, onProgress, isCancelled);
  if (isCancelled()) return null;
  return { pcm: cleaned, start: firstTimestamp ?? 0 };
}

/**
 * An audio `process` step that swaps each incoming chunk's content for the
 * denoised audio at the same position (blended with the original by `mix`, 0-1).
 * The conversion must run at 44.1 kHz so chunks line up one-to-one.
 */
export function createDenoiseSubstitute(denoised: DenoisedAudio, mix: number) {
  let cursor = 0;
  let warned = false;
  return (sample: AudioSample): AudioSample => {
    const frames = sample.numberOfFrames;
    const channels = sample.numberOfChannels;
    if (sample.sampleRate !== DENOISER_SAMPLE_RATE) {
      if (!warned) console.warn(`AI denoise skipped: audio is ${sample.sampleRate} Hz, expected ${DENOISER_SAMPLE_RATE} Hz.`);
      warned = true;
      return sample.clone();
    }
    const data = new Float32Array(frames * channels);
    const plane = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
      sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      const base = c * frames;
      for (let i = 0; i < frames; i++) {
        const wet = denoised.pcm[cursor + i] ?? 0;
        data[base + i] = mix * wet + (1 - mix) * plane[i];
      }
    }
    cursor += frames;
    return new AudioSample({
      data,
      format: "f32-planar",
      numberOfChannels: channels,
      sampleRate: sample.sampleRate,
      timestamp: sample.timestamp,
    });
  };
}

/** The denoised audio as mono AudioSamples (for loudness measurement), limited to the given source spans. */
export async function* denoisedSamples(denoised: DenoisedAudio, ranges: { start: number; end: number }[]) {
  const piece = 4096;
  const spans = ranges.length ? ranges : [{ start: denoised.start, end: denoised.start + denoised.pcm.length / DENOISER_SAMPLE_RATE }];
  for (const range of spans) {
    const from = Math.max(0, Math.round((range.start - denoised.start) * DENOISER_SAMPLE_RATE));
    const to = Math.min(denoised.pcm.length, Math.round((range.end - denoised.start) * DENOISER_SAMPLE_RATE));
    for (let i = from; i < to; i += piece) {
      const data = denoised.pcm.slice(i, Math.min(to, i + piece));
      yield new AudioSample({
        data,
        format: "f32-planar",
        numberOfChannels: 1,
        sampleRate: DENOISER_SAMPLE_RATE,
        timestamp: i / DENOISER_SAMPLE_RATE,
      });
    }
  }
}
