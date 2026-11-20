// Pulls the audio track out of a loaded video into its own file: the video is
// dropped and the audio re-encoded to the chosen format, honoring the video's
// trim / sections and (optionally) the Enhance Voice settings. Used both for
// exporting a download and for handing the audio to the audio editor.

import { BufferTarget, Conversion, Output, type ConversionAudioOptions, type Input } from "mediabunny";
import type { AudioFormatSpec } from "./audioFormats";
import { createSectionAudioProcess, createSectionMapper, type TimeRange } from "./sectionJoin";
import { setupVoiceEnhance, type VoiceEnhanceOptions } from "./voiceEnhance";

type ExtractOptions = {
  input: Input;
  /** Output file name without extension. */
  baseName: string;
  spec: AudioFormatSpec;
  /** Bitrate for lossy formats. */
  bitrate: number;
  /** Kept sections of the source (null when trim is off). */
  ranges: TimeRange[] | null;
  enhance: VoiceEnhanceOptions | null;
  onStatus: (message: string) => void;
  onProgress: (fraction: number) => void;
  /** Called with the running conversion so the caller can cancel it. */
  onConversion: (conversion: Conversion) => void;
  isCancelled: () => boolean;
};

export async function extractAudio(opts: ExtractOptions): Promise<File> {
  const { input, spec, ranges, enhance } = opts;
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("This video has no audio track.");

  const target = new BufferTarget();
  const output = new Output({ format: spec.makeFormat(), target });
  const audio: ConversionAudioOptions = { forceTranscode: true, codec: spec.codec };
  if (!spec.lossless) audio.bitrate = opts.bitrate;

  // The conversion covers the first section's start to the last section's end
  const span = ranges ? { start: ranges[0].start, end: ranges[ranges.length - 1].end } : null;
  if (ranges && ranges.length > 1) audio.process = createSectionAudioProcess(createSectionMapper(ranges));

  if (enhance) {
    const setup = await setupVoiceEnhance({
      track,
      options: enhance,
      span,
      ranges: ranges ?? [],
      onStatus: opts.onStatus,
      isCancelled: opts.isCancelled,
    });
    if (setup.sampleRate) audio.sampleRate = setup.sampleRate;
    audio.process = setup.wrap(audio.process);
  }

  const conversion = await Conversion.init({ input, output, video: { discard: true }, audio, trim: span ?? undefined });
  if (!conversion.isValid) {
    conversion.discardedTracks.forEach((t) => console.warn(`Track discarded: ${t.reason}`));
    throw new Error("This audio format isn't supported by your browser.");
  }
  conversion.onProgress = opts.onProgress;
  opts.onConversion(conversion);
  await conversion.execute();

  const buffer = target.buffer;
  if (!buffer) throw new Error("Audio extraction produced an empty file.");
  return new File([buffer], `${opts.baseName}.${spec.ext}`, { type: spec.mime });
}
