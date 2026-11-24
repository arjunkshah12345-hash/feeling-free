import * as THREE from 'three';
import { GLSL_NOISE, fbm2, mulberry32 } from './noise.js';
import { heightAt } from './world.js';

export const SKY = {
  zenith: new THREE.Color('#0f2bb8'),
  mid: new THREE.Color('#2a5ce8'),
  horizon: new THREE.Color('#a9c6f4'),
  haze: new THREE.Color('#c9dcf7'),
  fog: new THREE.Color('#b4cbf2'),
};

export function buildSky(shared, sunDir) {
  const geo = new THREE.SphereGeometry(9000, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: SKY.zenith },
      uMid: { value: SKY.mid },
      uHorizon: { value: SKY.horizon },
      uHaze: { value: SKY.haze },
      uSun: { value: sunDir },
      uTime: shared.uTime,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uMid, uHorizon, uHaze, uSun;
      uniform float uTime;
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.2, e));
        col = mix(col, uZenith, smoothstep(0.14, 0.7, e));
        col = mix(uHaze, col, smoothstep(-0.02, 0.045, e));
        float s = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.93, 0.8) * (pow(s, 6.0) * 0.12 + pow(s, 60.0) * 0.35);
        // long low wisps of cloud near the horizon
        vec2 p = d.xz / max(e + 0.06, 0.02);
        p = vec2(p.x * 0.35 + p.y * 0.12, p.y * 1.6 - p.x * 0.1);
        float c = fbm5(p * 0.9 + vec2(uTime * 0.004, 0.0));
        float band = smoothstep(0.004, 0.035, e) * (1.0 - smoothstep(0.06, 0.2, e));
        float cl = smoothstep(0.56, 0.82, c) * band;
        col = mix(col, vec3(1.0, 0.99, 1.0) * 1.05, cl * 0.85);
        // a few high streaks
        vec2 q = d.xz / max(e, 0.05);
        float hi = smoothstep(0.62, 0.9, fbm3(vec2(q.x * 0.25, q.y * 2.2) + 11.0)) * smoothstep(0.08, 0.2, e) * (1.0 - smoothstep(0.3, 0.6, e));
        col = mix(col, uHorizon * 1.15, hi * 0.35);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}

// Pale blue mountain range on the far left horizon with snowy tops.
export function buildMountains() {
  const group = new THREE.Group();
  const segs = 220, rows = 6;
  const cx = -300, cz = -900, R = 5200;
  const pos = [], col = [], idx = [];
  const base = new THREE.Color('#8ea7e6'), top = new THREE.Color('#eef3ff'), deep = new THREE.Color('#6c86d6');
  const a0 = Math.PI * 0.55, a1 = Math.PI * 1.42;
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (a1 - a0) * (i / segs);
    const ridge = Math.max(0, fbm2(i * 0.045, 3.1, 5) * 1.25 + 0.35);
    const peak = 120 + 520 * ridge * ridge + 140 * Math.max(0, Math.sin(i * 0.11));
    const fadeEnds = Math.sin(((i / segs) * Math.PI));
    const H = peak * (0.35 + 0.65 * fadeEnds);
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const rr = R - t * 220;
      const y = -40 + H * Math.pow(t, 0.85);
      pos.push(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr);
      const c = deep.clone().lerp(base, Math.min(1, t * 1.4));
      if (t > 0.72 && H > 420) c.lerp(top, smoothstep(0.72, 1.0, t) * Math.min(1, (H - 420) / 160));
      col.push(c.r, c.g, c.b);
    }
  }
  const w = rows + 1;
  for (let i = 0; i < segs; i++) {
    for (let r = 0; r < rows; r++) {
      const a = i * w + r, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
  m.name = 'mountains';
  group.add(m);
  return group;
}

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// Clumps of rounded trees marking the far edge of the meadow.
export function buildTrees() {
  const r = mulberry32(99);
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 6);
  const mat = new THREE.MeshLambertMaterial({ color: '#2d6b2a' });
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#4a3a5a' });
  const N = 420;
  const crowns = new THREE.InstancedMesh(geo, mat, N);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  let n = 0;
  const clusters = [];
  for (let i = 0; i < 34; i++) clusters.push({ x: -760 - r() * 900, z: 300 - r() * 1900 });
  for (let i = 0; i < 10; i++) clusters.push({ x: -500 + r() * 400, z: 560 + r() * 500 });
  for (const cl of clusters) {
    const k = 6 + Math.floor(r() * 10);
    for (let j = 0; j < k && n < N; j++) {
      const x = cl.x + (r() - 0.5) * 60, z = cl.z + (r() - 0.5) * 60;
      const y = heightAt(x, z);
      const h = 7 + r() * 9;
      const rad = 3 + r() * 3.2;
      p.set(x, y + h * 0.55, z);
      s.set(rad, h * 0.5, rad);
      m.compose(p, q, s);
      crowns.setMatrixAt(n, m);
      c.setHSL(0.27 + r() * 0.06, 0.55, 0.22 + r() * 0.1);
      crowns.setColorAt(n, c);
      p.set(x, y + h * 0.15, z);
      s.set(1, h * 0.35, 1);
      m.compose(p, q, s);
      trunks.setMatrixAt(n, m);
      n++;
    }
  }
  crowns.count = n; trunks.count = n;
  crowns.castShadow = true;
  const g = new THREE.Group();
  g.add(crowns, trunks);
  return g;
}
