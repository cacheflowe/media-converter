// Video → GIF: pulls frames from a Mediabunny input (honoring trim sections, crop
// and speed), area-averages each one down to the GIF size, resamples them onto a
// fixed-rate timeline, and hands them to the GIF encoder (src/gifEncode.ts).
//
// Frames come from a CanvasSink (rotation + crop applied by Mediabunny); the final
// shrink is our own box filter, because a straight canvas drawImage to a tiny size
// aliases badly. The sink only down-scales moderately first, so the box filter has
// real pixels to average without chewing through 4K frames in JS.

import { CanvasSink, type Input } from "mediabunny";
import { createDownsampler, encodeGif, type Downsampler, type GifBuild } from "./gifEncode";
import type { TimeRange } from "./sectionJoin";

export type GifExportOptions = {
  input: Input;
  /** Source duration in seconds (used when there is no trim). */
  sourceDuration: number;
  /** Region of the (rotated) source frame to use, in source pixels. */
  region: { x: number; y: number; width: number; height: number };
  /** Kept sections of the source, or null for the whole clip. */
  ranges: TimeRange[] | null;
  /** Speed factor (>1 faster), or null for 1×. */
  speed: number | null;
  /** Output size; height 0 = follow the region's aspect ratio. */
  width: number;
  height: number;
  /** "fill" center-crops the region to the output aspect; "stretch" squashes it. */
  fit: "fill" | "stretch";
  fps: number;
  colors: number;
  dither: boolean;
  diff: boolean;
  tolerance: number;
  loop: boolean;
  /** "area" averages every source pixel under each output pixel; "nearest" samples block centers (pixel-exact). */
  resample: "area" | "nearest";
  /** Slightly boost contrast and saturation. */
  punch: boolean;
  /** Only render the first N seconds of the output (size estimates). */
  limitSeconds?: number;
  onProgress?: (fraction: number) => void;
  isCancelled?: () => boolean;
};

export type GifExportResult = GifBuild & {
  blob: Blob;
  width: number;
  height: number;
  /** Output timeline length in seconds that was rendered (the clip, after trim and speed). */
  clipDuration: number;
};

export const MAX_GIF_FPS = 50;
/** Longest frame-count guard so a very long clip can't exhaust memory. */
const MAX_SLOTS = 4000;

/** The source rectangle and output size for the given region, output size and fit. */
export function planGifFrame(
  region: GifExportOptions["region"],
  width: number,
  height: number,
  fit: "fill" | "stretch",
) {
  const outW = Math.max(1, Math.round(width));
  const outH = Math.max(1, Math.round(height > 0 ? height : (outW * region.height) / region.width));
  let { x, y, width: w, height: h } = region;
  if (fit === "fill") {
    const target = outW / outH;
    if (w / h > target) {
      const nw = Math.max(1, Math.round(h * target));
      x += Math.floor((w - nw) / 2);
      w = nw;
    } else {
      const nh = Math.max(1, Math.round(w / target));
      y += Math.floor((h - nh) / 2);
      h = nh;
    }
  }
  return { outW, outH, rect: { x, y, width: w, height: h } };
}

export async function exportGif(o: GifExportOptions): Promise<GifExportResult> {
  const track = await o.input.getPrimaryVideoTrack();
  if (!track) throw new Error("This file has no video track.");
  const cancelled = () => !!o.isCancelled?.();
  const cancelError = () => new Error("GIF export canceled.");

  const { outW, outH, rect } = planGifFrame(o.region, o.width, o.height, o.fit);
  const speed = o.speed && o.speed > 0 ? o.speed : 1;

  const ranges: TimeRange[] = o.ranges ?? [{ start: await track.getFirstTimestamp(), end: o.sourceDuration }];
  const joinedLength = ranges.reduce((a, r) => a + (r.end - r.start), 0);
  let total = joinedLength / speed;
  if (o.limitSeconds && o.limitSeconds < total) total = o.limitSeconds;
  const fps = Math.max(1, Math.min(MAX_GIF_FPS, o.fps));
  // Frames are held in memory as RGB until the palette is known, so cap the count by size too
  const maxSlots = Math.max(50, Math.min(MAX_SLOTS, Math.floor(3e8 / (outW * outH * 3))));
  const wanted = Math.max(1, Math.round(total * fps));
  if (wanted > maxSlots) console.warn(`GIF: ${wanted} frames requested, limiting to ${maxSlots} (lowering the frame rate).`);
  const count = Math.min(maxSlots, wanted);
  const interval = total / count; // slots divide the timeline exactly, so delays sum to the clip length

  // Decode at a moderate size: enough source pixels for the box filter to average, not a full 4K frame
  // (Nearest sampling decodes at full size: any intermediate scaling would blur the pixel blocks.)
  const cap = Math.max(640, Math.max(outW, outH) * 3);
  const scale = o.resample === "nearest" ? 1 : Math.min(1, cap / Math.max(rect.width, rect.height));
  const sink = new CanvasSink(track, {
    crop: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
    fit: "fill",
  });

  const frames: Uint8Array[] = [];
  const slotFrame = new Int32Array(count);
  let nextSlot = 0;
  let scratch: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;
  let downsample: Downsampler | null = null;

  const render = (canvas: HTMLCanvasElement | OffscreenCanvas) => {
    if (!scratch || scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch = document.createElement("canvas");
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      scratchCtx = scratch.getContext("2d", { willReadFrequently: true })!;
      downsample = createDownsampler(canvas.width, canvas.height, outW, outH, o.resample);
    }
    scratchCtx!.drawImage(canvas as CanvasImageSource, 0, 0);
    const data = scratchCtx!.getImageData(0, 0, canvas.width, canvas.height).data;
    return downsample!(data, o.punch);
  };

  // A source frame covers the timeline from its start to the next frame's start. It is only
  // rendered if at least one output slot lands inside that span.
  let prev: HTMLCanvasElement | OffscreenCanvas | null = null;
  const settle = (end: number) => {
    if (!prev) return;
    let frameIndex = -1;
    while (nextSlot < count && nextSlot * interval < end - 1e-9) {
      if (frameIndex < 0) {
        frames.push(render(prev));
        frameIndex = frames.length - 1;
      }
      slotFrame[nextSlot++] = frameIndex;
    }
  };

  let offset = 0;
  let seen = false;
  outer: for (const r of ranges) {
    for await (const wrapped of sink.canvases(r.start, r.end)) {
      if (cancelled()) throw cancelError();
      // Joined-timeline time of this frame, clamped to its section (the first frame may start before it)
      const joined = Math.max(offset, wrapped.timestamp - r.start + offset);
      const start = seen ? joined / speed : 0;
      if (start >= total) break outer;
      settle(start);
      prev = wrapped.canvas;
      seen = true;
      o.onProgress?.((nextSlot / count) * 0.7);
      if (nextSlot % 16 === 0) await new Promise<void>((res) => setTimeout(res, 0));
    }
    offset += r.end - r.start;
  }
  settle(Infinity);
  if (!frames.length) throw new Error("No video frames could be decoded for this range.");
  // A clip shorter than its reported duration leaves slots uncovered: hold the last frame
  while (nextSlot < count) slotFrame[nextSlot++] = frames.length - 1;
  if (cancelled()) throw cancelError();

  const build = await encodeGif(
    frames,
    slotFrame,
    interval,
    {
      width: outW,
      height: outH,
      colors: o.colors,
      dither: o.dither,
      diff: o.diff,
      tolerance: o.tolerance,
      loop: o.loop,
    },
    { onProgress: (f) => o.onProgress?.(0.7 + f * 0.3), isCancelled: cancelled },
  );

  return {
    ...build,
    blob: new Blob([build.bytes as BlobPart], { type: "image/gif" }),
    width: outW,
    height: outH,
    clipDuration: total,
  };
}
