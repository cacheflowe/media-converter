// AI upscale for the video pipeline, as a Mediabunny video `process` hook.
//
// Mediabunny runs `process` after its own rotate/crop/resize, so when upscaling
// the caller leaves resizing out of the conversion options and passes the target
// here instead: frames are upscaled first, then fitted to the requested size —
// the same crop → upscale → resize order as the image workspace.

import { VideoSample, type ConversionVideoOptions } from "mediabunny";
import type { FrameUpscaler } from "./upscaler";

type VideoProcess = NonNullable<ConversionVideoOptions["process"]>;
type ProcessItem = Exclude<Awaited<ReturnType<VideoProcess>>, null | unknown[]>;

export type UpscaleResizeTarget = { width: number; height: number; fit: "fill" | "contain" | "cover" };

/**
 * Wraps an existing process hook (time-lapse, frame blending, section joining…)
 * so every frame it emits is AI-upscaled, then optionally resized.
 */
export function createUpscaleProcess(
  upscaler: FrameUpscaler,
  inner: VideoProcess | undefined,
  target: UpscaleResizeTarget | null,
): VideoProcess {
  const resized = document.createElement("canvas");
  const resizedCtx = resized.getContext("2d")!;
  if (target) {
    resized.width = target.width;
    resized.height = target.height;
  }

  function fitInto(frame: HTMLCanvasElement, t: UpscaleResizeTarget) {
    let dx = 0;
    let dy = 0;
    let dw = t.width;
    let dh = t.height;
    if (t.fit !== "fill") {
      const scale =
        t.fit === "contain"
          ? Math.min(t.width / frame.width, t.height / frame.height)
          : Math.max(t.width / frame.width, t.height / frame.height);
      dw = frame.width * scale;
      dh = frame.height * scale;
      dx = (t.width - dw) / 2;
      dy = (t.height - dh) / 2;
    }
    resizedCtx.fillStyle = "#000";
    resizedCtx.fillRect(0, 0, t.width, t.height);
    resizedCtx.imageSmoothingEnabled = true;
    resizedCtx.imageSmoothingQuality = "high";
    resizedCtx.drawImage(frame, dx, dy, dw, dh);
    return resized;
  }

  async function upscaleOne(item: ProcessItem, sample: VideoSample) {
    let source: CanvasImageSource;
    let width: number;
    let height: number;
    let timestamp = sample.timestamp;
    let duration = sample.duration;
    if (item instanceof VideoSample) {
      source = item.toCanvasImageSource();
      width = item.displayWidth;
      height = item.displayHeight;
      timestamp = item.timestamp;
      duration = item.duration;
    } else {
      // A bare canvas/image: it inherits the source sample's timing
      source = item as CanvasImageSource;
      width = (item as HTMLCanvasElement).width;
      height = (item as HTMLCanvasElement).height;
    }

    let frame = await upscaler.upscale(source, width, height);
    if (target) frame = fitInto(frame, target);
    // Samples the inner hook created are ours to release; the input sample is Mediabunny's
    if (item instanceof VideoSample && item !== sample) item.close();
    // VideoSample copies the canvas, so the upscaler can reuse it for the next frame
    return new VideoSample(frame, { timestamp, duration });
  }

  return async (sample) => {
    const result = inner ? await inner(sample) : sample;
    if (!result) return null;
    if (!Array.isArray(result)) return upscaleOne(result, sample);
    // One at a time: frames share the GPU session and working canvases
    const out: VideoSample[] = [];
    for (const item of result) out.push(await upscaleOne(item, sample));
    return out;
  };
}
