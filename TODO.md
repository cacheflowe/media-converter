# Media Converter — TODO / Roadmap

Working list of planned work. Loosely ordered; not all required for a first release.

## Planned

- [ ] **Add social cropping.**
    - [ ] Could crop fill/letterbox for various social media aspect ratios and specific resolutions (e.g., 1:1, 16:9, 4:5)
    - [ ] If letterboxing, apply blurred copy in the background as an alternative to black bg color
    - [ ] Think about other ways to enhance crops for social posts

- [ ] **Video → GIF export (optimized for small files).**
      A "🎞️ Export as GIF" panel in the video workspace: Mediabunny decodes frames (honoring trim +
      crop), frames are resized/sampled to the GIF rate, then quantized + encoded with
      [gifenc](https://github.com/mattdesl/gifenc) (MIT, ~9 KB). Avoid ffmpeg.wasm (too heavy) and
      gifski (AGPL).
    - [ ] Presets: Tiny (320px / 10fps / 64 colors), Balanced (480px / 12fps / 128), Sharp (640px / 15fps / 256).
    - [ ] Manual controls: width, fps, palette size, dither (off by default; ordered Bayer if on), loop.
    - [ ] One global palette sampled across the clip (no per-frame palette flicker, better LZW).
    - [ ] Frame differencing: pixels unchanged from the previous frame become transparent, with a
          "change tolerance" slider (lossy-style fuzz) — biggest win, especially for screen recordings.
    - [ ] Size estimate by test-encoding ~1s of the clip.
    - [ ] Later: speed/RIFE/upscale (these live in the Mediabunny process chain); maybe a "GIF-like"
          silent looping MP4/WebM preset as a 10–20x smaller alternative.

- [ ] **Add an audio track to a video.**
      Let the user pick an audio file (MP3/WAV/M4A/…) to merge into the output video — replace the
      original audio or mix it in. Mediabunny's `Conversion` takes a single input, so this likely means
      building the `Output` manually (video from the source, audio from the second file) — check the
      API first. Consider trim/offset to align it, looping or cutting to the video length, a
      volume/mix level, and a fade-out at the end.

- [ ] **Audio batching.**
      Batch now covers images + video. Add audio batch (sequential conversions, shared
      format/bitrate settings) on the same `batchShared` engine.

- [ ] **Further refactor (optional).**
      Not yet extracted: a size-estimate helper, a collapsible-panel/card markup helper, and
      splitting the large `toolkitTemplate.ts` into per-workspace template fragments.

- [ ] **UI sweep + prep for release.**
      - Verify light theme (not just dark) across every panel.
      - Accessibility: labels/roles on custom controls (crop overlay, tool radios), keyboard
        operability, focus states.
      - Responsive/container-query check at narrow embed widths (the component can be dropped
        into a small column).
      - Empty/error states (unsupported file, decode failure) reviewed and friendly.
      - Reconsider the global `console` tee — make it opt-in or clearly scoped for a drop-in
        component on a third-party page.
      - Version bump in `package.json` (hosting is settled: GitHub Pages via Actions).
      - Progress UX: set `aria-busy="true"` on the output region while encoding, and show an
        indeterminate `<progress>` during init (before the first progress callback).

## Done

- [x] **AI upscale 2x** (Real-ESRGAN via onnxruntime-web on WebGPU) for images and video:
      Quality (x2plus, 67 MB) and Fast (general-x4v3, 5 MB) models from Hugging Face, lazy-loaded and
      cached; 256px tiles with discarded overlap (no seams); alpha preserved for images; video runs as
      a process hook with resize moved after the upscale (`src/upscaler.ts`, `src/videoUpscale.ts`).
- [x] **RIFE frame interpolation** (RIFE 4.9, 21 MB) with its own panel: detected source fps,
      playback speed + output fps, Smoother / Slow-motion presets, live "frames added" summary,
      scene-cut fallback; composes with AI upscale (`src/frameInterpolation.ts`).
- [x] Shared ML runtime (`src/onnxRuntime.ts`): ORT JS as a lazy chunk, WASM from jsDelivr instead
      of bundled (Vite alias to the non-bundled entry), WebGPU detection with CPU fallback.
- [x] Screen capture screenshots: single-frame PNG grab (optional 3/5 s delay) into the image workspace.
- [x] Moved out of `media-utility-scripts` into its own repo; GitHub Pages deploys via Actions on
      every push to `main`, publishing the app, the component demo, and `dist-component/`.
- [x] UI: numbered column headings (Input / Conversion Settings / Output), centered title that
      returns to the start screen, drop zone sized like the capture card, and a loading state
      while a dropped file is parsed.
- [x] Tab `<title>`, emoji favicon, SEO meta tags, Open Graph / Twitter link preview tags, and JSON-LD structured data for the standalone site (`index.html`, `component-demo.html`).
- [x] Renamed the web component to `<media-converter>` (with a deprecated `<mediabunny-toolkit>` alias).
- [x] Audio as a first-class media kind — audio workspace with player, metadata, trim, and transcode
      (MP3/M4A/Opus/WAV/FLAC), encodable-format filtering, and a size estimate (`src/audioWorkflow.ts`).
- [x] Shadow-DOM web component + standalone site from one shared core.
- [x] 3-column workflow layout (info | settings | output) with container queries.
- [x] Collapsible `<details>` settings panels (all start collapsed).
- [x] Context-aware hiding under Fast Copy (resize/encoding panels; audio limited to keep/drop).
- [x] Split Output Profile into Codec / Compression / Rotation / Resample panels.
- [x] Live output-size estimate (bitrate × duration; crop/trim/resize/fps aware) under the render button.
- [x] Spatial video cropping with draggable preview overlay (mediabunny native crop).
- [x] Console/logs styled as a collapsible card in the output column.
- [x] Image batching — drop multiple images to enter batch mode: shared format + downscale-only
      resize (preset fills an editable max-dimension), per-file queue, "Download all" as a single
      dependency-free ZIP (`src/imageBatchWorkflow.ts`, `src/zip.ts`).
- [x] Audio waveform — decoded via WebAudio, peaks drawn to a canvas with trim-selection dimming,
      a playhead, and click-to-seek.
- [x] Standardized settings-panel spacing across all workspaces via `.settings-stack`.
- [x] Clipboard paste support — pasting an image (e.g. a screenshot) anywhere on the page feeds
      it into the same load/batch pipeline as drag-and-drop.
- [x] Lightweight Base64 PNG — image workspace has a "Copy Lightweight Base64 PNG" action that
      quantizes the current crop/redaction/resize result to an indexed-color PNG (`upng-js`,
      selectable palette size) and copies an `<img>` tag straight to the clipboard.
- [x] Shared-component refactor: `src/shared.ts` (formatters, quality maps, codec/format builders),
      `src/trimController.ts` (video + audio share the dual-handle trim), and `src/batchShared.ts`
      (generic queue/zip/thumbnail engine that both image and video batch build on).
- [x] Video batching — drop multiple videos: shared codec/quality/resize (downscale-only) + remove-audio,
      first-frame thumbnails, per-file conversion progress, ZIP download-all (`src/videoBatchWorkflow.ts`).
