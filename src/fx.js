import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { heightAt, KEEP } from './world.js';

// Seeds and pollen drifting on the wind around the rider.
export function buildPollen(shared) {
  const N = 320, tile = 70;
  const r = mulberry32(3);
  const pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = r() * tile; pos[i * 3 + 1] = r() * 14; pos[i * 3 + 2] = r() * tile;
    rnd[i] = r();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: shared.uTime, uCenter: shared.uGrassCenter, uPlayer: shared.uPlayer, uWindDir: shared.uWindDir, uPx: shared.uPixelRatio },
    vertexShader: /* glsl */ `
      attribute float aRnd;
      uniform float uTime; uniform vec2 uCenter; uniform vec3 uPlayer; uniform vec2 uWindDir; uniform float uPx;
      varying float vA;
      void main() {
        float tile = ${tile.toFixed(1)};
        vec3 p = position;
        p.xz += uWindDir * uTime * (1.2 + aRnd * 1.5);
        p.x += sin(uTime * 0.7 + aRnd * 40.0) * 0.8;
        p.z += cos(uTime * 0.5 + aRnd * 30.0) * 0.8;
        vec2 rel = mod(p.xz - uCenter + 0.5 * tile, tile) - 0.5 * tile;
        vec3 w = vec3(uCenter.x + rel.x, uPlayer.y - 2.0 + mod(p.y + sin(uTime * 0.4 + aRnd * 9.0) * 1.2, 14.0), uCenter.y + rel.y);
        vec4 mv = modelViewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float fade = 1.0 - smoothstep(tile * 0.3, tile * 0.5, length(rel));
        float nearFade = smoothstep(1.5, 6.0, -mv.z);
        vA = fade * nearFade * (0.25 + 0.5 * aRnd);
        gl_PointSize = (1.2 + aRnd * 1.8) * uPx * (14.0 / max(1.0, -mv.z));
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.85) * a * 0.8, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

// Pooled CPU particles for lantern sparkles and landing puffs.
export class Bursts {
  constructor(scene, shared, cap = 700) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.i = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: { uPx: shared.uPixelRatio },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; uniform float uPx;
        varying vec3 vC; varying float vA;
        void main() {
          vC = color; vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPx * (260.0 / max(0.5, -mv.z));
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vA;
          gl_FragColor = vec4(vC * a, 1.0);
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(p, n, { speed = 4, up = 2, color = [1, 0.8, 0.5], size = 0.12, life = 1.2, grav = -4, spread = 0.3 } = {}) {
    for (let k = 0; k < n; k++) {
      const i = this.i; this.i = (this.i + 1) % this.cap;
      const a = Math.random() * Math.PI * 2, e = (Math.random() * 2 - 1);
      const s = speed * (0.4 + Math.random() * 0.6);
      const ce = Math.sqrt(1 - e * e);
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * spread;
      this.vel[i * 3] = Math.cos(a) * ce * s;
      this.vel[i * 3 + 1] = e * s * 0.6 + up * Math.random();
      this.vel[i * 3 + 2] = Math.sin(a) * ce * s;
      const jitter = 0.85 + Math.random() * 0.3;
      this.col[i * 3] = color[0] * jitter; this.col[i * 3 + 1] = color[1] * jitter; this.col[i * 3 + 2] = color[2] * jitter;
      this.life[i] = this.max[i] = life * (0.6 + Math.random() * 0.6);
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      this.grav[i] = grav;
    }
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.max[i]);
      this.vel[i * 3 + 1] += this.grav[i] * dt;
      const drag = Math.exp(-dt * 1.6);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 1] *= drag; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = k * k;
    }
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true;
  }
}

// A loose flock of white birds wheeling over the meadow and around the city.
export class Birds {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const mat = new THREE.MeshLambertMaterial({ color: '#f7f7ff', side: THREE.DoubleSide, emissive: '#5a66c8', emissiveIntensity: 0.25 });
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.25, 0, 0, 0.2, 1.0, 0.0, 0.1], 3));
    wing.computeVertexNormals();
    const bodyG = new THREE.ConeGeometry(0.09, 0.6, 5);
    bodyG.rotateX(-Math.PI / 2);
    const r = mulberry32(77);
    this.flocks = [
      { c: new THREE.Vector3(-120, 0, -380), R: 70, h: 38, n: 9, sp: 0.16 },
      { c: new THREE.Vector3(KEEP.x - 60, 0, KEEP.z + 120), R: 220, h: 330, n: 16, sp: 0.06, scale: 5 },
      { c: new THREE.Vector3(-300, 0, -950), R: 90, h: 45, n: 7, sp: 0.13 },
    ];
    this.birds = [];
    for (const f of this.flocks) {
      f.c.y = heightAt(f.c.x, f.c.z) + f.h;
      for (let i = 0; i < f.n; i++) {
        const b = new THREE.Group();
        const body = new THREE.Mesh(bodyG, mat);
        const L = new THREE.Mesh(wing, mat); const Rw = new THREE.Mesh(wing, mat);
        Rw.scale.x = -1;
        b.add(body, L, Rw);
        b.scale.setScalar(f.scale || 1);
        this.group.add(b);
        this.birds.push({ b, L, R: Rw, f, ph: r() * Math.PI * 2, off: new THREE.Vector3((r() - 0.5) * 14, (r() - 0.5) * 8, (r() - 0.5) * 14), flap: 7 + r() * 3 });
      }
    }
  }
  update(t) {
    const prev = new THREE.Vector3();
    for (const bd of this.birds) {
      const f = bd.f;
      const a = t * f.sp + bd.ph * 0.15;
      const p = new THREE.Vector3(f.c.x + Math.cos(a) * f.R, f.c.y + Math.sin(t * 0.3 + bd.ph) * 4, f.c.z + Math.sin(a) * f.R * 0.7).add(bd.off);
      prev.set(f.c.x + Math.cos(a - 0.02) * f.R, p.y, f.c.z + Math.sin(a - 0.02) * f.R * 0.7).add(bd.off);
      prev.y = p.y;
      bd.b.position.copy(p);
      bd.b.lookAt(prev);
      const fl = Math.sin(t * bd.flap + bd.ph);
      const glide = Math.sin(t * 0.5 + bd.ph) > 0.3 ? 0.15 : 1;
      bd.L.rotation.z = fl * 0.7 * glide;
      bd.R.rotation.z = -fl * 0.7 * glide;
    }
  }
}
