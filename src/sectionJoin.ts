// Helpers for joining several kept sections of a clip into one timeline.
// The conversion spans the first section's start to the last section's end, and
// these map each timestamp (relative to that start) to its place in the joined
// output, or drop it when it falls in a gap between sections.

import type { AudioSample } from "mediabunny";

export type TimeRange = { start: number; end: number };

export function createSectionMapper(ranges: TimeRange[]) {
  const base = ranges[0].start;
  const offsets: number[] = [];
  let acc = 0;
  for (const r of ranges) {
    offsets.push(acc);
    acc += r.end - r.start;
  }
  /** Joined-output time for a timestamp relative to the trim start, or null in a gap. */
  return (t: number) => {
    const abs = t + base;
    const i = ranges.findIndex((r) => abs >= r.start && abs < r.end);
    return i === -1 ? null : abs - ranges[i].start + offsets[i];
  };
}

/** Audio is kept per sample (a few ms of granularity), judged by its midpoint. */
export function createSectionAudioProcess(mapTime: (t: number) => number | null) {
  return (sample: AudioSample): AudioSample | null => {
    const t = mapTime(sample.timestamp + sample.duration / 2);
    if (t === null) return null;
    const out = sample.clone();
    out.setTimestamp(Math.max(0, t - sample.duration / 2));
    return out;
  };
}
