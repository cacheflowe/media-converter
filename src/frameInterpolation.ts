// AI frame interpolation (RIFE) as a Mediabunny video `process` hook.
//
// Source frames are retimed (for slow motion) and resampled onto a fixed output
// frame rate; output slots that fall between two source frames are synthesized
// by RIFE at the matching timestep instead of repeating or cross-fading frames.

import { VideoSample, type ConversionVideoOptions } from "mediabunny";
import { getModelSession, type ModelProgress, type OnnxModel } from "./onnxRuntime";

type VideoProcess = NonNullable<ConversionVideoOptions["process"]>;

// RIFE 4.9 (ensemble), exported with img0/img1/timestep inputs. MIT upstream:
// https://github.com/hzwer/Practical-RIFE — ONNX from https://huggingface.co/yuvraj108c/rife-onnx
export const RIFE_MODEL: OnnxModel = {
  label: "RIFE 4.9",
  url: "https://huggingface.co/yuvraj108c/rife-onnx/resolve/64de7265b6a06637c2f2c6a92ecd1972326499fe/rife49_ensemble_True_scale_1_sim.onnx",
  bytes: 21_458_882,
};

// RIFE's flow pyramid downsamples internally, so frames are padded to a multiple of this
const ALIGN = 64;
// Mean absolute difference (0–1) above which two frames are treated as a scene cut
const SCENE_CUT_THRESHOLD = 0.2;

export type FrameInterpolator = {
  label: string;
  /** Adds the next source frame; interpolation runs between the last two pushed. */
  push(source: CanvasImageSource, width: number, height: number): void;
  /** True when the last two frames differ too much to interpolate (e.g. a hard cut). */
  isSceneCut(): boolean;
  /** Synthesizes the frame at `t` (0–1) between the last two frames. The canvas is reused. */
  interpolate(t: number): Promise<HTMLCanvasElement>;
};

export async function createFrameInterpolator(onProgress: ModelProgress = () => {}): Promise<FrameInterpolator> {
  const { ort, session } = await getModelSession(RIFE_MODEL, onProgress);

  const padded = document.createElement("canvas");
  const paddedCtx = padded.getContext("2d", { willReadFrequently: true })!;
  const out = document.createElement("canvas");
  const outCtx = out.getContext("2d")!;
  let width = 0;
  let height = 0;
  let prev: Float32Array | null = null;
  let cur: Float32Array | null = null;

  /** Draws a frame edge-extended to the aligned size and returns planar RGB [0,1]. */
  function toPlanar(source: CanvasImageSource, w: number, h: number) {
    const pw = Math.ceil(w / ALIGN) * ALIGN;
    const ph = Math.ceil(h / ALIGN) * ALIGN;
    if (padded.width !== pw || padded.height !== ph) {
      padded.width = pw;
      padded.height = ph;
    }
    paddedCtx.drawImage(source, 0, 0, w, h);
    if (pw > w) paddedCtx.drawImage(padded, w - 1, 0, 1, h, w, 0, pw - w, h);
    if (ph > h) paddedCtx.drawImage(padded, 0, h - 1, pw, 1, 0, h, pw, ph - h);
    const rgba = paddedCtx.getImageData(0, 0, pw, ph).data;
    const plane = pw * ph;
    const data = new Float32Array(3 * plane);
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      data[i] = rgba[j] / 255;
      data[plane + i] = rgba[j + 1] / 255;
      data[2 * plane + i] = rgba[j + 2] / 255;
    }
    return data;
  }

  return {
    label: RIFE_MODEL.label,

    push(source, w, h) {
      // A size change (rare) starts a fresh pair
      if (w !== width || h !== height) {
        width = w;
        height = h;
        cur = null;
      }
      prev = cur;
      cur = toPlanar(source, w, h);
    },

    isSceneCut() {
      if (!prev || !cur) return false;
      let diff = 0;
      let n = 0;
      // Sparse sample is plenty to spot a cut
      for (let i = 0; i < cur.length; i += 97, n++) diff += Math.abs(cur[i] - prev[i]);
      return diff / n > SCENE_CUT_THRESHOLD;
    },

    async interpolate(t) {
      if (!prev || !cur) throw new Error("Interpolation needs two frames.");
      const pw = padded.width;
      const ph = padded.height;
      const dims = [1, 3, ph, pw];
      const feeds = {
        img0: new ort.Tensor("float32", prev, dims),
        img1: new ort.Tensor("float32", cur, dims),
        timestep: new ort.Tensor("float32", new Float32Array([t]), [1]),
      };
      const results = await session.run(feeds);
      const result = results[session.outputNames[0]];
      const data = result.data as Float32Array;

      // Planar RGB float → RGBA, cropped back to the frame size
      const plane = pw * ph;
      const img = new ImageData(width, height);
      const px = img.data;
      for (let y = 0, j = 0; y < height; y++) {
        for (let x = 0, i = y * pw; x < width; x++, i++, j += 4) {
          px[j] = data[i] * 255;
          px[j + 1] = data[plane + i] * 255;
          px[j + 2] = data[2 * plane + i] * 255;
          px[j + 3] = 255;
        }
      }
      result.dispose();
      if (out.width !== width || out.height !== height) {
        out.width = width;
        out.height = height;
      }
      outCtx.putImageData(img, 0, 0);
      return out;
    },
  };
}

/**
 * Resamples video onto `fps`, synthesizing in-between frames with RIFE. `speed`
 * below 1 gives smooth slow motion (source time is divided by `speed`).
 */
export function createInterpolationProcess(interp: FrameInterpolator, fps: number, speed = 1): VideoProcess {
  const interval = 1 / fps;
  const eps = interval * 1e-3;
  let prev: VideoSample | null = null;
  let prevTime = 0;
  let nextSlot = 0;
  let cuts = 0;

  const retimed = (s: VideoSample, timestamp: number) => {
    const copy = s.clone();
    copy.setTimestamp(timestamp);
    copy.setDuration(interval);
    return copy;
  };

  return async (sample) => {
    const time = sample.timestamp / speed;
    interp.push(sample.toCanvasImageSource(), sample.displayWidth, sample.displayHeight);

    if (!prev) {
      prev = sample.clone();
      prevTime = time;
      nextSlot = time + interval;
      return [retimed(sample, time)];
    }

    const step = time - prevTime;
    const isCut = interp.isSceneCut();
    if (isCut && ++cuts <= 5) console.log(`RIFE: scene cut at ${sample.timestamp.toFixed(2)}s — using nearest frames.`);

    const out: VideoSample[] = [];
    while (nextSlot <= time + eps) {
      const t = step > 0 ? Math.min(1, Math.max(0, (nextSlot - prevTime) / step)) : 1;
      if (t < 0.02 || (isCut && t < 0.5)) out.push(retimed(prev, nextSlot));
      else if (t > 0.98 || isCut) out.push(retimed(sample, nextSlot));
      else out.push(new VideoSample(await interp.interpolate(t), { timestamp: nextSlot, duration: interval }));
      nextSlot += interval;
    }

    prev.close();
    prev = sample.clone();
    prevTime = time;
    return out.length ? out : null;
  };
}
