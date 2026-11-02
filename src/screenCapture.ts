// Screen capture: records a screen, window or tab (via getDisplayMedia) straight
// into a seekable MP4 with Mediabunny's MediaStream sources, then hands the
// result to the video workspace like a dropped file.
//
// Mediabunny is used instead of MediaRecorder because MediaRecorder's WebM has
// no duration or seek index, which breaks scrubbing and trimming the preview.
// Frames are sampled at a fixed rate, so the file is constant-frame-rate even
// when the screen is static.

import {
  Output,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
  MediaStreamVideoTrackSource,
  MediaStreamAudioTrackSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
} from "mediabunny";
import type { Quality } from "mediabunny";

const QUALITY_PRESETS: Record<string, Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  "very-high": QUALITY_VERY_HIGH,
};
import { formatBytes, formatDuration } from "./shared";

/**
 * Swaps the tab's favicon for a pulsing red "recording" dot while active, and
 * prefixes the title with the elapsed time. Browsers don't animate SVG/GIF
 * favicons consistently, so frames are drawn to a canvas and swapped in.
 * Background tabs throttle timers to ~1/s, which just slows the pulse.
 */
function createRecordingIndicator() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  let link: HTMLLinkElement | null = null;
  let previousIcons: HTMLLinkElement[] = [];
  let originalTitle = "";
  let timer = 0;

  function drawFrame(t: number) {
    const c = size / 2;
    const phase = (t % 1200) / 1200; // one pulse every 1.2s
    ctx.clearRect(0, 0, size, size);
    // Expanding, fading ring
    ctx.beginPath();
    ctx.arc(c, c, 20 + phase * 9, 0, Math.PI * 2);
    ctx.lineWidth = 7;
    ctx.strokeStyle = `rgba(229, 72, 77, ${0.9 * (1 - phase)})`;
    ctx.stroke();
    // Solid dot that breathes slightly
    ctx.beginPath();
    ctx.arc(c, c, 18 + Math.sin(phase * Math.PI * 2) * 4, 0, Math.PI * 2);
    ctx.fillStyle = "#e5484d";
    ctx.fill();
    link!.href = canvas.toDataURL("image/png");
  }

  return {
    start(startedAt: number) {
      if (link) return;
      // Detach existing icons so ours wins, and restore them afterwards
      previousIcons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
      previousIcons.forEach((el) => el.remove());
      link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/png";
      document.head.append(link);
      originalTitle = document.title;
      const tick = () => {
        const now = performance.now();
        drawFrame(now);
        const elapsed = formatDuration((now - startedAt) / 1000).replace(/\.\d+$/, "");
        document.title = `● ${elapsed} · ${originalTitle}`;
      };
      tick();
      timer = window.setInterval(tick, 100);
    },
    stop() {
      if (!link) return;
      clearInterval(timer);
      link.remove();
      link = null;
      document.head.append(...previousIcons);
      previousIcons = [];
      document.title = originalTitle;
    },
  };
}

type ScreenCaptureOptions = {
  root: Document | ShadowRoot;
  /** Called with the finished recording. */
  onRecorded: (file: File) => void | Promise<void>;
};

export function createScreenCapture({ root, onRecorded }: ScreenCaptureOptions) {
  const get = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const bar = get<HTMLElement>("screen-capture-bar");
  const startBtn = get<HTMLButtonElement>("capture-start");
  const stopBtn = get<HTMLButtonElement>("capture-stop");
  const systemAudio = get<HTMLInputElement>("capture-system-audio");
  const mic = get<HTMLInputElement>("capture-mic");
  const fpsSelect = get<HTMLSelectElement>("capture-fps");
  const qualitySelect = get<HTMLSelectElement>("capture-quality");
  const options = get<HTMLElement>("capture-options");
  const status = get<HTMLElement>("capture-status");

  if (!navigator.mediaDevices?.getDisplayMedia) {
    // e.g. mobile browsers
    bar.style.display = "none";
    return;
  }

  let session: {
    output: Output;
    target: BufferTarget;
    streams: MediaStream[];
    audioContext: AudioContext | null;
    startedAt: number;
    timer: number;
    ext: string;
    mime: string;
  } | null = null;
  let stopping = false;
  let lastUrl: string | null = null;
  const indicator = createRecordingIndicator();

  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

  function setRecordingUI(recording: boolean) {
    startBtn.style.display = recording ? "none" : "";
    options.style.display = recording ? "none" : "";
    stopBtn.style.display = recording ? "" : "none";
    bar.classList.toggle("is-recording", recording);
  }

  /** One audio track from the shared tab/system audio and/or the microphone (mixed if both). */
  function combineAudio(tracks: MediaStreamTrack[]) {
    if (tracks.length <= 1) return { track: tracks[0] ?? null, audioContext: null };
    const audioContext = new AudioContext();
    const dest = audioContext.createMediaStreamDestination();
    for (const t of tracks) audioContext.createMediaStreamSource(new MediaStream([t])).connect(dest);
    return { track: dest.stream.getAudioTracks()[0], audioContext };
  }

  async function start() {
    if (session) return;
    const fps = parseInt(fpsSelect.value) || 30;
    const streams: MediaStream[] = [];
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps } },
        audio: systemAudio.checked,
      });
      streams.push(display);
      if (mic.checked) {
        try {
          streams.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
        } catch (err) {
          console.warn("Microphone unavailable; recording without it:", err);
        }
      }

      const videoTrack = display.getVideoTracks()[0];
      const { width = 1920, height = 1080 } = videoTrack.getSettings();
      const w = even(width);
      const h = even(height);

      // Prefer MP4/H.264 (plays everywhere); fall back to WebM
      const videoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1", "vp8"], { width: w, height: h });
      if (!videoCodec) throw new Error("This browser can't encode video at this size.");
      const isMp4 = videoCodec === "avc" || videoCodec === "av1";
      const format = isMp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
      const target = new BufferTarget();
      const output = new Output({ format, target });

      // A quality preset (scaled by resolution) or a fixed Mbps target
      const bitrate = QUALITY_PRESETS[qualitySelect.value] ?? (parseFloat(qualitySelect.value) || 5) * 1_000_000;
      const videoSource = new MediaStreamVideoTrackSource(
          videoTrack as MediaStreamVideoTrack,
          {
            codec: videoCodec,
            bitrate,
            // Favor sharp text/UI over smooth motion
            contentHint: "detail",
            // Keep the first frame's size if a captured window is resized, and
            // force even dimensions (odd sizes trip up encoders)
            sizeChangeBehavior: "contain",
            ...(w !== width || h !== height ? { transform: { width: w, height: h, fit: "contain" as const } } : {}),
          },
          { frameRate: fps },
        );
      output.addVideoTrack(videoSource, { frameRate: fps });
      const errorSources: Promise<void>[] = [videoSource.errorPromise];

      const audioTracks = streams.flatMap((s) => s.getAudioTracks());
      const { track: audioTrack, audioContext } = combineAudio(audioTracks);
      if (audioTrack) {
        const audioCodec = await getFirstEncodableAudioCodec(isMp4 ? ["aac", "opus"] : ["opus"]);
        if (audioCodec) {
          const audioSource = new MediaStreamAudioTrackSource(audioTrack as MediaStreamAudioTrack, {
            codec: audioCodec,
            bitrate: 160_000,
          });
          output.addAudioTrack(audioSource);
          errorSources.push(audioSource.errorPromise);
        }
      }

      // Surface encoder/capture errors mid-recording and save what we have
      Promise.race(errorSources).catch((err) => {
        console.error("Screen capture error:", err);
        status.textContent = `Recording error: ${err?.message || err}`;
        void stop();
      });

      await output.start();
      const startedAt = performance.now();
      session = {
        output,
        target,
        streams,
        audioContext,
        startedAt,
        ext: isMp4 ? "mp4" : "webm",
        mime: isMp4 ? "video/mp4" : "video/webm",
        timer: window.setInterval(() => {
          status.textContent = `● Recording ${formatDuration((performance.now() - startedAt) / 1000).replace(/\.\d+$/, "")}`;
        }, 250),
      };
      status.textContent = "● Recording 0:00";
      setRecordingUI(true);
      indicator.start(startedAt);
      console.log(
        `Screen capture started: ${w}x${h} @ ${fps} fps, ${videoCodec} (${qualitySelect.selectedOptions[0]?.text})${audioTrack ? ` + ${audioTracks.length > 1 ? "mixed " : ""}audio` : ", no audio"}.`,
      );

      // The browser's own "Stop sharing" button ends the video track
      videoTrack.addEventListener("ended", () => void stop());
    } catch (err: any) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      if (err?.name === "NotAllowedError") {
        status.textContent = "Screen capture was cancelled.";
      } else {
        console.error("Screen capture failed:", err);
        status.textContent = `Screen capture failed: ${err?.message || err}`;
      }
    }
  }

  async function stop() {
    if (!session || stopping) return;
    stopping = true;
    const s = session;
    clearInterval(s.timer);
    indicator.stop();
    status.textContent = "Finishing recording…";
    try {
      await s.output.finalize();
    } finally {
      s.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
      void s.audioContext?.close();
      session = null;
      stopping = false;
      setRecordingUI(false);
    }

    const buffer = s.target.buffer;
    if (!buffer) {
      status.textContent = "Recording was empty.";
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
    const file = new File([buffer], `screen-capture_${stamp}.${s.ext}`, { type: s.mime });
    // Offer the raw recording directly; it's also loaded below for editing
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = lastUrl;
    link.download = file.name;
    link.textContent = "Download recording";
    status.replaceChildren(`Recorded ${formatBytes(file.size)} — loaded below for editing. `, link);
    console.log(`Screen capture finished: ${file.name}, ${formatBytes(file.size)}.`);
    await onRecorded(file);
  }

  startBtn.addEventListener("click", () => void start());
  stopBtn.addEventListener("click", () => void stop());
}
