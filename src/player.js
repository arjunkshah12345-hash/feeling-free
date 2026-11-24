import * as THREE from 'three';
import { heightAt, wallX, KEEP, CITY_R, GATE, BOUNDS, clamp } from './world.js';

const G = 16;
export const STEP = 1 / 120;

export class Player {
  constructor(turrets) {
    this.turrets = turrets;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.reset(0, 0, 0);
    this.listeners = {};
  }

  on(name, fn) { this.listeners[name] = fn; }
  emit(name, ...a) { this.listeners[name]?.(...a); }

  reset(x, z, yaw) {
    this.pos.set(x, heightAt(x, z), z);
    this.yaw = yaw;
    this.speed = 0;
    this.vy = 0;
    this.grounded = true;
    this.steer = 0;
    this.lean = 0;
    this.pitch = 0;
    this.crank = 0;
    this.airTime = 0;
    this.effort = 0;
    this.pedaling = false;
    this.sprinting = false;
    this.scrape = 0;
    this.jumpQueued = 0;
    this.distance = 0;
    this.maxAir = 0;
  }

  get forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  step(h, input) {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const steerIn = clamp((input.left ? 1 : 0) - (input.right ? 1 : 0) + (input.steerAxis || 0), -1, 1);
    const rate = Math.abs(steerIn) > Math.abs(this.steer) ? 6 : 9;
    this.steer += (steerIn - this.steer) * Math.min(1, h * rate);

    const pedal = !!input.pedal;
    const sprint = pedal && !!input.sprint;
    this.pedaling = pedal;
    this.sprinting = sprint && this.grounded;
    if (input.jump) this.jumpQueued = 0.12;
    this.jumpQueued = Math.max(0, this.jumpQueued - h);

    const hf = heightAt(this.pos.x + fx * 0.6, this.pos.z + fz * 0.6);
    const hb = heightAt(this.pos.x - fx * 0.6, this.pos.z - fz * 0.6);
    const slope = (hf - hb) / 1.2;

    if (this.grounded) {
      let a = 0;
      const vmax = sprint ? 22 : 15.5;
      if (pedal && this.speed < vmax) a += (sprint ? 9.5 : 6.5) * (1 - Math.max(0, this.speed) / vmax) + 0.6;
      if (input.brake) {
        if (this.speed > 0.3) a -= 13;
        else a -= 2.5;
      }
      a -= (G * slope) / Math.sqrt(1 + slope * slope) * 0.8;
      a -= Math.sign(this.speed) * (0.12 + 0.0045 * this.speed * this.speed);
      this.speed += a * h;
      if (input.brake && this.speed < -3) this.speed = -3;
      if (!pedal && !input.brake && Math.abs(this.speed) < 0.2 && Math.abs(slope) < 0.06) this.speed = 0;
      const sp = Math.abs(this.speed);
      const turn = (2.3 / (1 + sp * 0.07)) * Math.min(1, 0.35 + sp / 3);
      this.yaw += this.steer * turn * Math.sign(this.speed || 1) * h;
    } else {
      this.speed -= Math.sign(this.speed) * 0.003 * this.speed * this.speed * h;
      this.yaw += this.steer * 0.55 * h;
    }
    this.effort += ((pedal ? (sprint ? 1 : 0.6) : 0) - this.effort) * Math.min(1, h * 4);
    if (pedal || Math.abs(this.speed) > 0.5) {
      const cadence = pedal ? Math.max(this.speed, 2) / 2.4 : 0;
      this.crank += cadence * h * 1.05;
    }

    // horizontal motion
    const nfx = -Math.sin(this.yaw), nfz = -Math.cos(this.yaw);
    const ox = this.pos.x, oz = this.pos.z;
    this.pos.x += nfx * this.speed * h;
    this.pos.z += nfz * this.speed * h;
    this.collide(nfx, nfz);
    this.distance += Math.hypot(this.pos.x - ox, this.pos.z - oz);

    // vertical motion
    const ground = heightAt(this.pos.x, this.pos.z);
    if (this.grounded) {
      const ballistic = this.pos.y + this.vy * h - 0.5 * G * h * h;
      if (this.jumpQueued > 0) {
        this.jumpQueued = 0;
        this.vy = Math.max(this.vy, 0) + 6.8;
        this.grounded = false;
        this.airTime = 0;
        this.pos.y = Math.max(ground, this.pos.y) + this.vy * h;
        this.emit('jump');
      } else if (ground < ballistic - 0.0004 && Math.abs(this.speed) > 4) {
        this.grounded = false;
        this.airTime = 0;
        this.pos.y = ballistic;
        this.vy -= G * h;
      } else {
        this.vy = (ground - this.pos.y) / h;
        this.vy = clamp(this.vy, -30, 30);
        this.pos.y = ground;
      }
    } else {
      this.airTime += h;
      this.vy -= G * h;
      this.pos.y += this.vy * h;
      this.maxAir = Math.max(this.maxAir, this.airTime);
      if (this.pos.y <= ground) {
        const groundVy = slope * this.speed;
        const impact = Math.max(0, groundVy - this.vy);
        this.pos.y = ground;
        this.grounded = true;
        this.vy = groundVy;
        if (this.airTime > 0.18) this.emit('land', impact, this.airTime);
        this.airTime = 0;
      }
    }

    // attitude
    const pitchT = this.grounded ? Math.atan(slope) : Math.atan2(this.vy, Math.max(Math.abs(this.speed), 2)) * 0.5;
    this.pitch += (pitchT - this.pitch) * Math.min(1, h * (this.grounded ? 14 : 3));
    const leanT = this.steer * clamp(Math.abs(this.speed) / 9, 0, 1) * 0.42 * Math.sign(this.speed || 1) + Math.sin(this.crank) * 0.03 * this.effort;
    this.lean += (leanT - this.lean) * Math.min(1, h * 6);

    this.vel.set(nfx * this.speed, this.vy, nfz * this.speed);
    this.scrape = Math.max(0, this.scrape - h * 3);
  }

  hit(nx, nz, fx, fz, strength = 1) {
    const into = -(fx * nx + fz * nz);
    if (into > 0 && this.speed > 0) {
      this.speed *= 1 - into * 0.55 * strength;
      // turn along the obstacle
      const tx = -nz, tz = nx;
      const side = fx * tx + fz * tz >= 0 ? 1 : -1;
      const target = Math.atan2(-tx * side, -tz * side);
      let d = target - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * 0.18 * into;
      this.scrape = Math.min(1, this.scrape + into * this.speed * 0.05);
      if (into * this.speed > 4) this.emit('bump', into * this.speed);
    }
  }

  collide(fx, fz) {
    const p = this.pos;
    // castle wall along the cliff
    const lim = wallX(p.z) - 3.4;
    if (p.x > lim) {
      p.x = lim;
      this.hit(-1, 0, fx, fz);
    }
    for (const t of this.turrets) {
      const dx = p.x - t.x, dz = p.z - t.z;
      if (Math.abs(dx) > t.r + 3 || Math.abs(dz) > t.r + 3) continue;
      const d = Math.hypot(dx, dz);
      const r = t.r + 0.7;
      if (d < r) {
        const nx = dx / d, nz = dz / d;
        p.x = t.x + nx * r; p.z = t.z + nz * r;
        this.hit(nx, nz, fx, fz);
      }
    }
    // the white city's ring wall, open at the gate
    const dx = p.x - KEEP.x, dz = p.z - KEEP.z;
    const dk = Math.hypot(dx, dz);
    const inGate = Math.abs(p.x - GATE.x) < 9.5 && p.z > GATE.z - 30;
    const ringR = CITY_R + 7;
    if (dk < ringR && !inGate) {
      const nx = dx / dk, nz = dz / dk;
      p.x = KEEP.x + nx * ringR; p.z = KEEP.z + nz * ringR;
      this.hit(nx, nz, fx, fz);
    }
    if (inGate && p.z < GATE.z - 4) { p.z = GATE.z - 4; this.speed *= 0.9; }
    // soft outer bounds
    if (p.x < BOUNDS.minX) { p.x = BOUNDS.minX; this.hit(1, 0, fx, fz, 0.6); }
    if (p.z > BOUNDS.maxZ) { p.z = BOUNDS.maxZ; this.hit(0, -1, fx, fz, 0.6); }
    if (p.z < BOUNDS.minZ && !inGate) { p.z = BOUNDS.minZ; this.hit(0, 1, fx, fz, 0.6); }
  }

  atGate() {
    return Math.abs(this.pos.x - GATE.x) < 9.5 && this.pos.z < GATE.z + 9 && this.pos.z > GATE.z - 30;
  }
}

// Simple waypoint autopilot used behind the title screen.
export class Autopilot {
  constructor() {
    this.pts = [
      [-40, 60], [-60, -120], [-120, -330], [-210, -560], [-300, -760], [-420, -620], [-470, -360], [-380, -120], [-230, 80], [-110, 160],
    ];
    this.i = 1;
  }
  input(player) {
    const [tx, tz] = this.pts[this.i];
    const dx = tx - player.pos.x, dz = tz - player.pos.z;
    if (Math.hypot(dx, dz) < 30) this.i = (this.i + 1) % this.pts.length;
    const want = Math.atan2(-dx, -dz);
    let d = want - player.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return {
      pedal: player.speed < 13.5,
      left: d > 0.06,
      right: d < -0.06,
      steerAxis: 0,
      sprint: false,
      brake: false,
      jump: false,
    };
  }
}
