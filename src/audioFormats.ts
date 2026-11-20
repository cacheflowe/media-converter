// Output audio formats shared by the audio workspace and the video's "Extract Audio".

import {
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  WavOutputFormat,
  FlacOutputFormat,
  canEncodeAudio,
  type OutputFormat,
  type AudioCodec,
} from "mediabunny";

export type AudioFormatSpec = {
  makeFormat: () => OutputFormat;
  codec: AudioCodec;
  ext: string;
  mime: string;
  lossless: boolean;
};

export const AUDIO_FORMATS: Record<string, AudioFormatSpec> = {
  mp3: { makeFormat: () => new Mp3OutputFormat(), codec: "mp3", ext: "mp3", mime: "audio/mpeg", lossless: false },
  m4a: { makeFormat: () => new Mp4OutputFormat(), codec: "aac", ext: "m4a", mime: "audio/mp4", lossless: false },
  opus: { makeFormat: () => new OggOutputFormat(), codec: "opus", ext: "ogg", mime: "audio/ogg", lossless: false },
  wav: { makeFormat: () => new WavOutputFormat(), codec: "pcm-s16", ext: "wav", mime: "audio/wav", lossless: true },
  flac: { makeFormat: () => new FlacOutputFormat(), codec: "flac", ext: "flac", mime: "audio/flac", lossless: true },
};

/**
 * Marks the options of an output-format <select> whose codec the browser can't
 * encode (e.g. MP3 in Chrome) and falls back to the first supported option.
 */
export async function markSupportedAudioFormats(select: HTMLSelectElement) {
  for (const opt of Array.from(select.options)) {
    const spec = AUDIO_FORMATS[opt.value];
    if (!spec) continue;
    let ok = false;
    try {
      ok = await canEncodeAudio(spec.codec);
    } catch {
      ok = false;
    }
    opt.disabled = !ok;
    const base = opt.textContent!.replace(/ — unavailable$/, "");
    opt.textContent = ok ? base : `${base} — unavailable`;
  }
  if (select.selectedOptions[0]?.disabled) {
    const firstOk = Array.from(select.options).find((o) => !o.disabled);
    if (firstOk) select.value = firstOk.value;
  }
}
