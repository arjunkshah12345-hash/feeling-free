import * as THREE from 'three';
import { heightAt, wallX, clamp } from './world.js';

const V = THREE.Vector3;

export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.pos = new V();
    this.look = new V();
    this.yaw = 0;
    this.shakeAmt = 0;
    this.mode = 0; // 0 close chase, 1 high chase
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.dragging = false;
    this.idle = 0;
    this.shot = 0;
    this.shotT = 0;
    this.fov = 62;
    this.roll = 0;
    this.t = 0;
    this.first = true;
  }

  shake(a) { this.shakeAmt = Math.min(1.2, this.shakeAmt + a); }

  snap() { this.first = true; }

  ground(p, clearance) {
    const g = heightAt(p.x, p.z) + clearance;
    if (p.y < g) p.y = g;
    const lim = wallX(p.z) - 1.2;
    if (p.x > lim) p.x = lim;
  }

  updateChase(dt, pl) {
    this.t += dt;
    let d = pl.yaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 3.2);
    if (!this.dragging) {
      this.idle += dt;
      if (this.idle > 1.2) {
        this.orbitYaw *= Math.exp(-dt * 2);
        this.orbitPitch *= Math.exp(-dt * 2);
      }
    }
    const sp = Math.abs(pl.speed);
    const yaw = this.yaw + this.orbitYaw;
    const fwd = new V(-Math.sin(yaw), 0, -Math.cos(yaw));
    const far = this.mode === 1;
    const dist = (far ? 7.5 : 3.0) + sp * (far ? 0.08 : 0.034);
    const height = (far ? 3.4 : 1.55) + sp * 0.008 + this.orbitPitch * 4;
    const target = pl.pos.clone().addScaledVector(fwd, -dist);
    target.y = pl.pos.y + height;
    if (!pl.grounded) target.y = Math.max(target.y, pl.pos.y + height * 0.8);
    this.ground(target, 0.45);
    const lookT = pl.pos.clone().addScaledVector(new V(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 7 + sp * 0.25);
    lookT.y = pl.pos.y + (far ? 1.6 : 1.95) + sp * 0.03;
    const k = this.first ? 1 : 1 - Math.exp(-dt * 7);
    const kl = this.first ? 1 : 1 - Math.exp(-dt * 9);
    this.pos.lerp(target, k);
    this.look.lerp(lookT, kl);
    this.ground(this.pos, 0.4);
    this.first = false;
    const fovT = 58 + sp * 0.5 + (pl.sprinting ? 3 : 0);
    this.fov += (fovT - this.fov) * Math.min(1, dt * 3);
    this.roll += (-pl.lean * 0.22 - this.roll) * Math.min(1, dt * 4);
    this.apply(dt);
  }

  // Slow cinematic shots around an autopiloted rider for the title screen.
  updateCinematic(dt, pl) {
    this.t += dt;
    this.shotT += dt;
    const shotLen = 7.5;
    let cut = this.first;
    if (this.shotT > shotLen) { this.shotT = 0; this.shot = (this.shot + 1) % 4; cut = true; }
    const yaw = pl.yaw;
    const fwd = new V(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new V(Math.cos(yaw), 0, -Math.sin(yaw));
    const p = pl.pos;
    const u = this.shotT / shotLen;
    let tp, tl, fov;
    switch (this.shot) {
      case 0: // low and close behind, tilted up at the city
        tp = p.clone().addScaledVector(fwd, -4.2 + u * 0.6).addScaledVector(right, -0.6);
        tp.y = p.y + 1.0;
        tl = p.clone().addScaledVector(fwd, 30).add(new V(0, 7, 0));
        fov = 64;
        break;
      case 1: // tracking alongside, very low in the flowers
        tp = p.clone().addScaledVector(right, -6.5).addScaledVector(fwd, 1.5 - u * 2.5);
        tp.y = p.y + 1.05;
        tl = p.clone().add(new V(0, 1.0, 0)).addScaledVector(fwd, 0.5);
        fov = 42;
        break;
      case 2: // wide crane from behind
        tp = p.clone().addScaledVector(fwd, -14 - u * 3).addScaledVector(right, 5);
        tp.y = p.y + 5.5 + u * 2;
        tl = p.clone().addScaledVector(fwd, 25).add(new V(0, 4, 0));
        fov = 58;
        break;
      default: // behind-left, looking up toward the wall and cliff
        tp = p.clone().addScaledVector(fwd, -3.8).addScaledVector(right, -1.6);
        tp.y = p.y + 0.85;
        tl = p.clone().addScaledVector(fwd, 12).addScaledVector(right, 7).add(new V(0, 4.5, 0));
        fov = 70;
    }
    this.ground(tp, 0.35);
    if (cut) {
      this.pos.copy(tp); this.look.copy(tl); this.fov = fov;
      this.first = false;
    } else {
      this.pos.lerp(tp, 1 - Math.exp(-dt * 5));
      this.look.lerp(tl, 1 - Math.exp(-dt * 5));
      this.fov += (fov - this.fov) * Math.min(1, dt * 2);
    }
    this.roll *= Math.exp(-dt * 2);
    this.yaw = pl.yaw;
    this.apply(dt);
    return cut;
  }

  // Rising crane that pulls back from the gate until the gatehouse and the
  // whole keep sit in frame, then drifts slowly sideways.
  updateFinish(dt, pl, keep, gate) {
    this.t += dt;
    this.finT = (this.finT || 0) + dt;
    const drift = Math.sin(this.finT * 0.12) * 18;
    const target = new V(gate.x - 26 + drift, 0, gate.z + 118);
    target.y = heightAt(target.x, target.z) + 32 + Math.min(10, this.finT * 0.8);
    this.pos.lerp(target, 1 - Math.exp(-dt * 0.9));
    this.ground(this.pos, 1.5);
    const lt = new V(keep.x, 330, keep.z);
    this.look.lerp(lt, 1 - Math.exp(-dt * 0.8));
    this.fov += (60 - this.fov) * Math.min(1, dt);
    this.roll *= Math.exp(-dt * 2);
    this.apply(dt);
  }

  apply(dt) {
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.2);
    const s = this.shakeAmt * this.shakeAmt;
    const t = this.t;
    const off = new V(Math.sin(t * 37.1) * 0.07, Math.sin(t * 43.7 + 1.3) * 0.09, Math.sin(t * 29.3 + 2.1) * 0.05).multiplyScalar(s);
    this.cam.position.copy(this.pos).add(off);
    const fwd = this.look.clone().sub(this.pos).normalize();
    const up = new V(0, 1, 0).applyAxisAngle(fwd, this.roll);
    this.cam.up.copy(up);
    this.cam.lookAt(this.look);
    this.cam.fov = clamp(this.fov, 35, 90);
    this.cam.updateProjectionMatrix();
  }
}
