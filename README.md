# Media Converter

A **100% in-browser** media converter for video, audio, and images. Nothing is
uploaded to a server — all decoding, transcoding, editing, and even the AI
upscaling and frame interpolation run locally in the browser, via
[MediaBunny](https://github.com/Vanilagy/mediabunny) on top of the native
**WebCodecs** API and [onnxruntime-web](https://onnxruntime.ai/) on **WebGPU**.

**Live:** https://cacheflowe.github.io/media-converter/

Features:

- **Video**: transcode (MP4/WebM, H.264/HEVC/VP9/VP8/AV1), quality/bitrate control,
  trim (multiple sections joined into one clip), crop, resize, rotate, speed change /
  time-lapse (skip or motion-blur frames, pitch-preserving audio), frame-rate
  resampling (repeat or blend), audio transcode/copy/strip, **Enhance Voice**
  (same pass as in the Audio workspace), **Extract Audio** (export just the audio
  track, or open it in the audio editor), and fast-copy (no
  re-encode) trims, and **Export as GIF** (small, palette-optimized animated GIFs,
  including presets for tiny LED panels — see below).
- **AI for video**: 2x upscaling (Real-ESRGAN) and **RIFE** frame interpolation for
  smoother frame rates or slow motion — see below.
- **Image**: crop (drag handles + loupe), resize/scale presets, redaction brush
  (blur / pixelate / solid), **AI upscale 2x**, format + quality export
  (JPEG/PNG/WebP/AVIF), and a "lightweight Base64 PNG" (palette-quantized) copy.
  HEIC/HEIF photos are decoded on demand.
- **Audio**: waveform with trim, transcode to MP3/M4A/Opus/WAV/FLAC, and an
  optional **Enhance Voice** pass for voiceovers (AI noise reduction with the
  Resemble denoiser, low-cut, warmth/presence EQ, compressor, gentle noise gate,
  loudness normalization).
- **Batch**: drop several images or several videos to convert them with shared
  settings and download everything as one ZIP.
- **Screen capture**: record a screen, window, or tab to MP4 (with tab/system
  audio and mic, and an optional **webcam picture-in-picture** in any corner;
  pick the mic and webcam with a live level meter and preview first),
  or grab a single-frame **screenshot** (optionally after a 3–5 s
  delay) as a PNG that opens straight in the image workspace, or **record
  audio only** (tab/system audio and/or mic) to a WAV that opens in the audio
  editor.
- **Input**: drag & drop, file picker, or paste an image from the clipboard.
- Live output-size estimate, original/output comparison, a diagnostics console,
  and a light/dark theme. Click the `<media-converter>` title to return to the
  start screen.

## Three ways to ship it

The exact same UI and logic build into **three targets** from one shared codebase:

1. **Standalone site** (`dist/`) — a normal static site you can host anywhere.
2. **Web component** (`dist-component/media-converter.js`) — a single,
   fully self-contained, shadow-DOM-isolated `<media-converter>` element you
   can drop into any page.
3. **GitHub Pages demo** (`dist-pages/index.html`) — same as the standalone
   site, but a single self-contained file with no separate JS/CSS assets.
   Built and deployed automatically by GitHub Actions on every push to `main`.

### Architecture

| File | Role |
|---|---|
| `src/toolkitTemplate.ts` | The UI markup (one shared HTML string). **Edit the UI here.** |
| `src/toolkitCore.ts` | Core behavior and the video workspace: `mountToolkit(root, { themeElement })`, scoped to whatever root it's given (a `Document` or a `ShadowRoot`). |
| `src/imageWorkflow.ts` | Image crop / redact / AI upscale / export workflow (also root-scoped). |
| `src/audioWorkflow.ts` | Audio workspace: waveform, trim, transcode. |
| `src/audioFormats.ts`, `src/audioExtract.ts`, `src/sectionJoin.ts` | Shared audio output formats; extracting a video's audio track; joining trim sections. |
| `src/voiceEnhance.ts` | Streaming voice-mastering chain (EQ, compressor, gate, loudness) used by the audio and video workspaces. |
| `src/neuralDenoise.ts` | AI noise reduction: Resemble denoiser (ONNX) with a JS STFT/ISTFT, run as a pre-pass. |
| `src/imageBatchWorkflow.ts`, `src/videoBatchWorkflow.ts`, `src/batchShared.ts` | Batch modes on a shared queue / thumbnail / ZIP engine (`src/zip.ts`). |
| `src/screenCapture.ts` | Screen recording (Mediabunny MediaStream sources → MP4) and screenshots. |
| `src/gifPanel.ts`, `src/gifExport.ts`, `src/gifEncode.ts` | Video → GIF: panel UI + presets + URL params; frame pulling (trim / crop / speed) and box downsampling; palette, frame differencing and GIF writing ([gifenc](https://github.com/mattdesl/gifenc), lazy-loaded). |
| `src/trimController.ts`, `src/cropEditor.ts` | Trim and crop editors shared by the video, audio, and image workspaces. |
| `src/timelapse.ts`, `src/audioStretch.ts` | Speed change / time-lapse video process hook and pitch-preserving audio stretch. |
| `src/onnxRuntime.ts` | Shared ML runtime: lazy onnxruntime-web, WebGPU detection, model download + Cache API, session reuse. |
| `src/upscaler.ts`, `src/videoUpscale.ts` | Real-ESRGAN tiling upscaler, and its video process hook. |
| `src/frameInterpolation.ts` | RIFE interpolator and its video process hook. |
| `src/shared.ts` | Formatters, quality maps, codec/format helpers, image decoding (incl. HEIC). |
| `src/style.css` | Styles (imports Pico CSS). |
| `src/main.ts` | **Standalone entry** — injects the markup into the page, mounts on `document`. |
| `src/component.ts` | **Web-component entry** — defines `<media-converter>`, mounts inside a shadow root with Pico's `:root` tokens rescoped to `:host`. |

Because the core queries a passed-in `root` and both `Document` and `ShadowRoot`
implement `getElementById`, the identical wiring runs in both targets.

## Develop

```bash
npm install
npm run dev        # Vite dev server for the standalone site
```

## Build

```bash
npm run build            # -> dist/            standalone static site
npm run build:component  # -> dist-component/  single-file web component
npm run build:pages      # -> dist-pages/      single-file index.html for GitHub Pages
npm run build:all        # build + build:component + build:pages
```

The standalone build uses a **relative base** (`./assets/...`), so `dist/` works
from any host or subpath (GitHub Pages project pages, Vercel, a nested folder,
etc.) with no config change.

### Updating the GitHub Pages demo

The live demo at https://cacheflowe.github.io/media-converter/ is deployed by
[.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) on
every push to `main` (or manually via **Actions → Deploy to GitHub Pages → Run
workflow**). Nothing built needs to be committed.

The workflow runs `npm run build:pages` (inlines all JS/CSS into one
`index.html`) and `npm run build:component`, then publishes `index.html`,
`component-demo.html`, and `dist-component/` — so the
component demo also works at `/component-demo.html`.

To preview the Pages build locally:

```bash
npm run build:pages   # then open dist-pages/index.html
```

## Export as GIF

Open **🎞️ Export as GIF** in the video workspace. It follows the trim / sections, crop box
and speed settings above it (not RIFE or AI upscale). Frames are decoded by Mediabunny, shrunk
with an **area-average (box) filter** (every source pixel that falls in an output pixel is
averaged, so small output doesn't alias or shimmer), resampled to the GIF frame rate, quantized
to **one global palette** for the whole clip, and encoded with [gifenc](https://github.com/mattdesl/gifenc) (MIT).
Pixels that haven't changed since the previous frame become transparent (disposal 1), and a frame
where nothing changed is dropped and its time added to the previous frame's delay (GIF delays are
10 ms units; the rounding remainder is carried forward so the total stays exact, and no delay is
under 20 ms because browsers clamp shorter ones).

Controls: preset (Tiny 320 px/10 fps/64 colors, Balanced 480/12/128, Sharp 640/15/256), width,
height (blank = follow the aspect), frame rate (1–50), palette size, center-crop vs stretch when the
shape differs, an optional size budget, a **change tolerance** slider, transparent unchanged pixels,
ordered-Bayer dithering (off by default), a contrast/saturation boost (off), and loop. **Estimate
size** encodes the first ~1.5 s and extrapolates. The result shows size (against the budget),
frames kept/merged, duration, and a real-size plus enlarged (nearest-neighbor) preview.

**Downsampling** is *Area average* by default. *Nearest (pixel-exact)* instead samples the center
of each source block, with no scaling beforehand, so art made of whole pixel blocks (say a 32×32
animation shown at 10×) comes back exactly, with no blended edges. For it to line up, the crop
should cover whole blocks (draw a crop box in the Crop panel if the video has borders).

### LED panel preset (32×32 / 64×32)

For HUB75 LED signs that play GIFs from flash (e.g. an ESP32 using bitbank2's AnimatedGIF).
The preset: exact **32×32** output (**64×32** has its own entry; width/height are editable) with a
centered crop to that shape (draw a crop box in the Crop panel first to choose the region), box
downsampling, **no dithering**, a single ≤256-color global palette with a reserved transparent
index, merged unchanged frames, 20 fps by default, a **1.2 MB budget** with a warning when exceeded,
and a GIF89a file with the NETSCAPE2.0 loop extension (loop forever), disposal method 1 and
a single global color table.

### URL parameters

A host page can link straight into the panel with hash parameters; they're applied once a video is
loaded (or immediately if one already is), and the GIF panel opens and scrolls into view.

| Parameter | Meaning |
|---|---|
| `gif-preset` | `tiny`, `balanced`, `sharp`, `led32`, `led64x32` |
| `gif-width`, `gif-height` | Output size in pixels (override the preset) |
| `gif-fps` | Frame rate, 1–50 |
| `gif-colors` | Palette size: 16, 32, 64, 128, 256 |
| `gif-tolerance` | Change tolerance, 0–40 |
| `gif-resample` | `area` (default) or `nearest` (pixel-exact) |
| `gif-dither` | `1` / `0` |
| `gif-budget` | Size budget in MB (`0` = none) |

Example: `https://cacheflowe.github.io/media-converter/#gif-preset=led32`, or
`#gif-preset=led64x32&gif-fps=25`.

## AI upscale

The image and video workspaces can upscale 2x with Real-ESRGAN, run locally via
[onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/) on **WebGPU**
(falls back to a much slower CPU path when WebGPU is unavailable). Everything
loads on first use, so it costs nothing until someone enables it:

| Option | Model | Download |
|---|---|---|
| Quality | `RealESRGAN_x2plus` — [SceneWorks/real-esrgan-onnx](https://huggingface.co/SceneWorks/real-esrgan-onnx) | 67 MB |
| Fast | `realesr-general-x4v3`, 4x → resampled to 2x — [xrds/realesrgan-x4v3-fixed](https://huggingface.co/xrds/realesrgan-x4v3-fixed) | 5 MB |

- Model files are fetched from Hugging Face (pinned to a commit) and cached
  with the Cache API, so they download once per browser.
- ORT's ~27 MB WASM runtime is loaded from jsDelivr (pinned to the installed
  `onnxruntime-web` version) rather than bundled — `vite.config.ts` aliases
  `onnxruntime-web/webgpu` to the non-bundled entry so the builds stay small.
- Images are processed in 256 px tiles with a 16 px overlap that's discarded,
  so there are no seams; transparency is carried over separately.
- Image pipeline order: crop → redaction → AI upscale → resize.
- **Video**: every frame is upscaled in a Mediabunny `process` hook
  ([src/videoUpscale.ts](src/videoUpscale.ts)) that wraps the rest of the frame
  pipeline (time-lapse, frame blending, section joins). Mediabunny runs `process`
  after its own resize, so with upscale on the resize is done in the hook instead,
  keeping the order crop → AI upscale → resize. Expect well below real time — on
  a desktop GPU a 640×800 frame takes ~0.4 s (Fast) or ~1.3 s (Quality).

See [src/upscaler.ts](src/upscaler.ts).

## AI frame interpolation (RIFE)

The **✨ AI Frame Interpolation (RIFE)** panel synthesizes in-between frames
with [RIFE](https://github.com/hzwer/Practical-RIFE) 4.9 (MIT). It shows the
detected source frame rate and takes two settings — **playback speed** and
**output frame rate** — with a live summary of how many frames RIFE will add:

- **Smoother**: same speed, higher frame rate (e.g. 30 → 60 fps).
- **Slow motion**: same frame rate, slowed down (e.g. 60 fps at 0.5×).

Enabling it picks a sensible default for the source (Smoother below 50 fps,
Slow motion at 50 fps and up). RIFE owns frame timing while it's on, so the
Speed & Frame Rate panel is hidden; slow-motion audio reuses the same
keep-pitch / pitch / remove handling as the speed change.

- Model: `rife49_ensemble_True_scale_1_sim.onnx` from
  [yuvraj108c/rife-onnx](https://huggingface.co/yuvraj108c/rife-onnx) (21 MB),
  loaded and cached through the same shared runtime as AI upscale
  ([src/onnxRuntime.ts](src/onnxRuntime.ts)).
- Frames are padded to a multiple of 64 (edge-extended) and run whole — no tiling.
  ~60 ms per synthesized 640×832 frame on a desktop GPU.
- Hard scene cuts are detected (mean frame difference) and fall back to the
  nearest real frame rather than morphing between shots.
- Composes with AI upscale: interpolation runs first, then every output frame
  is upscaled.

See [src/frameInterpolation.ts](src/frameInterpolation.ts).

## Embedding the web component

After `npm run build:component`, copy the contents of `dist-component/` to your
site (`media-converter.js` plus its lazily loaded chunks — `heic-to-*.js` is only
fetched when a HEIC image is opened, `ort.webgpu.min-*.js` only when AI upscale
or interpolation runs) and add:

```html
<script type="module" src="/path/to/media-converter.js"></script>

<media-converter></media-converter>
```

That's it. The component:

- Is **style-isolated in both directions** via shadow DOM — the host page's CSS
  can't leak in, and Pico can't leak out.
- Bundles MediaBunny, Pico, and all CSS into `media-converter.js`; the HEIC
  decoder and ML runtime are separate chunks fetched only when used. No build
  step on the host side.
- Is **responsive to its own width** (CSS container queries), so it lays out
  correctly even inside a narrow host column.
- Accepts an optional initial theme: `<media-converter theme="light">`
  (the saved/OS preference then takes over).
- Also registers a deprecated `<mediabunny-toolkit>` alias for backwards
  compatibility.

See `component-demo.html` for a working example that embeds the component in a
deliberately clashing host page to demonstrate the isolation.

> **Note:** the toolkit taps into `console.log/warn/error` to feed its in-UI
> diagnostics panel (installed once, fans out to every mounted instance). It
> always forwards to the real console too.

## Layout

Once media is loaded, the UI is a three-column workflow with numbered headings,
collapsing gracefully as the component narrows:

**1 Input** (preview + metadata) → **2 Conversion Settings** (collapsible
panels) → **3 Output** (render button, size estimate, progress, download, and
the collapsible diagnostics console).

## Browser support & network use

- **WebCodecs** is required for video/audio work. Current Chromium browsers
  (Chrome, Edge) have the most complete codec support; Safari and Firefox work
  with the codecs they expose (the codec menus only list what the browser can
  encode).
- **WebGPU** powers AI upscale and RIFE. Without it they fall back to the CPU and
  are very slow (the UI warns about this).
- **Screen capture** needs `getDisplayMedia` (desktop browsers); the panel hides
  itself where it's unavailable.
- **Network**: your media never leaves the browser. The only requests beyond the
  page itself are on-demand downloads — the onnxruntime-web WASM runtime from
  jsDelivr and the AI models from Hugging Face (both pinned, and models are
  cached after the first use). The one exception is the voice-denoise model
  ([skeskinen/resemble-denoise-onnx-inference](https://github.com/skeskinen/resemble-denoise-onnx-inference),
  MIT, ~43 MB), which comes from GitHub, pinned to a commit.

---

## Roadmap

Planned work and completed milestones are tracked in [TODO.md](TODO.md).
