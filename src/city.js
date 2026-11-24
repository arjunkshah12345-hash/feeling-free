import * as THREE from 'three';
import { mulberry32, fbm2 } from './noise.js';
import { KEEP, CITY_R as CITY_R_WORLD, CITY_SCALE, cliffX as cliffXW, heightAt as heightAtW, smoothstep, clamp } from './world.js';

// The city is laid out in a local frame at its original size and the group is scaled
// about the keep, so these wrappers map local coordinates to the world and back.
const CITY_R = CITY_R_WORLD / CITY_SCALE;
const toW = (v, c) => c + (v - c) * CITY_SCALE;
const heightAt = (x, z) => heightAtW(toW(x, KEEP.x), toW(z, KEEP.z)) / CITY_SCALE;
const cliffX = (z) => (cliffXW(toW(z, KEEP.z)) - KEEP.x) / CITY_SCALE + KEEP.x;

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

function windowTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  const cell = S / 4;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const x0 = i * cell, y0 = j * cell;
      // cornice line
      g.fillStyle = '#e3e5f7';
      g.fillRect(x0, y0 + 4, cell, 3);
      // tall arched window
      const w = 16, h = 30, cx = x0 + cell / 2, top = y0 + 18;
      g.fillStyle = '#9aa2d8';
      g.beginPath();
      g.moveTo(cx - w / 2, top + h);
      g.lineTo(cx - w / 2, top + w / 2);
      g.arc(cx, top + w / 2, w / 2, Math.PI, 0);
      g.lineTo(cx + w / 2, top + h);
      g.closePath();
      g.fill();
      g.fillStyle = '#7480c6';
      g.fillRect(cx - w / 2 + 3, top + w / 2 + 2, w - 6, h - w / 2 - 4);
      // sill
      g.fillStyle = '#d9dcf3';
      g.fillRect(cx - w / 2 - 3, top + h, w + 6, 3);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function ashlarTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#dcdcf2';
  g.fillRect(0, 0, S, S);
  const r = mulberry32(8);
  const rows = 8, rh = S / rows;
  for (let row = 0; row < rows; row++) {
    let x = row % 2 ? -rh : 0;
    while (x < S) {
      const w = rh * (1.6 + r() * 1.2);
      const L = 92 + r() * 6;
      g.fillStyle = `hsl(240, 30%, ${L}%)`;
      g.fillRect(x + 1.5, row * rh + 1.5, w - 3, rh - 3);
      x += w;
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function scaleUV(geo, su, sv) {
  const uv = geo.getAttribute('uv');
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

// Collects static parts and merges them into one mesh per material, baking a soft vertical AO.
class Batch {
  constructor() { this.items = []; }
  add(geo, pos, { rotY = 0, scale = ONE, ao = 0.72, span = 0.45 } = {}) {
    const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(UP, rotY), scale);
    this.items.push({ geo, m, ao, span });
  }
  build(mat) {
    const geos = this.items.map(({ geo, m, ao, span }) => {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      g.computeBoundingBox();
      const { min, max } = g.boundingBox;
      const hgt = Math.max(1e-3, max.y - min.y);
      const p = g.getAttribute('position');
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const t = smoothstep(min.y, min.y + hgt * span, p.getY(i));
        const v = ao + (1 - ao) * t;
        col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.applyMatrix4(m);
      return g;
    });
    let total = 0;
    for (const g of geos) total += g.getAttribute('position').count;
    const P = new Float32Array(total * 3), N = new Float32Array(total * 3), U = new Float32Array(total * 2), C = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) {
      const n = g.getAttribute('position').count;
      P.set(g.getAttribute('position').array, o * 3);
      N.set(g.getAttribute('normal').array, o * 3);
      C.set(g.getAttribute('color').array, o * 3);
      const uv = g.getAttribute('uv');
      if (uv) U.set(uv.array, o * 2);
      o += n;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(P, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    out.setAttribute('color', new THREE.BufferAttribute(C, 3));
    out.computeBoundingSphere();
    return new THREE.Mesh(out, mat);
  }
}

function archShape(W, H, aw, ab, ar) {
  // W x H block with an arched opening of width aw, starting at height ab, straight part ar, round top
  const s = new THREE.Shape();
  s.moveTo(-W / 2, 0);
  s.lineTo(W / 2, 0);
  s.lineTo(W / 2, H);
  s.lineTo(-W / 2, H);
  s.lineTo(-W / 2, 0);
  const h = new THREE.Path();
  h.moveTo(-aw / 2, ab);
  h.lineTo(-aw / 2, ab + ar);
  h.absarc(0, ab + ar, aw / 2, Math.PI, 0, true);
  h.lineTo(aw / 2, ab);
  h.lineTo(-aw / 2, ab);
  s.holes.push(h);
  return s;
}

function instancedMaterial(map, mode) {
  const mat = new THREE.MeshStandardMaterial({ map, color: '#dedcf0', roughness: 0.86, metalness: 0, emissive: '#4f5fd6', emissiveIntensity: 0.3 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vAO;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_INSTANCING
vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
${mode === 'box'
  ? 'vec2 fs = abs(normal.y) > 0.5 ? vec2(0.0) : (abs(normal.x) > 0.5 ? vec2(isc.z, isc.y) : vec2(isc.x, isc.y));\nvMapUv = uv * fs / 24.0 + vec2(0.012);'
  : 'vMapUv = abs(normal.y) > 0.5 ? vec2(0.012) : uv * vec2(6.2832 * isc.x, isc.y) / 24.0;'}
vAO = mix(0.5, 1.0, smoothstep(-0.5, 0.3, position.y));
#else
vAO = 1.0;
#endif`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAO;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vAO;');
  };
  mat.customProgramCacheKey = () => 'city-inst-' + mode;
  return mat;
}

export function moundHeight(x, z) {
  const d = Math.hypot(x - KEEP.x, z - KEEP.z);
  const t = clamp(1 - d / CITY_R, 0, 1);
  let h = 300 * Math.pow(t, 0.95) + fbm2(x * 0.012, z * 0.012, 3) * 14 * t;
  const step = 20;
  const q = Math.floor(h / step) * step;
  h = q + (h - q) * 0.3;
  return heightAt(x, z) + Math.max(0, h);
}

export function buildCity() {
  const group = new THREE.Group();
  group.name = 'city';
  const win = windowTexture();
  const ash = ashlarTexture();
  const K = KEEP;
  const rnd = mulberry32(42);

  const lav = { emissive: new THREE.Color('#4f5fd6'), emissiveIntensity: 0.32 };
  const whiteMat = new THREE.MeshStandardMaterial({ map: win, color: '#dedcf0', roughness: 0.86, vertexColors: true, ...lav });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#e4e2f4', roughness: 0.7, vertexColors: true, ...lav });
  const stoneMat = new THREE.MeshStandardMaterial({ map: ash, color: '#e2e0f2', roughness: 0.9, vertexColors: true, ...lav });
  const W = new Batch(), R = new Batch(), S = new Batch();

  // ---- mound -------------------------------------------------------------
  {
    const rings = 70, segs = 180;
    const pos = [], col = [], idx = [];
    for (let r = 0; r <= rings; r++) {
      const d = (r / rings) * (CITY_R + 6);
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const x = K.x + Math.sin(a) * d, z = K.z + Math.cos(a) * d;
        const xx = Math.min(x, cliffX(z) + 30);
        const y = moundHeight(xx, z) - (r === rings ? 6 : 0);
        pos.push(xx, y, z);
        const v = 0.78 + 0.18 * fbm2(x * 0.05, z * 0.05, 2) + 0.1;
        col.push(v * 0.92, v * 0.92, v);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = r * (segs + 1) + s, b = a + 1, c = a + segs + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#e6e4f6', roughness: 1, vertexColors: true, emissive: '#4a55b8', emissiveIntensity: 0.4 }));
    group.add(m);
  }

  const inCliff = (x, z, pad = 10) => x > cliffX(z) - pad;
  const reserved = [];
  const reserve = (x, z, r) => reserved.push({ x, z, r });
  const reserveRect = (x, z, hx, hz) => reserved.push({ x, z, hx, hz });
  const isReserved = (x, z, pad = 0) =>
    reserved.some((q) => (q.hx ? Math.abs(x - q.x) < q.hx + pad && Math.abs(z - q.z) < q.hz + pad : Math.hypot(x - q.x, z - q.z) < q.r + pad));

  // ---- the keep with the great arch ---------------------------------------
  const keepBase = moundHeight(K.x, K.z) - 40;
  {
    const Wd = 380, H = 640, depth = 110;
    const AW = 180, AB = 270, AR = 220; // opening width, sill height, straight run
    const shape = archShape(Wd, H, AW, AB, AR);
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 48 });
    geo.translate(0, 0, -depth / 2);
    scaleUV(geo, 1 / 24, 1 / 24);
    W.add(geo, new THREE.Vector3(K.x, keepBase, K.z), { ao: 0.55, span: 0.3 });
    reserveRect(K.x, K.z, 250, 64);
    const front = K.z + depth / 2;
    // archivolts: concentric rings framing the opening
    for (let k = 0; k < 4; k++) {
      const rr = AW / 2 + 5 + k * 8;
      const tor = new THREE.TorusGeometry(rr, 3.2 - k * 0.5, 8, 56, Math.PI);
      R.add(tor, new THREE.Vector3(K.x, keepBase + AB + AR, front + 1.5 + k * 1.2), { ao: 1 });
      for (const sgn of [-1, 1]) {
        const col = new THREE.BoxGeometry(6 - k, AR, 5);
        R.add(col, new THREE.Vector3(K.x + sgn * rr, keepBase + AB + AR / 2, front + 1.5 + k * 1.2), { ao: 0.85 });
      }
    }
    // a band of tall windows above the arch and a rose medallion
    R.add(new THREE.TorusGeometry(26, 3, 8, 40), new THREE.Vector3(K.x, keepBase + AB + AR + AW / 2 + 70, front + 2), { ao: 1 });
    R.add(new THREE.TorusGeometry(14, 2, 8, 32), new THREE.Vector3(K.x, keepBase + AB + AR + AW / 2 + 70, front + 2.5), { ao: 1 });
    // pilasters across the face, skipping the opening
    const pil = scaleUV(new THREE.BoxGeometry(6, H, 6), 6 / 24, H / 24);
    for (let x = -Wd / 2 + 7; x <= Wd / 2 - 7; x += 16) {
      if (Math.abs(x) < AW / 2 + 30) {
        const lower = scaleUV(new THREE.BoxGeometry(6, AB, 6), 6 / 24, AB / 24);
        W.add(lower, new THREE.Vector3(K.x + x, keepBase + AB / 2, front + 2.5), { ao: 0.6 });
        const top = H - (AB + AR + AW / 2 + 110);
        if (top > 10) {
          const upper = scaleUV(new THREE.BoxGeometry(6, top, 6), 6 / 24, top / 24);
          W.add(upper, new THREE.Vector3(K.x + x, keepBase + H - top / 2, front + 2.5), { ao: 0.9 });
        }
        continue;
      }
      W.add(pil, new THREE.Vector3(K.x + x, keepBase + H / 2, front + 2.5), { ao: 0.55 });
    }
    // horizontal string courses
    for (const y of [AB - 4, AB + AR + AW / 2 + 30, H - 60]) {
      const band = scaleUV(new THREE.BoxGeometry(Wd + 6, 5, 6), (Wd + 6) / 24, 0.2);
      if (y === AB - 4) {
        for (const sgn of [-1, 1]) {
          const w = (Wd - AW) / 2;
          R.add(new THREE.BoxGeometry(w + 3, 5, 7), new THREE.Vector3(K.x + sgn * (AW / 2 + w / 2), keepBase + y, front + 3), { ao: 1 });
        }
      } else {
        W.add(band, new THREE.Vector3(K.x, keepBase + y, front + 3), { ao: 1 });
      }
    }
    // crown of organ-pipe ribs and pinnacles along the top
    for (let x = -Wd / 2 + 4; x <= Wd / 2 - 4; x += 8) {
      const h = 46 + 34 * Math.pow(Math.cos((x / Wd) * Math.PI), 2) + rnd() * 8;
      const rib = scaleUV(new THREE.BoxGeometry(5, h, 5), 5 / 24, h / 24);
      W.add(rib, new THREE.Vector3(K.x + x, keepBase + H + h / 2, front - 5), { ao: 0.85 });
      R.add(new THREE.ConeGeometry(3.2, 12, 6), new THREE.Vector3(K.x + x, keepBase + H + h + 6, front - 5));
    }
    const parapet = scaleUV(new THREE.BoxGeometry(Wd + 10, 12, depth + 10), (Wd + 10) / 24, 12 / 24);
    W.add(parapet, new THREE.Vector3(K.x, keepBase + H + 6, K.z), { ao: 0.9 });
    // flanking towers
    for (const sgn of [-1, 1]) {
      const tw = 60, th = H + 90;
      const tx = K.x + sgn * (Wd / 2 + tw / 2 - 8);
      const tg = scaleUV(new THREE.BoxGeometry(tw, th, tw), tw / 24, th / 24);
      W.add(tg, new THREE.Vector3(tx, keepBase + th / 2, K.z + 10), { ao: 0.55, span: 0.3 });
      for (const cx of [-1, 1]) {
        const b = scaleUV(new THREE.BoxGeometry(8, th, 8), 0.3, th / 24);
        W.add(b, new THREE.Vector3(tx + cx * tw * 0.5, keepBase + th / 2, K.z + 10 + tw * 0.5), { ao: 0.55, span: 0.3 });
      }
      const oct = scaleUV(new THREE.CylinderGeometry(tw * 0.42, tw * 0.46, 54, 8), 7, 54 / 24);
      W.add(oct, new THREE.Vector3(tx, keepBase + th + 27, K.z + 10));
      R.add(new THREE.ConeGeometry(tw * 0.42, 170, 8), new THREE.Vector3(tx, keepBase + th + 54 + 85, K.z + 10));
      for (const cx of [-1, 1]) for (const cz of [-1, 1]) {
        R.add(new THREE.ConeGeometry(4.2, 40, 6), new THREE.Vector3(tx + cx * tw * 0.45, keepBase + th + 20, K.z + 10 + cz * tw * 0.45));
      }
    }
  }

  // ---- lower arch bridge in front of the keep ------------------------------
  {
    const lz = K.z + 200;
    const base = moundHeight(K.x, lz) - 14;
    const shape = archShape(250, 200, 92, 34, 84);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 54, bevelEnabled: false, curveSegments: 32 });
    geo.translate(0, 0, -27);
    scaleUV(geo, 1 / 24, 1 / 24);
    W.add(geo, new THREE.Vector3(K.x + 14, base, lz), { ao: 0.55, span: 0.3 });
    R.add(new THREE.TorusGeometry(50, 3, 8, 44, Math.PI), new THREE.Vector3(K.x + 14, base + 34 + 84, lz + 28));
    R.add(new THREE.TorusGeometry(57, 2.2, 8, 44, Math.PI), new THREE.Vector3(K.x + 14, base + 34 + 84, lz + 28.5));
    reserveRect(K.x + 14, lz, 128, 32);
    for (let x = -116; x <= 116; x += 12) {
      R.add(new THREE.ConeGeometry(2.8, 14, 6), new THREE.Vector3(K.x + 14 + x, base + 207, lz + 22));
    }
  }

  // ---- great drum tower with a dome ----------------------------------------
  const drum = (x, z, r, h, opts = {}) => {
    const base = moundHeight(x, z) - 10;
    const body = scaleUV(new THREE.CylinderGeometry(r, r * 1.06, h, 40), (Math.PI * 2 * r) / 24, h / 24);
    W.add(body, new THREE.Vector3(x, base + h / 2, z), { ao: 0.6, span: 0.35 });
    const ribs = Math.round((Math.PI * 2 * r) / 9);
    for (let k = 0; k < ribs; k++) {
      const a = (k / ribs) * Math.PI * 2;
      const rib = scaleUV(new THREE.BoxGeometry(2.4, h, 2.4), 0.1, h / 24);
      W.add(rib, new THREE.Vector3(x + Math.cos(a) * (r + 0.6), base + h / 2, z + Math.sin(a) * (r + 0.6)), { rotY: -a, ao: 0.6, span: 0.35 });
    }
    const corb = new THREE.CylinderGeometry(r * 1.14, r, r * 0.22, 40);
    R.add(corb, new THREE.Vector3(x, base + h + r * 0.11, z), { ao: 0.75 });
    const ring = scaleUV(new THREE.CylinderGeometry(r * 1.14, r * 1.14, r * 0.25, 40), (Math.PI * 2 * r) / 24, 0.5);
    W.add(ring, new THREE.Vector3(x, base + h + r * 0.34, z), { ao: 0.9 });
    const nM = Math.round((Math.PI * 2 * r * 1.14) / 5);
    for (let k = 0; k < nM; k++) {
      const a = (k / nM) * Math.PI * 2;
      R.add(new THREE.BoxGeometry(2.6, r * 0.16, 2), new THREE.Vector3(x + Math.cos(a) * r * 1.12, base + h + r * 0.54, z + Math.sin(a) * r * 1.12), { rotY: -a, ao: 1 });
    }
    let top = base + h + r * 0.46;
    if (opts.inner !== false) {
      const ih = r * 0.7;
      const inner = scaleUV(new THREE.CylinderGeometry(r * 0.82, r * 0.82, ih, 36), (Math.PI * 2 * r) / 24, ih / 24);
      W.add(inner, new THREE.Vector3(x, top + ih / 2, z), { ao: 0.8 });
      top += ih;
    }
    const dome = new THREE.SphereGeometry(r * 0.84, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    R.add(dome, new THREE.Vector3(x, top, z), { scale: new THREE.Vector3(1, opts.domeH ?? 0.95, 1), ao: 0.9 });
    if (opts.lantern) {
      R.add(new THREE.CylinderGeometry(r * 0.12, r * 0.12, r * 0.3, 10), new THREE.Vector3(x, top + r * 0.84 * (opts.domeH ?? 0.95) + r * 0.15, z));
      R.add(new THREE.ConeGeometry(r * 0.13, r * 0.6, 10), new THREE.Vector3(x, top + r * 0.84 * (opts.domeH ?? 0.95) + r * 0.6, z));
    }
    reserve(x, z, r + 6);
  };
  drum(K.x - 228, K.z + 70, 50, 330, { lantern: true });
  drum(K.x + 235, K.z + 140, 26, 190, { lantern: true, domeH: 1.2 });
  drum(K.x - 350, K.z + 185, 21, 140, { lantern: true, domeH: 1.25 });
  drum(K.x + 80, K.z + 300, 22, 110, { lantern: true, domeH: 1.1 });
  drum(K.x - 130, K.z + 285, 18, 125, { lantern: true, domeH: 1.2 });
  drum(K.x - 260, K.z + 330, 14, 70, { lantern: true, domeH: 1.3 });
  drum(K.x + 170, K.z + 340, 13, 60, { lantern: true, domeH: 1.3 });

  // ---- spires ---------------------------------------------------------------
  const spire = (x, z, H, w) => {
    let y = moundHeight(x, z) - 8;
    const h1 = H * 0.42;
    const shaft = scaleUV(new THREE.BoxGeometry(w, h1, w), w / 24, h1 / 24);
    W.add(shaft, new THREE.Vector3(x, y + h1 / 2, z), { ao: 0.6, span: 0.35 });
    for (const cx of [-1, 1]) for (const cz of [-1, 1]) {
      const b = scaleUV(new THREE.BoxGeometry(w * 0.18, h1, w * 0.18), 0.2, h1 / 24);
      W.add(b, new THREE.Vector3(x + cx * w * 0.5, y + h1 / 2, z + cz * w * 0.5), { ao: 0.6, span: 0.35 });
    }
    y += h1;
    S.add(new THREE.BoxGeometry(w * 1.16, w * 0.1, w * 1.16), new THREE.Vector3(x, y + w * 0.05, z), { ao: 0.85 });
    y += w * 0.1;
    for (const cx of [-1, 1]) for (const cz of [-1, 1]) {
      R.add(new THREE.ConeGeometry(w * 0.09, H * 0.1, 6), new THREE.Vector3(x + cx * w * 0.48, y + H * 0.05, z + cz * w * 0.48));
    }
    const h2 = H * 0.13;
    const oct = scaleUV(new THREE.CylinderGeometry(w * 0.4, w * 0.42, h2, 8), 3, h2 / 24);
    W.add(oct, new THREE.Vector3(x, y + h2 / 2, z), { ao: 0.75 });
    y += h2;
    S.add(new THREE.CylinderGeometry(w * 0.48, w * 0.46, w * 0.08, 8), new THREE.Vector3(x, y + w * 0.04, z));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      R.add(new THREE.ConeGeometry(w * 0.05, H * 0.06, 5), new THREE.Vector3(x + Math.cos(a) * w * 0.42, y + H * 0.03, z + Math.sin(a) * w * 0.42));
    }
    const h3 = H * 0.07;
    const oct2 = scaleUV(new THREE.CylinderGeometry(w * 0.3, w * 0.32, h3, 8), 2, h3 / 24);
    W.add(oct2, new THREE.Vector3(x, y + h3 / 2, z), { ao: 0.85 });
    y += h3;
    R.add(new THREE.ConeGeometry(w * 0.3, H * 0.36, 8), new THREE.Vector3(x, y + H * 0.18, z), { ao: 0.92 });
    R.add(new THREE.SphereGeometry(w * 0.05, 8, 6), new THREE.Vector3(x, y + H * 0.36, z));
    reserve(x, z, w * 0.8);
  };
  spire(K.x - 330, K.z + 50, 700, 42);
  spire(K.x - 275, K.z + 205, 460, 30);
  spire(K.x + 215, K.z + 50, 500, 32);
  spire(K.x + 25, K.z - 300, 600, 38);
  spire(K.x - 420, K.z + 265, 300, 22);
  spire(K.x + 150, K.z + 265, 280, 20);
  spire(K.x - 70, K.z + 370, 190, 15);
  spire(K.x - 180, K.z - 150, 420, 28);
  spire(K.x - 440, K.z + 60, 260, 20);
  spire(K.x + 300, K.z + 230, 220, 17);

  // ---- ring wall and the gate ----------------------------------------------
  const gateInfo = {};
  {
    const Rw = CITY_R;
    const wallH = 26, half = 3.2;
    const segs = [];
    for (let a = -1.9; a <= 1.4; a += 0.006) {
      const x = K.x + Math.sin(a) * Rw, z = K.z + Math.cos(a) * Rw;
      if (inCliff(x, z, -4)) break;
      segs.push({ a, x, z });
    }
    const pts = segs.filter((p) => Math.abs(p.a) > 0.034);
    // build as runs of boxes
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      if (Math.abs(q.a - p.a) > 0.01) continue;
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      const len = Math.hypot(q.x - p.x, q.z - p.z) + 0.15;
      const base = Math.min(heightAt(p.x, p.z), heightAt(q.x, q.z)) - 4;
      const g = scaleUV(new THREE.BoxGeometry(len, wallH + 4, half * 2), len / 8, (wallH + 4) / 8);
      const yaw = Math.atan2(q.x - p.x, q.z - p.z) - Math.PI / 2;
      S.add(g, new THREE.Vector3(mx, base + (wallH + 4) / 2, mz), { rotY: yaw, ao: 0.75, span: 0.4 });
      if (i % 2 === 0) {
        const mer = scaleUV(new THREE.BoxGeometry(1.6, 2.2, 1.2), 0.2, 0.3);
        const ox = Math.sin(p.a) * (half - 0.6), oz = Math.cos(p.a) * (half - 0.6);
        S.add(mer, new THREE.Vector3(mx + ox, base + wallH + 4 + 1.1, mz + oz), { rotY: yaw, ao: 1 });
      }
    }
    // towers along the ring
    for (let a = -1.85; a < 1.4; a += 0.13) {
      if (Math.abs(a) < 0.1) continue;
      const x = K.x + Math.sin(a) * (Rw + 2), z = K.z + Math.cos(a) * (Rw + 2);
      if (inCliff(x, z, 2)) break;
      const base = heightAt(x, z) - 4;
      const r = 7, h = wallH + 16;
      S.add(scaleUV(new THREE.CylinderGeometry(r, r * 1.05, h, 24), (Math.PI * 2 * r) / 8, h / 8), new THREE.Vector3(x, base + h / 2, z), { ao: 0.75, span: 0.4 });
      R.add(new THREE.SphereGeometry(r * 0.98, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.Vector3(x, base + h, z), { scale: new THREE.Vector3(1, 1.3, 1) });
      R.add(new THREE.ConeGeometry(0.7, 6, 6), new THREE.Vector3(x, base + h + r * 1.3 + 2.6, z));
    }
    // gatehouse
    const gx = K.x, gz = K.z + Rw;
    const gb = heightAt(gx, gz) - 2;
    const gshape = archShape(40, 40, 15, 2, 13);
    const gg = new THREE.ExtrudeGeometry(gshape, { depth: 12, bevelEnabled: false, curveSegments: 24 });
    gg.translate(0, 0, -6);
    scaleUV(gg, 1 / 8, 1 / 8);
    S.add(gg, new THREE.Vector3(gx, gb, gz), { ao: 0.7, span: 0.4 });
    R.add(new THREE.TorusGeometry(8.6, 0.9, 8, 28, Math.PI), new THREE.Vector3(gx, gb + 15, gz + 6.4));
    for (let x = -18; x <= 18; x += 3) {
      S.add(new THREE.BoxGeometry(1.6, 2.4, 1.4), new THREE.Vector3(gx + x, gb + 41.2, gz + 5.4), { ao: 1 });
    }
    // tunnel into the light
    for (const sgn of [-1, 1]) {
      S.add(scaleUV(new THREE.BoxGeometry(2, 18, 40), 5, 2.2), new THREE.Vector3(gx + sgn * 8.5, gb + 9, gz - 24), { ao: 0.6 });
    }
    S.add(new THREE.BoxGeometry(19, 3, 40), new THREE.Vector3(gx, gb + 18.5, gz - 24), { ao: 0.6 });
    for (const sgn of [-1, 1]) {
      const tx = gx + sgn * 27, tz = gz + 2;
      const r = 10, h = 58;
      S.add(scaleUV(new THREE.CylinderGeometry(r, r * 1.06, h, 28), (Math.PI * 2 * r) / 8, h / 8), new THREE.Vector3(tx, gb + h / 2 - 3, tz), { ao: 0.7, span: 0.4 });
      R.add(new THREE.CylinderGeometry(r * 1.15, r, 2.5, 28), new THREE.Vector3(tx, gb + h - 1.75, tz));
      R.add(new THREE.SphereGeometry(r * 1.05, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.Vector3(tx, gb + h - 0.5, tz), { scale: new THREE.Vector3(1, 1.45, 1) });
      R.add(new THREE.ConeGeometry(0.9, 12, 8), new THREE.Vector3(tx, gb + h + r * 1.5 + 5, tz));
      gateInfo['flag' + sgn] = new THREE.Vector3(tx, gb + h + r * 1.5 + 9, tz);
    }
    gateInfo.base = gb;
    gateInfo.x = gx;
    gateInfo.z = gz;
    reserve(gx, gz - 10, 40);
  }

  // ---- terraced inner ring walls, stepping up toward the keep --------------
  for (const [rr, hh] of [[430, 20], [340, 24], [250, 26], [165, 26]]) {
    const step = 4 / rr;
    let prev = null;
    for (let a = -Math.PI; a <= Math.PI + 1e-6; a += step) {
      const x = K.x + Math.sin(a) * rr, z = K.z + Math.cos(a) * rr;
      if (inCliff(x, z, 4) || isReserved(x, z, 2)) { prev = null; continue; }
      const top = moundHeight(K.x + Math.sin(a) * (rr - 6), K.z + Math.cos(a) * (rr - 6)) + 8;
      const base = moundHeight(K.x + Math.sin(a) * (rr + 8), K.z + Math.cos(a) * (rr + 8)) - 6;
      if (prev) {
        const len = Math.hypot(x - prev.x, z - prev.z) + 0.3;
        const H = Math.max(hh, top - base);
        const g = scaleUV(new THREE.BoxGeometry(len, H, 5), len / 8, H / 8);
        const yaw = Math.atan2(x - prev.x, z - prev.z) - Math.PI / 2;
        S.add(g, new THREE.Vector3((x + prev.x) / 2, base + H / 2, (z + prev.z) / 2), { rotY: yaw, ao: 0.6, span: 0.5 });
        S.add(new THREE.BoxGeometry(1.8, 2.4, 1.2), new THREE.Vector3((x + prev.x) / 2 + Math.sin(a) * 2, base + H + 1.2, (z + prev.z) / 2 + Math.cos(a) * 2), { rotY: yaw, ao: 1 });
      }
      prev = { x, z };
      if (Math.abs(((a * rr) / 70) % 1) < (step * rr) / 70 && rnd() < 0.8) {
        const tr = 6 + rnd() * 3, th = top - base + 14;
        S.add(scaleUV(new THREE.CylinderGeometry(tr, tr * 1.05, th, 20), (Math.PI * 2 * tr) / 8, th / 8), new THREE.Vector3(x, base + th / 2, z), { ao: 0.6, span: 0.5 });
        R.add(new THREE.SphereGeometry(tr, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.Vector3(x, base + th, z), { scale: new THREE.Vector3(1, 1.25, 1) });
      }
    }
  }

  // ---- the crowd of houses, domes and towers ---------------------------------
  const N = 4600;
  const boxes = [], domes = [], cones = [], drums = [], towers = [], needles = [];
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const d = CITY_R * Math.sqrt(rnd()) * 0.985;
    const x = K.x + Math.sin(a) * d, z = K.z + Math.cos(a) * d;
    if (d > CITY_R - 14) continue;
    if (inCliff(x, z, 6)) continue;
    if (isReserved(x, z, 4)) continue;
    const base = moundHeight(x, z);
    const c = 1 - d / CITY_R;
    const w = 7 + rnd() * 13 + c * 9, dp = 7 + rnd() * 13 + c * 9;
    const h = 10 + rnd() * 18 + c * 36 * rnd();
    const yaw = Math.atan2(x - K.x, z - K.z) + (rnd() - 0.5) * 0.35;
    boxes.push({ x, y: base + h / 2 - 5, z, sx: w, sy: h + 10, sz: dp, yaw });
    const top = base + h;
    const roll = rnd();
    if (roll < 0.4) {
      const rr = Math.min(w, dp) * 0.42;
      let dy = top;
      if (rnd() < 0.55) {
        drums.push({ x, y: top + rr * 0.3, z, sx: rr * 0.95, sy: rr * 0.6, sz: rr * 0.95 });
        dy += rr * 0.6;
      }
      domes.push({ x, y: dy, z, sx: rr, sy: rr * (0.9 + rnd() * 0.5), sz: rr });
    } else if (roll < 0.6) {
      const rr = Math.max(w, dp) * 0.62;
      cones.push({ x, y: top + rr * 0.35, z, sx: rr, sy: rr * 0.7, sz: rr, yaw: yaw + Math.PI / 4, square: true });
    }
    if (rnd() < 0.07) {
      const tr = 2.4 + rnd() * 3.2;
      const th = 18 + rnd() * 40 + c * 40;
      const tx = x + (rnd() - 0.5) * w * 0.5, tz = z + (rnd() - 0.5) * dp * 0.5;
      towers.push({ x: tx, y: base + th / 2, z: tz, sx: tr, sy: th, sz: tr });
      if (rnd() < 0.6) needles.push({ x: tx, y: base + th + tr * 2, z: tz, sx: tr * 1.1, sy: tr * 4, sz: tr * 1.1 });
      else domes.push({ x: tx, y: base + th, z: tz, sx: tr * 1.05, sy: tr * 1.4, sz: tr * 1.05 });
    }
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color();
  const fill = (geo, mat, list, tint = true) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((b, i) => {
      q.setFromAxisAngle(UP, b.yaw || 0);
      m4.compose(p.set(b.x, b.y, b.z), q, s.set(b.sx, b.sy, b.sz));
      im.setMatrixAt(i, m4);
      if (tint) {
        const v = 0.9 + rnd() * 0.1;
        col.setRGB(v, v * (0.97 + rnd() * 0.03), v * (0.98 + rnd() * 0.02));
        im.setColorAt(i, col);
      }
    });
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    return im;
  };
  const boxMat = instancedMaterial(win, 'box');
  const cylMat = instancedMaterial(win, 'cyl');
  const domeMat = new THREE.MeshStandardMaterial({ color: '#e6e4f6', roughness: 0.65, emissive: '#4f5fd6', emissiveIntensity: 0.3 });
  fill(new THREE.BoxGeometry(1, 1, 1), boxMat, boxes);
  fill(new THREE.CylinderGeometry(1, 1, 1, 16), cylMat, drums);
  fill(new THREE.CylinderGeometry(1, 1.04, 1, 14), cylMat, towers);
  fill(new THREE.SphereGeometry(1, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), domeMat, domes);
  fill(new THREE.ConeGeometry(1, 1, 4), domeMat, cones);
  fill(new THREE.ConeGeometry(1, 1, 10), domeMat, needles);

  group.add(W.build(whiteMat));
  group.add(R.build(roofMat));
  group.add(S.build(stoneMat));

  // glow inside the gate tunnel
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.2, 1.9), fog: false });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(17, 17), glowMat);
  glow.position.set(gateInfo.x, gateInfo.base + 8.5, gateInfo.z - 42);
  group.add(glow);

  // banners on the gate towers
  const flags = [];
  const flagGeo = new THREE.PlaneGeometry(9, 3.2, 16, 4);
  flagGeo.translate(4.5, 0, 0);
  const flagMat = new THREE.MeshStandardMaterial({ color: '#ff5a1f', roughness: 0.8, side: THREE.DoubleSide });
  flagMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = flagUniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = position;
float k = position.x / 9.0;
transformed.z += sin(position.x * 0.9 - uTime * 7.0) * 0.55 * k + sin(position.x * 2.1 - uTime * 11.0) * 0.15 * k;
transformed.y += sin(position.x * 0.6 - uTime * 5.0) * 0.25 * k - k * 0.6;`
      );
  };
  const flagUniforms = { uTime: { value: 0 } };
  for (const sgn of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 10, 6), new THREE.MeshStandardMaterial({ color: '#e9e6ff' }));
    pole.position.copy(gateInfo['flag' + sgn]);
    group.add(pole);
    const f = new THREE.Mesh(flagGeo, flagMat);
    f.position.copy(gateInfo['flag' + sgn]).add(new THREE.Vector3(0, 3.4, 0));
    f.rotation.y = Math.PI * 0.6;
    f.castShadow = true;
    group.add(f);
    flags.push(f);
  }

  group.scale.setScalar(CITY_SCALE);
  group.position.set(KEEP.x * (1 - CITY_SCALE), 0, KEEP.z * (1 - CITY_SCALE));
  return {
    group,
    gate: gateInfo,
    update(t) { flagUniforms.uTime.value = t; },
  };
}
