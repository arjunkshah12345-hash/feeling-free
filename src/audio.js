// Procedural sound: wind that rises with speed, freewheel ticks, landing thumps,
// lantern chimes and the soundtrack (see music.js). No audio files.
import { Music } from './music.js';

const PENTA = [0, 2, 4, 7, 9]; // D major pentatonic above D5, in key with the music
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.tick = 0;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    this.windF = ctx.createBiquadFilter();
    this.windF.type = 'bandpass'; this.windF.frequency.value = 500; this.windF.Q.value = 0.6;
    this.windG = ctx.createGain(); this.windG.gain.value = 0.02;
    src.connect(this.windF).connect(this.windG).connect(this.master);
    src.start();

    const src2 = ctx.createBufferSource();
    src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 0.7;
    this.rustleF = ctx.createBiquadFilter();
    this.rustleF.type = 'highpass'; this.rustleF.frequency.value = 2500;
    this.rustleG = ctx.createGain(); this.rustleG.gain.value = 0;
    src2.connect(this.rustleF).connect(this.rustleG).connect(this.master);
    src2.start();

    // the soundtrack
    this.musicEngine = new Music(ctx, this.master, buf);
    this.intensity = 0.3;
    this.timer = setInterval(() => this.musicEngine.tick(), 50);
  }

  // Swing into the chorus for the arrival at the city.
  finale() {
    if (!this.musicEngine) return;
    this.musicEngine.cue('B');
    this.finaleHold = 0.85;
  }

  chime(n) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 74 + PENTA[n % 5] + 12 * Math.floor(n / 5);
    [0, 7, 12].forEach((iv, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = mtof(base + iv);
      const g = this.ctx.createGain();
      const st = t + i * 0.07;
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.18, st + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 2.6);
      o.connect(g).connect(this.master);
      if (this.musicEngine) g.connect(this.musicEngine.verb);
      o.start(st); o.stop(st + 2.7);
    });
  }

  thump(strength) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    const g = this.ctx.createGain();
    const v = Math.min(0.5, 0.12 + strength * 0.03);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.32);
    this.noiseHit(0.12, 900, v * 0.6);
  }

  noiseHit(dur, freq, vol) {
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }

  whoosh() {
    if (!this.ctx) return;
    this.noiseHit(0.5, 700, 0.12);
  }

  update(dt, speed, pedaling, airborne) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const sp = Math.abs(speed);
    this.windG.gain.setTargetAtTime(0.015 + Math.min(0.32, sp * sp * 0.0007), t, 0.25);
    this.windF.frequency.setTargetAtTime(350 + sp * 45, t, 0.25);
    this.rustleG.gain.setTargetAtTime(airborne ? 0 : Math.min(0.05, sp * 0.003), t, 0.1);
    const target = Math.max(this.finaleHold || 0, clamp01(0.26 + sp / 17) * (airborne ? 1.08 : 1));
    this.intensity += (target - this.intensity) * Math.min(1, dt * 0.35);
    if (this.musicEngine) this.musicEngine.setIntensity(this.intensity);
    if (!pedaling && sp > 1.5 && !airborne) {
      this.tick += sp * dt * 2.2;
      if (this.tick > 1) { this.tick = 0; this.noiseHit(0.018, 5200, 0.05); }
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.1);
  }
}
