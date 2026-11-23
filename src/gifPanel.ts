// UI wiring for the "Export as GIF" panel in the video workspace: presets
// (including the LED-panel ones), manual controls, URL-hash deep links, size
// estimate, and a real-size + enlarged preview of the result. The heavy lifting
// is in gifExport.ts / gifEncode.ts; this module only reads the page's controls
// and the video workspace's trim / crop / speed state through `deps`.

import type { Input } from "mediabunny";
import { exportGif, MAX_GIF_FPS, type GifExportOptions, type GifExportResult } from "./gifExport";
import type { TimeRange } from "./sectionJoin";
import { formatBytes, formatDuration } from "./shared";
import type { ToolkitRoot } from "./toolkitCore";

export interface GifPanelDeps {
  getInput(): Input | null;
  getFileName(): string | null;
  getSourceDuration(): number;
  /** Crop box (or the full frame) in source pixels; null when no video is loaded. */
  getRegion(): { x: number; y: number; width: number; height: number } | null;
  getRanges(): TimeRange[] | null;
  getSpeed(): number | null;
}

type Preset = {
  width: number;
  height: number; // 0 = auto from the source aspect
  fps: number;
  colors: number;
  tolerance: number;
  fit: "fill" | "stretch";
  resample: "area" | "nearest";
  dither: boolean;
  diff: boolean;
  punch: boolean;
  loop: boolean;
  budgetMB: number;
};

const BASE: Preset = {
  width: 480,
  height: 0,
  fps: 12,
  colors: 128,
  tolerance: 8,
  fit: "fill",
  resample: "area",
  dither: false,
  diff: true,
  punch: false,
  loop: true,
  budgetMB: 0,
};

// The LED presets target a HUB75 panel fed by an on-device decoder: exact pixel size, a centered crop,
// no dithering (it shimmers on LEDs), one palette, transparent unchanged pixels, and a flash budget.
const LED: Preset = { ...BASE, width: 32, height: 32, fps: 20, colors: 256, budgetMB: 1.2 };

export const GIF_PRESETS: Record<string, Preset> = {
  tiny: { ...BASE, width: 320, fps: 10, colors: 64, tolerance: 10 },
  balanced: { ...BASE },
  sharp: { ...BASE, width: 640, fps: 15, colors: 256, tolerance: 6 },
  led32: { ...LED },
  led64x32: { ...LED, width: 64, height: 32 },
};

/** URL-hash parameters a host page can use to link straight into the GIF panel (documented in the README). */
export function parseGifHash(hash: string): { preset: string | null; overrides: Partial<Preset> } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const keys = ["gif-preset", "gif-resample", "gif-width", "gif-height", "gif-fps", "gif-colors", "gif-tolerance", "gif-dither", "gif-budget"];
  if (!keys.some((k) => params.has(k))) return null;
  const num = (k: string) => {
    const v = parseFloat(params.get(k) ?? "");
    return Number.isFinite(v) ? v : undefined;
  };
  const overrides: Partial<Preset> = {};
  const set = <K extends keyof Preset>(key: K, value: Preset[K] | undefined) => {
    if (value !== undefined) overrides[key] = value;
  };
  set("width", num("gif-width"));
  set("height", num("gif-height"));
  set("fps", num("gif-fps"));
  set("colors", num("gif-colors"));
  set("tolerance", num("gif-tolerance"));
  set("budgetMB", num("gif-budget"));
  const rs = params.get("gif-resample");
  if (rs === "area" || rs === "nearest") overrides.resample = rs;
  if (params.has("gif-dither")) set("dither", params.get("gif-dither") === "1" || params.get("gif-dither") === "true");
  const preset = params.get("gif-preset");
  return { preset: preset && GIF_PRESETS[preset] ? preset : null, overrides };
}

export function createGifPanel(root: ToolkitRoot, deps: GifPanelDeps) {
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const panel = $<HTMLDetailsElement>("panel-gif");
  const presetSel = $<HTMLSelectElement>("gif-preset");
  const widthIn = $<HTMLInputElement>("gif-width");
  const heightIn = $<HTMLInputElement>("gif-height");
  const fpsIn = $<HTMLInputElement>("gif-fps");
  const colorsSel = $<HTMLSelectElement>("gif-colors");
  const fitSel = $<HTMLSelectElement>("gif-fit");
  const resampleSel = $<HTMLSelectElement>("gif-resample");
  const budgetIn = $<HTMLInputElement>("gif-budget");
  const tolIn = $<HTMLInputElement>("gif-tolerance");
  const tolVal = $<HTMLElement>("gif-tolerance-val");
  const diffIn = $<HTMLInputElement>("gif-diff");
  const ditherIn = $<HTMLInputElement>("gif-dither");
  const punchIn = $<HTMLInputElement>("gif-punch");
  const loopIn = $<HTMLInputElement>("gif-loop");
  const exportBtn = $<HTMLButtonElement>("gif-export-btn");
  const estimateBtn = $<HTMLButtonElement>("gif-estimate-btn");
  const cancelBtn = $<HTMLButtonElement>("gif-cancel-btn");
  const progress = $<HTMLProgressElement>("gif-progress");
  const status = $<HTMLElement>("gif-status");
  const resultBox = $<HTMLElement>("gif-result");
  const realImg = $<HTMLImageElement>("gif-preview-real");
  const zoomImg = $<HTMLImageElement>("gif-preview-zoom");
  const zoomFig = $<HTMLElement>("gif-zoom-fig");
  const realCaption = $<HTMLElement>("gif-real-caption");
  const zoomCaption = $<HTMLElement>("gif-zoom-caption");
  const stats = $<HTMLElement>("gif-stats");
  const download = $<HTMLAnchorElement>("gif-download");

  let resultUrl: string | null = null;
  let cancelRequested = false;
  let running = false;
  let pendingHash = parseGifHash(window.location.hash);

  function applyPreset(p: Preset) {
    widthIn.value = String(p.width);
    heightIn.value = p.height ? String(p.height) : "";
    fpsIn.value = String(p.fps);
    colorsSel.value = String(p.colors);
    fitSel.value = p.fit;
    resampleSel.value = p.resample;
    budgetIn.value = String(p.budgetMB);
    tolIn.value = String(p.tolerance);
    tolVal.textContent = String(p.tolerance);
    diffIn.checked = p.diff;
    ditherIn.checked = p.dither;
    punchIn.checked = p.punch;
    loopIn.checked = p.loop;
  }

  function markCustom() {
    const custom = presetSel.querySelector('option[value="custom"]') as HTMLOptionElement;
    custom.disabled = false;
    presetSel.value = "custom";
  }

  presetSel.addEventListener("change", () => {
    const p = GIF_PRESETS[presetSel.value];
    if (p) applyPreset(p);
  });
  [widthIn, heightIn, fpsIn, colorsSel, fitSel, resampleSel, budgetIn, tolIn, diffIn, ditherIn, punchIn, loopIn].forEach((el) =>
    el.addEventListener("change", markCustom),
  );
  [widthIn, heightIn, fpsIn, budgetIn].forEach((el) => el.addEventListener("input", markCustom));
  tolIn.addEventListener("input", () => {
    tolVal.textContent = tolIn.value;
    markCustom();
  });

  /** Apply `#gif-preset=…` style parameters: open the panel, set the controls, bring it into view. */
  function applyHash(parsed: NonNullable<ReturnType<typeof parseGifHash>>) {
    const base = GIF_PRESETS[parsed.preset ?? presetSel.value] ?? BASE;
    applyPreset({ ...base, ...parsed.overrides });
    if (parsed.preset) presetSel.value = parsed.preset;
    if (Object.keys(parsed.overrides).length) markCustom();
    panel.open = true;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    console.log(`🎞️ GIF panel opened from the URL${parsed.preset ? ` (preset: ${parsed.preset})` : ""}.`);
  }

  window.addEventListener("hashchange", () => {
    const parsed = parseGifHash(window.location.hash);
    if (!parsed) return;
    if (deps.getInput()) applyHash(parsed);
    else pendingHash = parsed;
  });

  function clearResult() {
    resultBox.style.display = "none";
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    realImg.removeAttribute("src");
    zoomImg.removeAttribute("src");
    status.textContent = "";
  }

  function readOptions(limitSeconds?: number): GifExportOptions | null {
    const input = deps.getInput();
    const region = deps.getRegion();
    if (!input || !region) return null;
    return {
      input,
      sourceDuration: deps.getSourceDuration(),
      region,
      ranges: deps.getRanges(),
      speed: deps.getSpeed(),
      width: Math.max(1, parseInt(widthIn.value) || 1),
      height: Math.max(0, parseInt(heightIn.value) || 0),
      fit: fitSel.value as "fill" | "stretch",
      fps: Math.max(1, Math.min(MAX_GIF_FPS, parseFloat(fpsIn.value) || 10)),
      resample: resampleSel.value as "area" | "nearest",
      colors: parseInt(colorsSel.value) || 128,
      dither: ditherIn.checked,
      diff: diffIn.checked,
      tolerance: parseInt(tolIn.value) || 0,
      loop: loopIn.checked,
      punch: punchIn.checked,
      limitSeconds,
      isCancelled: () => cancelRequested,
    };
  }

  /** Output length in seconds after trim and speed. */
  function outputLength(opts: GifExportOptions) {
    const joined = opts.ranges
      ? opts.ranges.reduce((a, r) => a + (r.end - r.start), 0)
      : opts.sourceDuration;
    return joined / (opts.speed ?? 1);
  }

  const budgetBytes = () => Math.max(0, parseFloat(budgetIn.value) || 0) * 1e6;
  const fmtMB = (b: number) => `${(b / 1e6).toFixed(2)} MB`;

  function setBusy(busy: boolean, label = "") {
    running = busy;
    exportBtn.disabled = estimateBtn.disabled = busy;
    cancelBtn.style.display = busy ? "" : "none";
    progress.style.display = busy ? "" : "none";
    if (busy) {
      progress.value = 0;
      status.style.color = "";
      status.textContent = label;
    }
  }

  async function run(estimate: boolean) {
    if (running) return;
    const probe = readOptions();
    if (!probe) {
      alert("Please load a video first.");
      return;
    }
    const full = outputLength(probe);
    const limit = estimate ? Math.min(1.5, full) : undefined;
    const opts = readOptions(limit)!;
    opts.onProgress = (f) => (progress.value = Math.round(f * 100));

    cancelRequested = false;
    if (!estimate) clearResult();
    setBusy(true, estimate ? "Encoding a short sample…" : "Creating GIF…");
    try {
      const result = await exportGif(opts);
      if (estimate) {
        const est = result.blob.size * (full / Math.max(0.01, result.clipDuration));
        const budget = budgetBytes();
        status.style.color = budget && est > budget ? "var(--pico-del-color, #c0392b)" : "";
        status.textContent =
          `Estimated size ≈ ${fmtMB(est)} (rough, from the first ${result.clipDuration.toFixed(1)} s of ${full.toFixed(1)} s)` +
          (budget ? (est > budget ? ` — likely over the ${fmtMB(budget)} budget.` : ` — within the ${fmtMB(budget)} budget.`) : ".");
      } else {
        showResult(result, opts);
      }
    } catch (error: any) {
      if (String(error?.message).includes("canceled")) {
        status.textContent = "Canceled.";
      } else {
        console.error("GIF export failed: ", error);
        status.style.color = "var(--pico-del-color, #c0392b)";
        status.textContent = `GIF export failed: ${error?.message || error}`;
      }
    } finally {
      setBusy(false);
    }
  }

  function showResult(r: GifExportResult, opts: GifExportOptions) {
    resultUrl = URL.createObjectURL(r.blob);
    const base = (deps.getFileName() ?? "video").replace(/\.[^.]+$/, "");
    download.href = resultUrl;
    download.download = `${base}_${r.width}x${r.height}.gif`;

    realImg.src = resultUrl;
    realImg.style.width = `${r.width}px`;
    realImg.style.maxWidth = "100%";
    realImg.style.height = "auto";
    realCaption.textContent = `Actual size (${r.width}×${r.height})`;
    // Small outputs (LED panels) are also shown enlarged, nearest-neighbor, to judge legibility
    if (r.width <= 160) {
      const k = Math.max(2, Math.floor(320 / r.width));
      zoomImg.src = resultUrl;
      zoomImg.style.width = `${r.width * k}px`;
      zoomImg.style.maxWidth = "100%";
      zoomImg.style.height = "auto";
      zoomCaption.textContent = `Enlarged ${k}×`;
      zoomFig.style.display = "";
    } else {
      zoomFig.style.display = "none";
    }

    const budget = budgetBytes();
    const size = r.blob.size;
    const lines: string[] = [];
    if (budget) {
      const over = size > budget;
      lines.push(
        `<strong style="color: ${over ? "var(--pico-del-color, #c0392b)" : "inherit"}">${over ? "⚠️ " : "✅ "}` +
          `${fmtMB(size)} of ${fmtMB(budget)} budget (${Math.round((size / budget) * 100)}%)` +
          `${over ? ` — over by ${fmtMB(size - budget)}. Try fewer colors, a lower frame rate, a higher tolerance or a shorter clip.` : ""}</strong>`,
      );
    } else {
      lines.push(`<strong>${fmtMB(size)}</strong> (${formatBytes(size)})`);
    }
    lines.push(
      `${r.kept} frame${r.kept === 1 ? "" : "s"} kept, ${r.dropped} merged (of ${r.slots}) · ` +
        `${r.duration.toFixed(2)} s${opts.loop ? ", loops" : ", plays once"} · ` +
        `${r.paletteSize} palette entries${r.transparentIndex >= 0 ? " (incl. transparent)" : ""}`,
    );
    stats.innerHTML = lines.join("<br>");
    status.style.color = "";
    status.textContent = `Done: ${formatDuration(r.duration)} at ~${(r.slots / r.duration).toFixed(1)} fps.`;
    resultBox.style.display = "";
    console.log(
      `🎞️ GIF ${r.width}x${r.height}: ${formatBytes(size)}, ${r.kept}/${r.slots} frames kept, ${r.duration.toFixed(2)} s.`,
    );
  }

  exportBtn.addEventListener("click", () => void run(false));
  estimateBtn.addEventListener("click", () => void run(true));
  cancelBtn.addEventListener("click", () => (cancelRequested = true));

  return {
    /** Call after a video has loaded: resets the result and applies any pending URL parameters. */
    onVideoLoaded() {
      clearResult();
      if (pendingHash) {
        const parsed = pendingHash;
        pendingHash = null;
        applyHash(parsed);
      }
    },
    dispose() {
      cancelRequested = true;
      clearResult();
    },
  };
}
