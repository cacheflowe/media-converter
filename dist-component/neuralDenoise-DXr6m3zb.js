import { j as e, t, vt as n } from "./onnxRuntime-DBehIc4z.js";
// src/neuralDenoise.ts
var r = 44100, i = {
	label: "Resemble denoiser",
	url: "https://raw.githubusercontent.com/skeskinen/resemble-denoise-onnx-inference/577726152f06c8d8d6a4137371a5bd29a9936a87/denoiser.onnx",
	bytes: 42661638
}, a = 420, o = 4 * a, s = 841, c = 12, l = .5, u = class {
	n;
	factors = [];
	cos;
	sin;
	tmpRe = /* @__PURE__ */ new Float64Array(16);
	tmpIm = /* @__PURE__ */ new Float64Array(16);
	constructor(e) {
		this.n = e;
		let t = e;
		for (let e of [
			4,
			2,
			3,
			5,
			7
		]) for (; t % e === 0;) this.factors.push(e), t /= e;
		for (let e = 11; t > 1; e += 2) for (; t % e === 0;) this.factors.push(e), t /= e;
		if (this.factors.some((e) => e > 16)) throw Error(`Unsupported FFT size ${e}`);
		this.cos = new Float64Array(e), this.sin = new Float64Array(e);
		for (let t = 0; t < e; t++) this.cos[t] = Math.cos(2 * Math.PI * t / e), this.sin[t] = -Math.sin(2 * Math.PI * t / e);
	}
	forward(e, t, n, r) {
		this.rec(e, t, 0, 1, n, r, 0, this.n, 0);
	}
	rec(e, t, n, r, i, a, o, s, c) {
		if (s === 1) {
			i[o] = e[n], a[o] = t[n];
			return;
		}
		let l = this.factors[c], u = s / l;
		for (let s = 0; s < l; s++) this.rec(e, t, n + s * r, r * l, i, a, o + s * u, u, c + 1);
		let { cos: d, sin: f, tmpRe: p, tmpIm: m } = this, h = this.n / s, g = this.n / l;
		for (let e = 0; e < u; e++) {
			for (let t = 0; t < l; t++) {
				let n = o + t * u + e, r = t * e * h, s = d[r], c = f[r];
				p[t] = i[n] * s - a[n] * c, m[t] = i[n] * c + a[n] * s;
			}
			for (let t = 0; t < l; t++) {
				let n = 0, r = 0;
				for (let e = 0; e < l; e++) {
					let i = e * t % l * g;
					n += p[e] * d[i] - m[e] * f[i], r += p[e] * f[i] + m[e] * d[i];
				}
				i[o + e + t * u] = n, a[o + e + t * u] = r;
			}
		}
	}
}, d = new Float64Array(o);
for (let e = 0; e < o; e++) d[e] = .5 - .5 * Math.cos(2 * Math.PI * e / o);
function f(e, t) {
	let n = 2 * (t - 1), r = (e % n + n) % n;
	return r >= t && (r = n - r), r;
}
function p(e, t) {
	let n = Math.floor(e.length / a), r = new Float32Array(s * n), i = new Float32Array(s * n), c = new Float32Array(s * n), l = new Float64Array(o), u = new Float64Array(o), p = new Float64Array(o), m = new Float64Array(o), h = o / 2;
	for (let g = 0; g < n; g++) {
		let _ = g * a - h;
		for (let t = 0; t < o; t++) {
			let n = _ + t, r = n >= 0 && n < e.length ? e[n] : e[f(n, e.length)];
			l[t] = r * d[t], u[t] = 0;
		}
		t.forward(l, u, p, m);
		for (let e = 0; e < s; e++) {
			let t = p[e], a = m[e], o = Math.hypot(t, a), s = e * n + g;
			r[s] = o, i[s] = o > 0 ? t / o : 1, c[s] = o > 0 ? a / o : 0;
		}
	}
	return {
		mag: r,
		cos: i,
		sin: c,
		frames: n
	};
}
function m(e, t, n) {
	let r = e.frames + 1, i = o + a * (r - 1), c = new Float64Array(i), l = new Float64Array(i), u = new Float64Array(o), f = new Float64Array(o), p = new Float64Array(o), m = new Float64Array(o);
	for (let t = 0; t < r; t++) {
		let r = Math.min(t, e.frames - 1);
		for (let t = 0; t < s; t++) {
			let n = t * e.frames + r, i = e.mag[n] * e.cos[n], a = e.mag[n] * e.sin[n];
			(t === 0 || t === 840) && (a = 0), u[t] = i, f[t] = -a, t > 0 && t < 840 && (u[o - t] = i, f[o - t] = a);
		}
		n.forward(u, f, p, m);
		let i = t * a;
		for (let e = 0; e < o; e++) c[i + e] += p[e] / o * d[e], l[i + e] += d[e] * d[e];
	}
	let h = new Float32Array(t), g = o / 2;
	for (let e = 0; e < t; e++) {
		let t = e + g;
		if (t >= i) break;
		h[e] = l[t] > 1e-11 ? c[t] / l[t] : c[t];
	}
	return h;
}
async function h(e, t, n) {
	let { ort: r, session: i } = e, a = new Float32Array(n.length + 441);
	a.set(n);
	let o = p(a, t), c = [
		1,
		s,
		o.frames
	], l = await i.run({
		mag: new r.Tensor("float32", o.mag, c),
		cos: new r.Tensor("float32", o.cos, c),
		sin: new r.Tensor("float32", o.sin, c)
	}), [u, d, f] = i.outputNames.map((e) => l[e].data);
	return m({
		mag: u,
		cos: d,
		sin: f,
		frames: o.frames
	}, a.length, t).subarray(0, n.length);
}
async function g(e, n, a) {
	n("Loading AI denoiser…");
	let s = await t(i, n), d = new u(o), f = c * r, p = Math.round(l * r), m = 507150, g = new Float32Array(e.length), _ = Math.max(1, Math.ceil(Math.max(0, e.length - p) / m));
	for (let t = 0, r = 0; r < e.length; t++, r += m) {
		if (a()) return g;
		n(`Reducing noise… ${Math.round(t / _ * 100)}%`, t / _);
		let i = Math.min(e.length, r + f), o = e.slice(r, i), c = 1e-7;
		for (let e of o) c = Math.max(c, Math.abs(e));
		for (let e = 0; e < o.length; e++) o[e] /= c;
		let l = await h(s, d, o), u = i === e.length;
		for (let e = 0; e < l.length; e++) {
			let t = 1;
			r > 0 && e < p && (t = e / p), !u && e >= l.length - p && (t = Math.min(t, (l.length - e) / p)), g[r + e] += l[e] * c * t;
		}
		if (u) break;
	}
	return n("Reducing noise… 100%", 1), g;
}
async function _(e, t, n) {
	if (t === n || !e.length) return e;
	let r = new OfflineAudioContext(1, Math.ceil(e.length * n / t), n), i = r.createBuffer(1, e.length, t);
	i.copyToChannel(e, 0);
	let a = r.createBufferSource();
	return a.buffer = i, a.connect(r.destination), a.start(), (await r.startRendering()).getChannelData(0);
}
async function v(t, n, i, a) {
	i("Decoding audio…");
	let o = new e(t), s = [], c = 0, l = r, u = null;
	for await (let e of o.samples(n?.start, n?.end)) {
		if (a()) return e.close(), null;
		l = e.sampleRate;
		let t = 0, r = e.numberOfFrames;
		if (n && e.timestamp < n.start && (t = Math.round((n.start - e.timestamp) * e.sampleRate)), n && e.timestamp + e.duration > n.end && (r = Math.round((n.end - e.timestamp) * e.sampleRate)), t < r) {
			u ??= Math.max(e.timestamp, n?.start ?? 0);
			let i = r - t, a = new Float32Array(i), o = new Float32Array(e.numberOfFrames);
			for (let n = 0; n < e.numberOfChannels; n++) {
				e.copyTo(o, {
					planeIndex: n,
					format: "f32-planar"
				});
				for (let n = 0; n < i; n++) a[n] += o[t + n] / e.numberOfChannels;
			}
			s.push(a), c += i;
		}
		e.close();
	}
	if (!c) return null;
	let d = new Float32Array(c), f = 0;
	for (let e of s) d.set(e, f), f += e.length;
	s.length = 0;
	let p = await g(await _(d, l, r), i, a);
	return a() ? null : {
		pcm: p,
		start: u ?? 0
	};
}
function y(e, t) {
	let i = 0, a = !1;
	return (o) => {
		let s = o.numberOfFrames, c = o.numberOfChannels;
		if (o.sampleRate !== 44100) return a || console.warn(`AI denoise skipped: audio is ${o.sampleRate} Hz, expected ${r} Hz.`), a = !0, o.clone();
		let l = new Float32Array(s * c), u = new Float32Array(s);
		for (let n = 0; n < c; n++) {
			o.copyTo(u, {
				planeIndex: n,
				format: "f32-planar"
			});
			let r = n * s;
			for (let n = 0; n < s; n++) {
				let a = e.pcm[i + n] ?? 0;
				l[r + n] = t * a + (1 - t) * u[n];
			}
		}
		return i += s, new n({
			data: l,
			format: "f32-planar",
			numberOfChannels: c,
			sampleRate: o.sampleRate,
			timestamp: o.timestamp
		});
	};
}
async function* b(e, t) {
	let i = 4096, a = t.length ? t : [{
		start: e.start,
		end: e.start + e.pcm.length / r
	}];
	for (let t of a) {
		let a = Math.max(0, Math.round((t.start - e.start) * r)), o = Math.min(e.pcm.length, Math.round((t.end - e.start) * r));
		for (let t = a; t < o; t += i) {
			let a = e.pcm.slice(t, Math.min(o, t + i));
			yield new n({
				data: a,
				format: "f32-planar",
				numberOfChannels: 1,
				sampleRate: r,
				timestamp: t / r
			});
		}
	}
}
export { i as DENOISER_MODEL, r as DENOISER_SAMPLE_RATE, y as createDenoiseSubstitute, g as denoiseMono, b as denoisedSamples, v as prepareDenoisedAudio };
