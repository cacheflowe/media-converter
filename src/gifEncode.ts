// GIF encoding core, with no browser or Mediabunny dependencies (so it can be
// tested in Node). Takes already-downsampled RGB frames plus a slot timeline and
// produces a GIF89a with:
//   - one global palette sampled across the whole clip (no per-frame flicker),
//   - frame differencing: pixels that didn't change (within a tolerance) become a
//     reserved transparent index, drawn with disposal 1 ("do not dispose"),
//   - merging of frames that didn't change at all into the previous frame's delay,
//     keeping the total time exact (10 ms delay units, rounding carried forward),
//   - optional ordered (Bayer) dithering, off by default.
// gifenc (MIT) does the quantizing and LZW; it is imported lazily.

export type GifEncodeOptions = {
  width: number;
  height: number;
  /** Palette size including the transparent slot, 2–256. */
  colors: number;
  dither: boolean;
  /** Make unchanged pixels transparent (disposal 1). Off = every frame is fully opaque. */
  diff: boolean;
  /** Per-pixel change tolerance as an RGB distance (0 = only exact palette matches count as unchanged). */
  tolerance: number;
  /** Loop forever (NETSCAPE2.0, count 0), or play once. */
  loop: boolean;
};

export type GifBuild = {
  bytes: Uint8Array;
  /** Frames actually written. */
  kept: number;
  /** Timeline slots that were merged into a previous frame. */
  dropped: number;
  /** Total timeline slots (kept + dropped). */
  slots: number;
  /** Frame delays in centiseconds, one per kept frame. */
  delays: number[];
  /** Total duration in seconds, as the GIF will play it. */
  duration: number;
  paletteSize: number;
  /** Index of the transparent colour, or -1 when transparency isn't used. */
  transparentIndex: number;
};

type Hooks = { onProgress?: (fraction: number) => void; isCancelled?: () => boolean };

export const MIN_DELAY_CS = 2; // browsers clamp anything below ~20 ms

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Precomputed box-filter taps for one axis: each output pixel averages the source range it covers. */
function axisPlan(srcN: number, dstN: number) {
  const scale = srcN / dstN;
  const starts = new Int32Array(dstN);
  const weights: Float32Array[] = [];
  for (let i = 0; i < dstN; i++) {
    const s0 = i * scale;
    const s1 = (i + 1) * scale;
    const a = Math.min(srcN - 1, Math.floor(s0));
    const b = Math.max(a + 1, Math.min(srcN, Math.ceil(s1 - 1e-9)));
    const w = new Float32Array(b - a);
    let sum = 0;
    for (let px = a; px < b; px++) {
      const wt = Math.max(0, Math.min(px + 1, s1) - Math.max(px, s0));
      w[px - a] = wt;
      sum += wt;
    }
    if (sum <= 0) w[0] = sum = 1;
    for (let k = 0; k < w.length; k++) w[k] /= sum;
    starts[i] = a;
    weights.push(w);
  }
  return { starts, weights };
}

export type Downsampler = (rgba: Uint8ClampedArray | Uint8Array, punch: boolean) => Uint8Array;

/**
 * Area-average (box filter) downsampler: every source pixel that falls inside an
 * output pixel contributes, weighted by the fraction of it that overlaps. This is
 * what keeps tiny pixel-art output from aliasing and shimmering. Optionally boosts
 * contrast and saturation slightly, since LEDs read flat.
 */
export function createDownsampler(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mode: "area" | "nearest" = "area",
): Downsampler {
  if (mode === "nearest") return createNearestSampler(srcW, srcH, dstW, dstH);
  const px = axisPlan(srcW, dstW);
  const py = axisPlan(srcH, dstH);
  const tmp = new Float32Array(dstW * srcH * 3);
  return (rgba, punch) => {
    for (let y = 0; y < srcH; y++) {
      const row = y * srcW * 4;
      for (let ox = 0; ox < dstW; ox++) {
        const a = px.starts[ox];
        const w = px.weights[ox];
        let r = 0;
        let g = 0;
        let b = 0;
        for (let k = 0; k < w.length; k++) {
          const i = row + (a + k) * 4;
          const wk = w[k];
          r += wk * rgba[i];
          g += wk * rgba[i + 1];
          b += wk * rgba[i + 2];
        }
        const o = (y * dstW + ox) * 3;
        tmp[o] = r;
        tmp[o + 1] = g;
        tmp[o + 2] = b;
      }
    }
    const out = new Uint8Array(dstW * dstH * 3);
    for (let oy = 0; oy < dstH; oy++) {
      const a = py.starts[oy];
      const w = py.weights[oy];
      for (let ox = 0; ox < dstW; ox++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let k = 0; k < w.length; k++) {
          const i = ((a + k) * dstW + ox) * 3;
          const wk = w[k];
          r += wk * tmp[i];
          g += wk * tmp[i + 1];
          b += wk * tmp[i + 2];
        }
        if (punch) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          r = (lum + (r - lum) * 1.25 - 128) * 1.1 + 128;
          g = (lum + (g - lum) * 1.25 - 128) * 1.1 + 128;
          b = (lum + (b - lum) * 1.25 - 128) * 1.1 + 128;
        }
        const o = (oy * dstW + ox) * 3;
        out[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      }
    }
    return out;
  };
}

/**
 * Pixel-exact sampler: each output pixel is the source pixel at the center of the block it
 * covers. For art made of whole pixel blocks (e.g. a 32×32 animation scaled up 10×) this
 * recovers the original pixels exactly, with no blending at block edges.
 */
function createNearestSampler(srcW: number, srcH: number, dstW: number, dstH: number): Downsampler {
  const xs = new Int32Array(dstW);
  const ys = new Int32Array(dstH);
  for (let i = 0; i < dstW; i++) xs[i] = Math.min(srcW - 1, Math.floor(((i + 0.5) * srcW) / dstW));
  for (let i = 0; i < dstH; i++) ys[i] = Math.min(srcH - 1, Math.floor(((i + 0.5) * srcH) / dstH));
  return (rgba, punch) => {
    const out = new Uint8Array(dstW * dstH * 3);
    for (let oy = 0; oy < dstH; oy++) {
      for (let ox = 0; ox < dstW; ox++) {
        const i = (ys[oy] * srcW + xs[ox]) * 4;
        let r = rgba[i];
        let g = rgba[i + 1];
        let b = rgba[i + 2];
        if (punch) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          r = (lum + (r - lum) * 1.25 - 128) * 1.1 + 128;
          g = (lum + (g - lum) * 1.25 - 128) * 1.1 + 128;
          b = (lum + (b - lum) * 1.25 - 128) * 1.1 + 128;
          r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
          g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
          b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
        }
        const o = (oy * dstW + ox) * 3;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
      }
    }
    return out;
  };
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Encode `frames` (packed RGB, width×height×3 each) laid out on a timeline of
 * `slotFrame.length` equal slots of `interval` seconds; `slotFrame[i]` is the
 * index of the frame shown in slot i (non-decreasing).
 */
export async function encodeGif(
  frames: Uint8Array[],
  slotFrame: ArrayLike<number>,
  interval: number,
  o: GifEncodeOptions,
  hooks: Hooks = {},
): Promise<GifBuild> {
  const mod = await import("gifenc");
  // Node loads gifenc as CommonJS (named exports under `default`); bundlers give real named exports
  const { GIFEncoder, quantize } = ("GIFEncoder" in mod ? mod : (mod as any).default) as typeof mod;
  const { width, height } = o;
  const n = width * height;
  const slots = slotFrame.length;
  if (!frames.length || !slots) throw new Error("No frames to encode.");
  const check = () => {
    if (hooks.isCancelled?.()) throw new Error("GIF export canceled.");
  };

  // --- One global palette, sampled evenly across every distinct frame ---
  const colors = Math.max(2, Math.min(256, Math.round(o.colors)));
  const wantColors = o.diff ? colors - 1 : colors; // keep a slot free for transparency
  const total = frames.length * n;
  const stride = Math.max(1, Math.floor(total / 160000));
  const sample = new Uint8Array(Math.ceil(total / stride) * 4);
  let sn = 0;
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    // Offset by frame so a stride sharing a factor with n doesn't revisit the same pixel column
    for (let p = f % stride; p < n; p += stride) {
      sample[sn++] = fr[p * 3];
      sample[sn++] = fr[p * 3 + 1];
      sample[sn++] = fr[p * 3 + 2];
      sample[sn++] = 255;
    }
  }
  const palette: number[][] = quantize(sample.subarray(0, sn), Math.max(1, wantColors), { format: "rgb565" }).map(
    (c: number[]) => [c[0], c[1], c[2]],
  );
  while (palette.length < 2 - (o.diff ? 1 : 0)) palette.push([0, 0, 0]);
  const opaqueCount = palette.length;
  let transparentIndex = -1;
  if (o.diff) {
    transparentIndex = palette.length;
    palette.push([0, 0, 0]);
  }
  check();

  // --- Nearest palette entry, cached on a 6-bit-per-channel key ---
  const cache = new Int16Array(1 << 18).fill(-1);
  const nearest = (r: number, g: number, b: number) => {
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let hit = cache[key];
    if (hit >= 0) return hit;
    const cr = ((r >> 2) << 2) | 2;
    const cg = ((g >> 2) << 2) | 2;
    const cb = ((b >> 2) << 2) | 2;
    let best = Infinity;
    hit = 0;
    for (let i = 0; i < opaqueCount; i++) {
      const c = palette[i];
      const d = (c[0] - cr) ** 2 + (c[1] - cg) ** 2 + (c[2] - cb) ** 2;
      if (d < best) {
        best = d;
        hit = i;
      }
    }
    cache[key] = hit;
    return hit;
  };
  const ditherSpread = 255 / Math.cbrt(opaqueCount);
  const tol2 = o.tolerance * o.tolerance;

  // --- Walk the timeline: difference against what the viewer currently sees, merge unchanged frames ---
  type Entry = { diffIdx: Uint8Array; fullIdx: Uint8Array; time: number };
  const entries: Entry[] = [];
  const recon = new Uint8Array(n); // palette index currently on screen at each pixel
  let lastFrame = -1;
  for (let s = 0; s < slots; s++) {
    const f = slotFrame[s];
    if (f === lastFrame) {
      entries[entries.length - 1].time += interval;
      continue;
    }
    lastFrame = f;
    const fr = frames[f];
    const first = entries.length === 0;
    const diffIdx = new Uint8Array(n);
    let changed = 0;
    for (let p = 0, i = 0; p < n; p++, i += 3) {
      const r = fr[i];
      const g = fr[i + 1];
      const b = fr[i + 2];
      let q: number;
      if (o.dither) {
        const t = (BAYER4[((p / width) & 3) * 4 + ((p % width) & 3)] / 16 - 0.5) * ditherSpread;
        q = nearest(r + t, g + t, b + t);
      } else {
        q = nearest(r, g, b);
      }
      let keep = false;
      if (!first) {
        const cur = recon[p];
        if (cur === q) keep = true;
        else if (tol2 > 0) {
          const c = palette[cur];
          keep = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 <= tol2;
        }
      }
      if (keep) {
        diffIdx[p] = o.diff ? transparentIndex : recon[p];
      } else {
        diffIdx[p] = q;
        recon[p] = q;
        changed++;
      }
    }
    if (!first && changed === 0) {
      entries[entries.length - 1].time += interval; // identical frame: just hold the previous one longer
    } else {
      entries.push({ diffIdx, fullIdx: recon.slice(), time: interval });
    }
    if (s % 8 === 0) {
      hooks.onProgress?.((s / slots) * 0.8);
      check();
      await yieldToUi();
    }
  }

  // --- Delays in 10 ms units, carrying the rounding remainder so the total stays exact ---
  const delays: number[] = [];
  let cum = 0;
  let cumCs = 0;
  for (const e of entries) {
    cum += e.time;
    const d = Math.min(65535, Math.max(MIN_DELAY_CS, Math.round(cum * 100) - cumCs));
    delays.push(d);
    cumCs += d;
  }

  // --- Write the file ---
  const gif = GIFEncoder();
  const colorDepth = Math.max(2, Math.min(8, Math.ceil(Math.log2(palette.length))));
  entries.forEach((e, i) => {
    gif.writeFrame(o.diff ? e.diffIdx : e.fullIdx, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: delays[i] * 10,
      repeat: o.loop ? 0 : -1,
      transparent: o.diff && i > 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
      dispose: o.diff ? 1 : 0,
      colorDepth,
    });
  });
  gif.finish();
  hooks.onProgress?.(1);

  return {
    bytes: gif.bytes(),
    kept: entries.length,
    dropped: slots - entries.length,
    slots,
    delays,
    duration: cumCs / 100,
    paletteSize: palette.length,
    transparentIndex: o.diff && entries.length > 1 ? transparentIndex : -1,
  };
}
