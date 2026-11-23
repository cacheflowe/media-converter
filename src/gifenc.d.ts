// Minimal typings for gifenc (no types are published).
declare module "gifenc" {
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): number[][];

  export interface GifFrameOptions {
    palette?: number[][];
    /** Milliseconds (written in 10 ms units). */
    delay?: number;
    /** -1 = play once, 0 = forever, n = n extra loops. Only written on the first frame. */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    /** GIF disposal method (0–7); -1 lets gifenc choose. */
    dispose?: number;
    colorDepth?: number;
  }

  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoderInstance;
}
