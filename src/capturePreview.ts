// Device pickers with live previews for the screen-capture bar: choose which
// microphone / webcam to use, and see (webcam) or hear (mic level meter) that it's
// the right one before recording. Device names only become visible after the user
// grants permission, so a preview is opened as soon as the box is ticked, then the
// list is filled in. Previews are released before recording starts, since some
// cameras can't be opened twice.

type PickerOptions = {
  kind: "audioinput" | "videoinput";
  checkbox: HTMLInputElement;
  select: HTMLSelectElement;
  /** Row holding the select and its preview; shown while the box is ticked. */
  wrap: HTMLElement;
  /** Constraints for the preview stream (the picker adds the chosen deviceId). */
  constraints: (deviceId: ConstrainDOMString | undefined) => MediaStreamConstraints;
  /** Called with each new preview stream, and with null when it's released. */
  onStream: (stream: MediaStream | null) => void;
  onError: (message: string) => void;
  storageKey: string;
};

const read = (key: string) => {
  try {
    return localStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable; the choice just isn't remembered
  }
};

/** `ideal` rather than `exact`, so an unplugged remembered device falls back to the default. */
export const deviceConstraint = (deviceId: string | undefined): ConstrainDOMString | undefined =>
  deviceId ? { ideal: deviceId } : undefined;

export function createDevicePicker(opts: PickerOptions) {
  const { kind, checkbox, select, wrap, constraints, onStream, onError, storageKey } = opts;
  let stream: MediaStream | null = null;
  let seq = 0;
  let selected = read(storageKey);

  async function populate(activeId: string | undefined) {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId !== "communications");
    select.replaceChildren(
      ...devices.map((d, i) => {
        const option = document.createElement("option");
        option.value = d.deviceId;
        option.textContent = d.label || `${kind === "audioinput" ? "Microphone" : "Camera"} ${i + 1}`;
        return option;
      }),
    );
    const wanted = [selected, activeId].find((id) => id && devices.some((d) => d.deviceId === id));
    if (wanted) select.value = wanted;
  }

  function release() {
    seq++;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    onStream(null);
  }

  async function open() {
    release();
    const mine = seq;
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints(deviceConstraint(select.value || selected)));
      if (mine !== seq || !checkbox.checked) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      await populate(s.getTracks()[0]?.getSettings().deviceId);
      onStream(s);
    } catch (err: any) {
      if (mine !== seq) return;
      onError(
        err?.name === "NotAllowedError"
          ? `${kind === "audioinput" ? "Microphone" : "Webcam"} access was blocked.`
          : `${kind === "audioinput" ? "Microphone" : "Webcam"} unavailable: ${err?.message || err}`,
      );
    }
  }

  checkbox.addEventListener("change", () => {
    wrap.style.display = checkbox.checked ? "" : "none";
    if (checkbox.checked) void open();
    else release();
  });
  select.addEventListener("change", () => {
    selected = select.value;
    write(storageKey, selected);
    void open();
  });
  navigator.mediaDevices.addEventListener?.("devicechange", () => {
    if (checkbox.checked && stream) void populate(select.value);
  });

  wrap.style.display = "none";

  return {
    /** The chosen device, to pass to the real recording request. */
    deviceId: () => (checkbox.checked ? select.value || selected : undefined),
    /** Frees the camera/mic (e.g. before recording starts). */
    release,
    /** Re-opens the preview if the box is still ticked (e.g. after a recording). */
    resume: () => {
      if (checkbox.checked) void open();
    },
  };
}

/** Drives a level meter bar from a mic stream; returns a stop function. */
export function startLevelMeter(stream: MediaStream, bar: HTMLElement) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-6);
    bar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  }, 60);
  return () => {
    clearInterval(timer);
    bar.style.width = "0%";
    void context.close();
  };
}
