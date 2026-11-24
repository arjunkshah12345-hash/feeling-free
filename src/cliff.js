import * as THREE from 'three';
import { noise2, fbm2, mulberry32, GLSL_NOISE } from './noise.js';
import { cliffX, wallX, heightAt, KEEP, CITY_R, clamp } from './world.js';

export function brickTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#a7acf0';
  g.fillRect(0, 0, S, S);
  const r = mulberry32(5);
  const rows = 10, rh = S / rows;
  for (let row = 0; row < rows; row++) {
    let x = -r() * 60;
    while (x < S) {
      const w = 70 + r() * 90;
      const L = 47 + r() * 17;
      const H = 233 + r() * 10;
      const y = row * rh;
      g.fillStyle = `hsl(${H}, ${52 + r() * 12}%, ${L}%)`;
      const gap = 3;
      const bx = x + gap, by = y + gap, bw = w - gap * 2, bh = rh - gap * 2;
      g.fillRect(bx, by, bw, bh);
      // soft top highlight and bottom shade give each block some depth
      const grd = g.createLinearGradient(0, by, 0, by + bh);
      grd.addColorStop(0, 'rgba(255,255,255,0.14)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0)');
      grd.addColorStop(1, 'rgba(10,8,60,0.22)');
      g.fillStyle = grd;
      g.fillRect(bx, by, bw, bh);
      // wrap horizontally so the texture tiles
      if (bx + bw > S) {
        g.fillStyle = `hsl(${H}, 56%, ${L}%)`;
        g.fillRect(bx - S, by, bw, bh);
      }
      x += w;
    }
  }
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function buildCliff() {
  const zs = [];
  for (let z = 1600; z >= -2800; z -= 6) zs.push(z);
  const rows = 110;
  const ys = [];
  for (let i = 0; i <= rows; i++) ys.push(-40 + 1150 * Math.pow(i / rows, 1.5));
  const nz = zs.length, ny = ys.length;
  const pos = new Float32Array(nz * ny * 3);
  const col = new Float32Array(nz * ny * 3);
  const dark = new THREE.Color('#2a2490'), mid = new THREE.Color('#5a50e0'), hi = new THREE.Color('#b4a6ff'), moss = new THREE.Color('#3f6a8a');
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    const cx = cliffX(z);
    const baseY = heightAt(cx - 20, z) - 10;
    for (let i = 0; i < ny; i++) {
      const y = ys[i] + Math.max(0, baseY);
      const big = fbm2(z * 0.007, y * 0.0015, 4);
      const ridge = fbm2(z * 0.034, y * 0.0045, 3);
      const fine = noise2(z * 0.13, y * 0.028);
      const p = 36 * big + 12 * ridge + 3.5 * fine;
      const x = cx + (y - baseY) * 0.16 + 0.00005 * (y - baseY) * (y - baseY) - p;
      const k = (j * ny + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const v = clamp(0.5 + big * 1.6 + ridge * 0.5, 0, 1);
      c.copy(dark).lerp(mid, v);
      const streak = clamp((ridge + fine * 0.35 - 0.05) * 2.2, 0, 1);
      c.lerp(hi, streak * 0.55);
      const low = 1 - clamp((y - baseY) / 60, 0, 1);
      c.lerp(moss, low * 0.35);
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < ny - 1; i++) {
      const a = j * ny + i, b = a + 1, cc = a + ny, d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  // Rock detail in the shader: long vertical striations and fractures that tint the
  // colour and bump the lighting (derivative bump mapping), fading out with distance.
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCWPos;
${GLSL_NOISE}
float rockH(vec3 p) {
  float a = fbm5(vec2(p.z * 0.045, p.y * 0.0055));
  float b = vnoise(vec2(p.z * 0.21, p.y * 0.022));
  float c = vnoise(vec2(p.z * 0.9, p.y * 0.09));
  float ledges = smoothstep(0.55, 0.62, vnoise(vec2(p.z * 0.012, p.y * 0.05 + 3.0)));
  return a * 0.62 + b * 0.26 + c * 0.12 - ledges * 0.08;
}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float rh = rockH(vCWPos);
float crev = smoothstep(0.32, 0.5, rh);
diffuseColor.rgb *= mix(0.42, 1.18, crev);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 1.12, 1.3), smoothstep(0.62, 0.8, rh) * 0.6);`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
  float hh = rh * 9.0;
  float hx = dFdx(hh), hy = dFdy(hh);
  float fadeB = 1.0 - smoothstep(600.0, 2200.0, length(vViewPosition));
  vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2) * fadeB;
  vec3 nn = abs(det) * normal - grad;
  if (dot(nn, nn) > 1e-14) normal = normalize(nn);
}`
      );
  };
  mat.customProgramCacheKey = () => 'cliff-rock';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'cliff';
  return mesh;
}

function scaleUV(geo, su, sv) {
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

export function buildWalls(brickTex) {
  const group = new THREE.Group();
  group.name = 'walls';
  const mat = new THREE.MeshStandardMaterial({ map: brickTex, roughness: 0.95, metalness: 0 });
  const dark = new THREE.MeshBasicMaterial({ color: '#0d0b3a' });

  // path along the wall line until it meets the city's ring wall
  const pts = [];
  for (let z = 480; z > -1700; z -= 8) {
    const x = wallX(z);
    if (Math.hypot(x - KEEP.x, z - KEEP.z) < CITY_R - 6) break;
    const base = Math.min(heightAt(x - 4, z), heightAt(x + 4, z));
    pts.push({ x, z, base });
  }
  // smooth the top line a little so the parapet reads as one sweep
  const tops = pts.map((p, i) => {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const q = pts[clamp(i + k, 0, pts.length - 1)];
      s += q.base; n++;
    }
    return s / n + 18;
  });
  const half = 2.6;
  const P = [], N = [], UV = [], I = [];
  let dist = 0;
  const frame = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    dx /= l; dz /= l;
    return { dx, dz, nx: dz, nz: -dx };
  });
  const push = (x, y, z, nx, ny, nz, u, v) => { P.push(x, y, z); N.push(nx, ny, nz); UV.push(u, v); return P.length / 3 - 1; };
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].dist = dist;
  }
  // faces: meadow side, cliff side, top
  const strip = (offset, normalSign, yLo, yHi, flip) => {
    const start = P.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], f = frame[i];
      const ox = p.x + f.nx * offset, oz = p.z + f.nz * offset;
      const lo = yLo(i), hi = yHi(i);
      push(ox, lo, oz, f.nx * normalSign, 0, f.nz * normalSign, p.dist / 4, lo / 4);
      push(ox, hi, oz, f.nx * normalSign, 0, f.nz * normalSign, p.dist / 4, hi / 4);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = start + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (flip) I.push(a, c, b, b, c, d);
      else I.push(a, b, c, b, d, c);
    }
  };
  strip(half, 1, (i) => pts[i].base - 6, (i) => tops[i], false);
  strip(-half, -1, (i) => pts[i].base - 6, (i) => tops[i], true);
  // top
  {
    const start = P.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], f = frame[i];
      push(p.x + f.nx * half, tops[i], p.z + f.nz * half, 0, 1, 0, p.dist / 4, 0);
      push(p.x - f.nx * half, tops[i], p.z - f.nz * half, 0, 1, 0, p.dist / 4, (half * 2) / 4);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = start + i * 2, b = a + 1, c = a + 2, d = a + 3;
      I.push(a, b, c, b, d, c);
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  wgeo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  wgeo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  wgeo.setIndex(I);
  const wall = new THREE.Mesh(wgeo, mat);
  wall.material.side = THREE.DoubleSide;
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  // merlons along the meadow-facing edge
  const merlonGeo = scaleUV(new THREE.BoxGeometry(1.5, 1.9, 1.2), 0.35, 0.45);
  const merlonPos = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.floor(segLen / 2.7);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const f = frame[i];
      merlonPos.push({
        x: a.x + (b.x - a.x) * t + f.nx * (half - 0.6),
        z: a.z + (b.z - a.z) * t + f.nz * (half - 0.6),
        y: tops[i] + (tops[i + 1] - tops[i]) * t + 0.95,
        yaw: Math.atan2(f.dx, f.dz),
      });
    }
  }
  const merlons = new THREE.InstancedMesh(merlonGeo, mat, merlonPos.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  merlonPos.forEach((p, i) => {
    q.setFromAxisAngle(up, p.yaw);
    m4.compose(v.set(p.x, p.y, p.z), q, s);
    merlons.setMatrixAt(i, m4);
  });
  merlons.castShadow = true;
  merlons.receiveShadow = true;
  group.add(merlons);

  // turrets
  const turrets = [];
  const rnd = mulberry32(17);
  for (let i = 4; i < pts.length; i += 11) {
    const big = (i / 11) % 2 < 1;
    const r = big ? 9.5 : 6.5;
    const f = frame[i], p = pts[i];
    turrets.push({ x: p.x + f.nx * r * 0.5, z: p.z + f.nz * r * 0.5, base: p.base - 6, top: tops[i] + (big ? 13 : 8) + rnd() * 4, r });
  }
  const last = pts[pts.length - 1], lf = frame[pts.length - 1];
  turrets.push({ x: last.x + lf.nx * 3, z: last.z + lf.nz * 3, base: last.base - 6, top: tops[pts.length - 1] + 22, r: 12 });

  const slitGeo = new THREE.BoxGeometry(0.5, 2.2, 0.5);
  const slitPos = [];
  const turretMerlons = [];
  for (const t of turrets) {
    const H = t.top - t.base;
    const body = scaleUV(new THREE.CylinderGeometry(t.r, t.r * 1.05, H, 30, 1, false), (Math.PI * 2 * t.r) / 4, H / 4);
    const m = new THREE.Mesh(body, mat);
    m.position.set(t.x, t.base + H / 2, t.z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    const corbel = scaleUV(new THREE.CylinderGeometry(t.r + 0.9, t.r, 1.8, 30, 1, true), (Math.PI * 2 * t.r) / 4, 0.45);
    const cm = new THREE.Mesh(corbel, mat);
    cm.position.set(t.x, t.top + 0.9, t.z);
    cm.castShadow = true;
    group.add(cm);
    const ring = scaleUV(new THREE.CylinderGeometry(t.r + 0.9, t.r + 0.9, 1.6, 30, 1, false), (Math.PI * 2 * t.r) / 4, 0.4);
    const rm = new THREE.Mesh(ring, mat);
    rm.position.set(t.x, t.top + 2.6, t.z);
    rm.castShadow = true;
    group.add(rm);
    const nM = Math.round((Math.PI * 2 * (t.r + 0.6)) / 2.5);
    for (let k = 0; k < nM; k++) {
      const a = (k / nM) * Math.PI * 2;
      turretMerlons.push({ x: t.x + Math.cos(a) * (t.r + 0.45), y: t.top + 4.2, z: t.z + Math.sin(a) * (t.r + 0.45), yaw: -a + Math.PI / 2 });
    }
    // arrow slits facing the meadow
    for (let k = 0; k < 3; k++) {
      const a = Math.PI + (k - 1) * 0.55;
      const yy = t.base + 10 + k * 3.2 + (k === 1 ? 4 : 0);
      if (yy > t.top - 2) continue;
      slitPos.push({ x: t.x + Math.cos(a) * (t.r + 0.02), y: yy, z: t.z + Math.sin(a) * (t.r + 0.02), a });
    }
  }
  const slits = new THREE.InstancedMesh(slitGeo, dark, slitPos.length);
  slitPos.forEach((p, i) => {
    q.setFromAxisAngle(up, -p.a);
    m4.compose(v.set(p.x, p.y, p.z), q, s);
    slits.setMatrixAt(i, m4);
  });
  group.add(slits);
  const tm = new THREE.InstancedMesh(merlonGeo, mat, turretMerlons.length);
  turretMerlons.forEach((p, i) => {
    q.setFromAxisAngle(up, p.yaw);
    m4.compose(v.set(p.x, p.y, p.z), q, s);
    tm.setMatrixAt(i, m4);
  });
  tm.castShadow = true;
  group.add(tm);

  // Top height of the wall (and its turrets) every 2 m along z, so the meadow
  // shaders can trace sunlight against it and paint the long wall shadows.
  const z0 = pts[0].z, z1 = pts[pts.length - 1].z;
  const n = Math.ceil((z0 - z1) / 2) + 1;
  const topArr = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const z = z0 - k * 2;
    const fi = clamp((z0 - z) / 8, 0, pts.length - 1);
    const i0 = Math.floor(fi), i1 = Math.min(pts.length - 1, i0 + 1);
    let top = tops[i0] + (tops[i1] - tops[i0]) * (fi - i0);
    for (const t of turrets) {
      const d = Math.abs(z - t.z);
      if (d < t.r) top = Math.max(top, t.top - (d / t.r) * (d / t.r) * 3);
    }
    topArr[k] = top;
  }
  const shadowTex = new THREE.DataTexture(topArr, n, 1, THREE.RedFormat, THREE.FloatType);
  shadowTex.minFilter = shadowTex.magFilter = THREE.NearestFilter;
  shadowTex.needsUpdate = true;
  return { group, turrets, path: pts, shadow: { tex: shadowTex, z0, z1, n } };
}
