// In-browser ML upscaling (Real-ESRGAN) via onnxruntime-web on WebGPU.
// Runtime/model loading is shared with frame interpolation (see onnxRuntime.ts).
//
// Images are processed in overlapping tiles to stay within GPU memory/buffer
// limits; each tile's padded border is discarded so seams don't show.

import { getModelSession, getOrtBackend, type ModelProgress, type OnnxModel } from "./onnxRuntime";

export type UpscaleModelId = "quality" | "fast";

type UpscaleModel = OnnxModel & {
  /** The model's native scale factor (outputs are resampled to OUTPUT_SCALE). */
  scale: number;
  /** Tile edge in input pixels. Must be even (x2plus pixel-unshuffles its input). */
  tileSize: number;
};

export const OUTPUT_SCALE = 2;

export const UPSCALE_MODELS: Record<UpscaleModelId, UpscaleModel> = {
  // RealESRGAN_x2plus (RRDBNet), true 2x. BSD-3-Clause.
  // https://huggingface.co/SceneWorks/real-esrgan-onnx
  quality: {
    label: "Real-ESRGAN x2plus",
    url: "https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/09f741bac80a246b407da3ee902bf5f3291b602f/real_esrgan_x2.onnx",
    bytes: 67_073_434,
    scale: 2,
    tileSize: 256,
  },
  // realesr-general-x4v3 (SRVGGNetCompact), 4x then downsampled to 2x. BSD-3-Clause upstream.
  // https://huggingface.co/xrds/realesrgan-x4v3-fixed (its config.json says swin2sr only so
  // Transformers.js will load it; the graph is the compact Real-ESRGAN net). Other exports of
  // this model declare output dims equal to input dims, which breaks ORT's buffer planning.
  fast: {
    label: "Real-ESRGAN general v3 (compact)",
    url: "https://huggingface.co/xrds/realesrgan-x4v3-fixed/resolve/b4a7f1f3308ad6c3c74cdbba38876019e0fae35a/onnx/model_quantized.onnx",
    bytes: 4_871_226,
    scale: 4,
    tileSize: 256,
  },
};

const TILE_PAD = 16;
const MAX_OUTPUT_PIXELS = 64_000_000;
const MAX_OUTPUT_SIDE = 16_384;

export type UpscaleProgress = ModelProgress;

/** "webgpu" when a GPU adapter is available, otherwise the (much slower) CPU fallback. */
export const getUpscaleBackend = getOrtBackend;

export type FrameUpscaler = {
  label: string;
  /**
   * Upscales `source` (srcW × srcH) by OUTPUT_SCALE. The returned canvas is reused
   * by the next call, so consume it (draw it, or wrap it in a VideoSample) first.
   */
  upscale(source: CanvasImageSource, srcW: number, srcH: number, onTile?: UpscaleProgress): Promise<HTMLCanvasElement>;
};

/**
 * Loads the model (downloading on first use) and returns an upscaler that keeps
 * its session and working canvases, for running many frames back to back.
 */
export async function createFrameUpscaler(
  id: UpscaleModelId,
  onProgress: UpscaleProgress = () => {},
): Promise<FrameUpscaler> {
  const model = UPSCALE_MODELS[id];
  const { ort, session } = await getModelSession(model, onProgress);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const padded = document.createElement("canvas");
  const paddedCtx = padded.getContext("2d", { willReadFrequently: true })!;
  const out = document.createElement("canvas");
  const outCtx = out.getContext("2d")!;
  const trimmed = document.createElement("canvas");
  const trimmedCtx = trimmed.getContext("2d")!;
  const tileCanvas = document.createElement("canvas");
  const tileCtx = tileCanvas.getContext("2d")!;

  async function upscale(source: CanvasImageSource, srcW: number, srcH: number, onTile?: UpscaleProgress) {
    // Pad to even dimensions (edge-extended) so every tile has even sides
    const w = srcW + (srcW % 2);
    const h = srcH + (srcH % 2);
    if (padded.width !== w || padded.height !== h) {
      padded.width = w;
      padded.height = h;
    }
    paddedCtx.clearRect(0, 0, w, h);
    paddedCtx.drawImage(source, 0, 0, srcW, srcH);
    if (w > srcW) paddedCtx.drawImage(padded, srcW - 1, 0, 1, srcH, srcW, 0, 1, srcH);
    if (h > srcH) paddedCtx.drawImage(padded, 0, srcH - 1, w, 1, 0, srcH, w, 1);
    const srcData = paddedCtx.getImageData(0, 0, w, h).data;

    if (out.width !== w * OUTPUT_SCALE || out.height !== h * OUTPUT_SCALE) {
      out.width = w * OUTPUT_SCALE;
      out.height = h * OUTPUT_SCALE;
    }
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";

    const T = model.tileSize;
    const s = model.scale;
    const cols = Math.ceil(w / T);
    const rows = Math.ceil(h / T);
    const totalTiles = cols * rows;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const done = row * cols + col;
        onTile?.(`Upscaling… tile ${done + 1}/${totalTiles}`, done / totalTiles);

        const x0 = col * T;
        const y0 = row * T;
        const tw = Math.min(T, w - x0);
        const th = Math.min(T, h - y0);
        const px0 = Math.max(0, x0 - TILE_PAD);
        const py0 = Math.max(0, y0 - TILE_PAD);
        const pw = Math.min(w, x0 + tw + TILE_PAD) - px0;
        const ph = Math.min(h, y0 + th + TILE_PAD) - py0;

        // RGBA (row-major) → planar RGB float [0,1]
        const plane = pw * ph;
        const input = new Float32Array(3 * plane);
        for (let y = 0; y < ph; y++) {
          let si = ((py0 + y) * w + px0) * 4;
          let di = y * pw;
          for (let x = 0; x < pw; x++, si += 4, di++) {
            input[di] = srcData[si] / 255;
            input[plane + di] = srcData[si + 1] / 255;
            input[2 * plane + di] = srcData[si + 2] / 255;
          }
        }

        const tensor = new ort.Tensor("float32", input, [1, 3, ph, pw]);
        const results = await session.run({ [inputName]: tensor });
        const result = results[outputName];
        const data = result.data as Float32Array;
        const ow = pw * s;
        const oh = ph * s;
        const oPlane = ow * oh;

        // Planar RGB float → RGBA bytes for the whole padded tile
        const img = new ImageData(ow, oh);
        const px = img.data;
        for (let i = 0, j = 0; i < oPlane; i++, j += 4) {
          px[j] = data[i] * 255;
          px[j + 1] = data[oPlane + i] * 255;
          px[j + 2] = data[2 * oPlane + i] * 255;
          px[j + 3] = 255;
        }
        tensor.dispose();
        result.dispose();

        // Drop the padding and place (resampling when the model's scale differs)
        if (tileCanvas.width !== ow || tileCanvas.height !== oh) {
          tileCanvas.width = ow;
          tileCanvas.height = oh;
        }
        tileCtx.putImageData(img, 0, 0);
        outCtx.drawImage(
          tileCanvas,
          (x0 - px0) * s,
          (y0 - py0) * s,
          tw * s,
          th * s,
          x0 * OUTPUT_SCALE,
          y0 * OUTPUT_SCALE,
          tw * OUTPUT_SCALE,
          th * OUTPUT_SCALE,
        );
      }
    }

    if (w === srcW && h === srcH) return out;
    // Trim the even-padding back off
    trimmed.width = srcW * OUTPUT_SCALE;
    trimmed.height = srcH * OUTPUT_SCALE;
    trimmedCtx.drawImage(out, 0, 0);
    return trimmed;
  }

  return { label: model.label, upscale };
}

/** Returns a new canvas at OUTPUT_SCALE × the source size. */
export async function upscaleCanvas(
  source: HTMLCanvasElement,
  id: UpscaleModelId,
  onProgress: UpscaleProgress = () => {},
): Promise<HTMLCanvasElement> {
  const srcW = source.width;
  const srcH = source.height;
  const outW = srcW * OUTPUT_SCALE;
  const outH = srcH * OUTPUT_SCALE;
  if (outW > MAX_OUTPUT_SIDE || outH > MAX_OUTPUT_SIDE || outW * outH > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `Upscaled output (${outW}×${outH}) would be too large for the browser. Crop or downsize the image first.`,
    );
  }

  const upscaler = await createFrameUpscaler(id, onProgress);
  const started = performance.now();
  const out = await upscaler.upscale(source, srcW, srcH, onProgress);

  // The models are RGB-only; carry transparency over with a smooth resize of the alpha
  const srcData = source.getContext("2d")!.getImageData(0, 0, srcW, srcH).data;
  if (hasTransparency(srcData)) {
    const alpha = document.createElement("canvas");
    alpha.width = outW;
    alpha.height = outH;
    const alphaCtx = alpha.getContext("2d")!;
    alphaCtx.imageSmoothingQuality = "high";
    alphaCtx.drawImage(source, 0, 0, outW, outH);
    const alphaData = alphaCtx.getImageData(0, 0, outW, outH).data;
    const outCtx = out.getContext("2d")!;
    const outImg = outCtx.getImageData(0, 0, outW, outH);
    for (let i = 3; i < alphaData.length; i += 4) outImg.data[i] = alphaData[i];
    outCtx.putImageData(outImg, 0, 0);
  }

  console.log(
    `AI upscale (${upscaler.label}): ${srcW}×${srcH} → ${outW}×${outH} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  onProgress("Upscale complete", 1);
  return out;
}

function hasTransparency(rgba: Uint8ClampedArray) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}
