# Media Converter

A **100% in-browser** media converter for video and images. Nothing is uploaded
to a server — all decoding, transcoding, resizing, cropping, and redaction runs
locally in the browser via [MediaBunny](https://github.com/Vanilagy/mediabunny)
on top of the native **WebCodecs** API.

Features:

- **Video**: transcode (MP4/WebM, H.264/HEVC/VP9/VP8/AV1), trim, resize, rotate,
  frame-rate resampling (frame-repeat or bidirectional blending), audio
  transcode/copy/strip, quality/bitrate control, fast-copy (no re-encode) trims.
- **Image**: crop (drag handles), resize/scale presets, redaction brush
  (blur / pixelate / solid), format + quality export (JPEG/PNG/WebP/AVIF),
  **AI upscale 2x** (Real-ESRGAN on WebGPU — see below).
- Live side-by-side original/output comparison and a verbose diagnostics console.
- Light/dark theme.

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
| `src/toolkitCore.ts` | All behavior: `mountToolkit(root, { themeElement })`, scoped to whatever root it's given (a `Document` or a `ShadowRoot`). |
| `src/imageWorkflow.ts` | Image crop/redact/export workflow (also root-scoped). |
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
- Bundles everything (MediaBunny, Pico, all CSS) into the one JS file — no extra
  assets, no build step on the host side.
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

Once media is loaded, the UI is a three-column workflow that collapses
gracefully as the component narrows:

**Column 1 — Input / Info** (preview + metadata) → **Column 2 — Settings**
(conversion controls) → **Column 3 — Output** (render button, size estimate,
progress, download, and the collapsible diagnostics console).

---

## Roadmap

Planned work and completed milestones are tracked in [TODO.md](TODO.md).
