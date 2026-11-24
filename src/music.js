// "feeling free": a small piece for felt piano, strings, flute, bass and brushed
// drums, synthesised live with WebAudio. Layers follow how fast you're riding.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const BPM = 92;
const STEP = 60 / BPM / 4; // one 16th note

// Voicings low -> high (the first note doubles the bass root).
const CH = {
  Dmaj9: [38, 50, 57, 61, 64, 66],
  Bm9: [47, 50, 54, 57, 61, 62],
  Gmaj9: [43, 50, 54, 57, 59, 62],
  A6: [45, 52, 57, 61, 64, 66],
  Fsm7: [42, 49, 52, 57, 61, 64],
  Em9: [40, 47, 50, 54, 55, 59],
  A7: [45, 52, 55, 57, 61, 64],
  Gmaj7: [43, 50, 55, 59, 62, 66],
  Dadd9: [38, 50, 54, 57, 62, 64],
  A7sus: [45, 52, 55, 57, 62, 64],
};

// Melodies as [midi, sixteenths], 0 = rest. Each covers eight bars (128 steps).
const MEL_A = [
  [69, 4], [78, 6], [76, 2], [74, 4],
  [73, 2], [74, 2], [71, 8], [66, 4],
  [67, 4], [71, 4], [74, 4], [78, 4],
  [76, 12], [73, 2], [74, 2],
  [76, 4], [73, 4], [69, 6], [71, 2],
  [74, 6], [73, 2], [71, 4], [69, 4],
  [67, 4], [71, 4], [74, 4], [76, 4],
  [74, 4], [73, 10], [0, 2],
];
const MEL_B = [
  [74, 2], [76, 2], [78, 8], [76, 2], [74, 2],
  [76, 6], [73, 2], [69, 8],
  [73, 2], [74, 2], [76, 8], [78, 2], [76, 2],
  [74, 6], [71, 2], [66, 8],
  [71, 2], [74, 2], [79, 8], [78, 2], [76, 2],
  [78, 4], [76, 4], [73, 4], [76, 4],
  [74, 12], [69, 4],
  [74, 10], [0, 2], [69, 2], [71, 2],
];
const MEL_C = [
  [74, 16],
  [74, 8], [71, 8],
  [73, 16],
  [73, 8], [76, 8],
  [74, 16],
  [78, 16],
  [79, 8], [78, 8],
  [76, 16],
];

const A_CH = ['Dmaj9', 'Bm9', 'Gmaj9', 'A6', 'Fsm7', 'Bm9', 'Em9', 'A7'];
const B_CH = ['Gmaj7', 'A6', 'Fsm7', 'Bm9', 'Gmaj7', 'A6', 'Dadd9', 'Dadd9'];
const C_CH = ['Bm9', 'Gmaj9', 'Dmaj9', 'A6', 'Bm9', 'Gmaj9', 'Em9', 'A7sus'];

const SONG = [
  { name: 'intro', chords: ['Dmaj9', 'Gmaj9', 'Dmaj9', 'Gmaj9'], mel: null, drums: 0 },
  { name: 'A', chords: A_CH, mel: MEL_A, voice: 'piano', drums: 0.45 },
  { name: 'B', chords: B_CH, mel: MEL_B, voice: 'flute', drums: 1 },
  { name: 'C', chords: C_CH, mel: MEL_C, voice: 'strings', drums: 0.35 },
  { name: 'A2', chords: A_CH, mel: MEL_A, voice: 'flute', drums: 0.7 },
  { name: 'B2', chords: B_CH, mel: MEL_B, voice: 'both', drums: 1 },
];
const LOOP_TO = 1;

function onsets(mel) {
  const map = new Map();
  if (!mel) return map;
  let s = 0;
  for (const [m, d] of mel) { if (m) map.set(s, [m, d]); s += d; }
  return map;
}
for (const sec of SONG) sec.on = onsets(sec.mel);

const ARP = [0, 2, 3, 4, 5, 4, 3, 2];

export class Music {
  constructor(ctx, out, noiseBuf) {
    this.ctx = ctx;
    this.noise = noiseBuf;
    this.intensity = 0.3;
    this.sec = 0;
    this.step = 0;
    this.nextT = ctx.currentTime + 0.15;
    this.rnd = 1;

    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.bus = g(0.72);
    // gentle low cut on the whole mix
    this.lowcut = ctx.createBiquadFilter(); this.lowcut.type = 'highpass'; this.lowcut.frequency.value = 48; this.lowcut.Q.value = 0.6;
    this.bus.connect(this.lowcut).connect(out);
    // hall reverb from a generated, darkening impulse response
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.impulse(3.6, 2.4);
    this.verbOut = g(0.5);
    this.verb.connect(this.verbOut).connect(this.bus);
    // keep the low end out of the hall so it stays clear
    this.verbIn = ctx.createBiquadFilter(); this.verbIn.type = 'highpass'; this.verbIn.frequency.value = 220;
    this.verbIn.connect(this.verb);
    this.send = (node, amt) => { const s = g(amt); node.connect(s).connect(this.verbIn); };

    this.piano = g(1); this.piano.connect(this.bus); this.send(this.piano, 0.38);
    this.pad = g(0); this.pad.connect(this.bus); this.send(this.pad, 0.7);
    this.lead = g(1); this.lead.connect(this.bus); this.send(this.lead, 0.55);
    this.bass = g(0); this.bass.connect(this.bus); this.send(this.bass, 0.08);
    this.drums = g(0); this.drums.connect(this.bus); this.send(this.drums, 0.16);
    // a dotted-eighth echo on the flute
    const dl = ctx.createDelay(1.5);
    dl.delayTime.value = STEP * 3;
    const fb = g(0.28);
    const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 2600;
    this.lead.connect(dl); dl.connect(dlf).connect(fb).connect(dl);
    const dlOut = g(0.35); dlf.connect(dlOut).connect(this.bus); this.send(dlOut, 0.6);
    // shared string vibrato
    this.vib = ctx.createOscillator(); this.vib.frequency.value = 5.1;
    this.vibAmt = g(7); this.vib.connect(this.vibAmt); this.vib.start();
    this.levels(0.3, true);
  }

  rand() { this.rnd = (this.rnd * 16807) % 2147483647; return (this.rnd - 1) / 2147483646; }

  impulse(sec, decay) {
    const ctx = this.ctx, rate = ctx.sampleRate, len = Math.floor(rate * sec);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const x = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        const a = 0.85 - 0.7 * t; // high frequencies die away first
        y += a * (x - y);
        const pre = Math.min(1, i / (rate * 0.012));
        d[i] = y * pre * (1.6 - t);
      }
    }
    return buf;
  }

  setIntensity(v) { this.intensity = v; }

  // Jump to a named section at the next bar line.
  cue(name) { const i = SONG.findIndex((s) => s.name === name); if (i >= 0) this.pending = i; }

  levels(I, now) {
    const t = this.ctx.currentTime, tc = now ? 0.01 : 1.6;
    this.pad.gain.setTargetAtTime(0.35 + 0.65 * smooth(0.15, 0.5, I), t, tc);
    this.bass.gain.setTargetAtTime(smooth(0.28, 0.55, I), t, tc);
    this.drums.gain.setTargetAtTime(smooth(0.45, 0.8, I), t, tc);
  }

  // Schedule everything that starts before `until` (seconds, context time).
  scheduleUntil(until) {
    let guard = 0;
    while (this.nextT < until && guard++ < 512) {
      this.playStep(this.nextT);
      this.nextT += STEP;
      this.step++;
      const sec = SONG[this.sec];
      if (this.step % 16 === 0 && this.pending !== undefined) {
        this.sec = this.pending; this.pending = undefined; this.step = 0;
      } else if (this.step >= sec.chords.length * 16) {
        this.step = 0;
        this.sec = this.sec + 1 >= SONG.length ? LOOP_TO : this.sec + 1;
      }
    }
  }

  tick() {
    if (this.ctx.state !== 'running') return;
    this.levels(this.intensity);
    if (this.nextT < this.ctx.currentTime) this.nextT = this.ctx.currentTime + 0.05; // after a stall
    this.scheduleUntil(this.ctx.currentTime + 0.3);
  }

  playStep(t) {
    const sec = SONG[this.sec];
    const bar = Math.floor(this.step / 16), s = this.step % 16;
    const ch = CH[sec.chords[bar]];
    const hum = () => (this.rand() - 0.5) * 0.012;
    const I = this.intensity;
    // piano: flowing broken chords in eighths, pedalled through the bar
    if (s % 2 === 0) {
      const idx = ARP[s / 2];
      const vel = (s === 0 ? 0.5 : 0.36) + this.rand() * 0.08;
      this.pianoNote(t + hum(), ch[idx], vel, (16 - s) * STEP + 0.25, (idx - 2.5) * 0.12);
      if (s === 0) this.pianoNote(t, ch[0], 0.22, 16 * STEP + 0.3, -0.1);
      if (s === 12 && I > 0.6 && sec.drums > 0.5) this.pianoNote(t + hum(), ch[5] + 12, 0.22, 4 * STEP + 0.2, 0.3);
    }
    // strings: one held chord per bar, overlapping into the next
    if (s === 0) this.stringChord(t, ch.slice(2), 16 * STEP);
    // bass
    if (s === 0) this.bassNote(t, ch[0], 0.9, (I > 0.5 ? 6 : 14) * STEP);
    if (I > 0.5) {
      if (s === 6) this.bassNote(t, ch[0], 0.55, 2 * STEP);
      if (s === 8) this.bassNote(t, ch[0], 0.8, 6 * STEP);
      if (s === 14) this.bassNote(t, ch[0] + 7, 0.55, 2 * STEP);
    }
    // brushed kit
    const dr = sec.drums;
    if (dr > 0) {
      if (s === 0 || s === 8 || (s === 11 && dr > 0.6)) this.kick(t, s === 0 ? 1 : 0.75);
      if (s === 4 || s === 12) this.brush(t + hum(), 0.8 * dr);
      if (s % 2 === 0) this.shaker(t + hum(), (s % 4 === 2 ? 0.7 : 0.4) * dr);
      else if (I > 0.75) this.shaker(t + hum(), 0.22 * dr);
      const last = bar === sec.chords.length - 1;
      if (last && s >= 13) this.brush(t + hum(), 0.4 + (s - 13) * 0.15);
    }
    // melody
    const n = sec.on.get(this.step);
    if (n) {
      const [m, d] = n;
      const dur = d * STEP;
      if (sec.voice === 'piano') this.pianoNote(t, m, 0.62, dur + 0.15, 0.05);
      else if (sec.voice === 'flute') this.flute(t, m, dur, 0.9);
      else if (sec.voice === 'strings') this.stringLine(t, m, dur, 1);
      else if (sec.voice === 'both') { this.flute(t, m, dur, 0.9); this.stringLine(t, m - 12, dur, 0.7); }
    }
  }

  // ---- instruments -------------------------------------------------------

  pianoNote(t, midi, vel, dur, pan = 0) {
    const ctx = this.ctx, f = mtof(midi);
    dur = Math.max(0.22, dur);
    const out = ctx.createGain();
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -0.8, 0.8);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.3;
    const bright = 1100 + 3400 * vel + f * 1.5;
    if (midi < 50) vel *= 0.75;
    lp.frequency.setValueAtTime(bright, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(450, bright * 0.38), t + 2.2);
    out.connect(lp).connect(p).connect(this.piano);
    const decay = clamp(3.4 - (midi - 48) * 0.04, 1.0, 4.5);
    const end = t + Math.min(dur + 0.5, decay * 2.2);
    const H = [[1, 1], [2, 0.38], [3, 0.17], [4, 0.1], [5, 0.05], [6, 0.03]];
    for (const [k, a] of H) {
      const fr = f * k * Math.sqrt(1 + 0.0004 * k * k);
      if (fr > 9000) break;
      const o = ctx.createOscillator();
      o.frequency.value = fr;
      o.detune.value = (this.rand() - 0.5) * 4;
      const og = ctx.createGain();
      const pk = a * vel * 0.2;
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(pk, t + 0.005);
      og.gain.setTargetAtTime(pk * 0.4, t + 0.005, 0.09 / Math.sqrt(k));
      og.gain.setTargetAtTime(0, t + 0.2, (decay / Math.pow(k, 0.8)) * 0.45);
      og.gain.setTargetAtTime(0, t + dur, 0.12); // damper
      o.connect(og).connect(out);
      o.start(t); o.stop(end + 0.6);
    }
    // the felt hammer
    const nz = ctx.createBufferSource(); nz.buffer = this.noise;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = Math.min(4000, f * 3); nf.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.05, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    nz.connect(nf).connect(ng).connect(out);
    nz.start(t, this.rand() * 1.5); nz.stop(t + 0.04);
  }

  saws(t, midi, level, attack, dur, release, dest, pan) {
    const ctx = this.ctx, f = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.setValueAtTime(level, t + Math.max(attack, dur));
    g.gain.linearRampToValueAtTime(0, t + Math.max(attack, dur) + release);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p).connect(dest);
    for (const d of [-11, -3, 6, 12]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = f; o.detune.value = d + (this.rand() - 0.5) * 4;
      this.vibAmt.connect(o.detune);
      o.onended = () => { try { this.vibAmt.disconnect(o.detune); } catch (e) { /* already gone */ } };
      o.connect(g);
      o.start(t); o.stop(t + Math.max(attack, dur) + release + 0.05);
    }
  }

  stringChord(t, notes, dur) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2100; lp.Q.value = 0.5;
    lp.connect(this.pad);
    notes.forEach((m, i) => this.saws(t, m, 0.022, 0.9, dur, 1.5, lp, (i / (notes.length - 1) - 0.5) * 0.9));
  }

  stringLine(t, midi, dur, vel) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.6;
    lp.connect(this.lead);
    this.saws(t, midi, 0.032 * vel, 0.28, dur, 0.6, lp, 0.1);
  }

  flute(t, midi, dur, vel) {
    const ctx = this.ctx, f = mtof(midi);
    const g = ctx.createGain();
    const lvl = 0.14 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + 0.07);
    g.gain.setTargetAtTime(lvl * 0.82, t + 0.07, 0.25);
    g.gain.setTargetAtTime(0, t + dur - 0.02, 0.07);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
    g.connect(lp).connect(this.lead);
    const o = ctx.createOscillator(); o.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2;
    const o2g = ctx.createGain(); o2g.gain.value = 0.1;
    // vibrato that blooms on longer notes
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.3;
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(0, t + 0.22);
    lg.gain.linearRampToValueAtTime(11, t + 0.7);
    lfo.connect(lg); lg.connect(o.detune); lg.connect(o2.detune);
    o.connect(g); o2.connect(o2g).connect(g);
    // breath
    const nz = ctx.createBufferSource(); nz.buffer = this.noise; nz.loop = true;
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = f * 1.5; bf.Q.value = 1.5;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(0.25, t + 0.04);
    bg.gain.setTargetAtTime(0.05, t + 0.05, 0.1);
    nz.connect(bf).connect(bg).connect(g);
    const end = t + dur + 0.4;
    for (const n of [o, o2, lfo]) { n.start(t); n.stop(end); }
    nz.start(t, this.rand() * 1.5); nz.stop(end);
  }

  bassNote(t, midi, vel, dur) {
    const ctx = this.ctx, f = mtof(midi);
    const g = ctx.createGain();
    const lvl = 0.13 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + 0.012);
    g.gain.setTargetAtTime(lvl * 0.65, t + 0.012, 0.18);
    g.gain.setTargetAtTime(0, t + dur, 0.06);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    g.connect(lp).connect(this.bass);
    const o = ctx.createOscillator(); o.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f;
    const o2g = ctx.createGain(); o2g.gain.value = 0.35;
    o.connect(g); o2.connect(o2g).connect(g);
    o.start(t); o2.start(t); o.stop(t + dur + 0.5); o2.stop(t + dur + 0.5);
  }

  kick(t, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(105, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.24 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.drums);
    o.start(t); o.stop(t + 0.45);
  }

  noiseHit(t, type, freq, q, attack, decay, lvl, dest) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    s.connect(f).connect(g).connect(dest);
    s.start(t, this.rand() * 1.5); s.stop(t + attack + decay + 0.02);
  }

  brush(t, vel) {
    this.noiseHit(t, 'bandpass', 2300, 0.6, 0.004, 0.2, 0.16 * vel, this.drums);
    this.noiseHit(t, 'lowpass', 900, 0.5, 0.01, 0.12, 0.08 * vel, this.drums);
  }

  shaker(t, vel) {
    this.noiseHit(t, 'highpass', 6800, 0.7, 0.012, 0.055, 0.07 * vel, this.drums);
  }
}
