// Shared onnxruntime-web plumbing for the in-browser ML features (AI upscale,
// RIFE frame interpolation).
//
// Both ORT and the model weights are loaded on first use, so nothing here
// weighs down the initial page load:
//  - ORT's JS is a lazy chunk; its WASM runtime is fetched from jsDelivr
//    (pinned to the bundled version) instead of being inlined into the build.
//  - Model files come from Hugging Face (pinned to a commit) and are kept in
//    the Cache API so they download only once per browser.

import type * as Ort from "onnxruntime-web/webgpu";

export type OnnxModel = {
  label: string;
  url: string;
  /** Approximate download size, used for progress when Content-Length is missing. */
  bytes: number;
};

export type ModelProgress = (message: string, fraction?: number) => void;

const MODEL_CACHE_NAME = "media-converter-models-v1";

let ortPromise: Promise<typeof Ort> | null = null;
let backendPromise: Promise<"webgpu" | "wasm"> | null = null;
const sessions = new Map<string, Promise<Ort.InferenceSession>>();

export function loadOrt() {
  ortPromise ??= import("onnxruntime-web/webgpu").then((ort) => {
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
    return ort;
  });
  return ortPromise;
}

/** "webgpu" when a GPU adapter is available, otherwise the (much slower) CPU fallback. */
export function getOrtBackend() {
  backendPromise ??= (async () => {
    try {
      const gpu = (navigator as any).gpu;
      if (gpu && (await gpu.requestAdapter())) return "webgpu" as const;
    } catch {
      // fall through to wasm
    }
    return "wasm" as const;
  })();
  return backendPromise;
}

async function fetchModel(model: OnnxModel, onProgress: ModelProgress): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE_NAME);
    const hit = await cache.match(model.url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    // Cache API unavailable (e.g. insecure context) — just download
    cache = null;
  }

  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || model.bytes;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(`Downloading model… ${Math.round((received / total) * 100)}%`, Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }

  try {
    await cache?.put(model.url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch (err) {
    console.warn(`Could not cache ${model.label} model:`, err);
  }
  return bytes;
}

/** Downloads (or reads from cache) and initializes a model; sessions are reused. */
export async function getModelSession(model: OnnxModel, onProgress: ModelProgress = () => {}) {
  let session = sessions.get(model.url);
  if (!session) {
    session = (async () => {
      const [ort, backend] = await Promise.all([loadOrt(), getOrtBackend()]);
      const bytes = await fetchModel(model, onProgress);
      onProgress(`Initializing ${backend === "webgpu" ? "WebGPU" : "CPU"} backend…`);
      return ort.InferenceSession.create(bytes, { executionProviders: [backend] });
    })();
    // Let a failed load be retried next time
    session.catch(() => sessions.delete(model.url));
    sessions.set(model.url, session);
  }
  const [ort, s] = await Promise.all([loadOrt(), session]);
  return { ort, session: s };
}
