// Composites a screen track and a webcam track (picture-in-picture) onto a
// canvas and feeds each frame to a Mediabunny CanvasSource.
//
// Frames are read straight from the tracks with MediaStreamTrackProcessor and
// sampled by a Worker-driven timer. Both matter because the user will be looking
// at the screen being recorded, which leaves this tab in the background where
// <video> elements stop painting and main-thread timers are throttled to ~1/s.

import type { CanvasSource } from "mediabunny";

export type WebcamCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

/** Webcam width as a fraction of the recording width. */
export const WEBCAM_SIZES: Record<string, number> = { small: 0.16, medium: 0.22, large: 0.3 };

type CompositorOptions = {
  canvas: HTMLCanvasElement;
  source: CanvasSource;
  screenTrack: MediaStreamTrack;
  webcamTrack: MediaStreamTrack;
  fps: number;
  corner: WebcamCorner;
  /** Webcam width as a fraction of the canvas width. */
  size: number;
  onError: (err: unknown) => void;
};

/** Reads frames from a track, keeping only the latest one (older frames are closed). */
function watchTrack(track: MediaStreamTrack) {
  const Processor = (window as any).MediaStreamTrackProcessor;
  if (!Processor) throw new Error("This browser can't composite a webcam into the recording.");
  const reader: ReadableStreamDefaultReader<VideoFrame> = new Processor({ track }).readable.getReader();
  let latest: VideoFrame | null = null;
  let closed = false;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      if (closed) {
        value.close();
        break;
      }
      latest?.close();
      latest = value;
    }
  })().catch(() => {});
  return {
    get latest() {
      return latest;
    },
    close() {
      closed = true;
      void reader.cancel().catch(() => {});
      latest?.close();
      latest = null;
    },
  };
}

/** setInterval that keeps firing in background tabs (Workers aren't throttled). */
function unthrottledInterval(callback: () => void, ms: number) {
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = callback;
  return () => {
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}

export function createWebcamCompositor(opts: CompositorOptions) {
  const { canvas, source, fps, corner, size, onError } = opts;
  const ctx = canvas.getContext("2d")!;
  const screen = watchTrack(opts.screenTrack);
  const webcam = watchTrack(opts.webcamTrack);
  let stopTimer: (() => void) | null = null;
  let startedAt = 0;
  let frameIndex = 0;
  let pending: Promise<void> | null = null;

  function draw() {
    const screenFrame = screen.latest;
    if (!screenFrame) return false;
    const { width: cw, height: ch } = canvas;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    // Fit the screen into the fixed canvas (letterboxed if a shared window is resized)
    const sw = screenFrame.displayWidth;
    const sh = screenFrame.displayHeight;
    const scale = Math.min(cw / sw, ch / sh);
    ctx.drawImage(screenFrame, (cw - sw * scale) / 2, (ch - sh * scale) / 2, sw * scale, sh * scale);

    const cam = webcam.latest;
    if (cam) {
      const w = Math.round(cw * size);
      const h = Math.round((w * cam.displayHeight) / cam.displayWidth);
      const margin = Math.round(cw * 0.02);
      const x = corner.endsWith("left") ? margin : cw - w - margin;
      const y = corner.startsWith("top") ? margin : ch - h - margin;
      const radius = Math.round(w * 0.06);
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = Math.round(w * 0.06);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.clip();
      ctx.drawImage(cam, x, y, w, h);
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.lineWidth = Math.max(2, Math.round(w * 0.012));
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.stroke();
    }
    return true;
  }

  function tick() {
    if (pending) return; // encoder backpressure: skip rather than queue up
    const elapsed = (performance.now() - startedAt) / 1000;
    const due = Math.floor(elapsed * fps);
    if (frameIndex > due) return;
    if (due - frameIndex > 1) frameIndex = due; // we fell behind; don't burst-encode
    if (!draw()) return;
    pending = source
      .add(frameIndex / fps, 1 / fps)
      .catch(onError)
      .finally(() => {
        pending = null;
      });
    frameIndex++;
  }

  return {
    start() {
      startedAt = performance.now();
      stopTimer = unthrottledInterval(tick, Math.max(4, Math.floor(500 / fps)));
    },
    /** Stops sampling and waits for the last frame to be handed to the encoder. */
    async stop() {
      stopTimer?.();
      stopTimer = null;
      await pending;
      screen.close();
      webcam.close();
    },
  };
}
