import * as THREE from 'three';
import { mulberry32 } from './noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// How much sun reaches the rider (0 inside the wall's shadow); set every frame from main.
export const riderShade = { value: 1 };
const SHADE_GLSL = '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= mix(0.1, 1.0, uShade);\nreflectedLight.directSpecular *= uShade;\nreflectedLight.indirectDiffuse *= mix(1.35, 1.0, uShade);';
function shadeify(mat, key) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uShade = riderShade;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uShade;')
      .replace('#include <lights_fragment_end>', SHADE_GLSL);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// Soft sky-coloured rim light plus a little wrap so cloth reads against the grass.
function rimify(mat, rim = '#9fb6ff', strength = 0.55, key = 'rim') {
  const uRim = { value: new THREE.Color(rim).multiplyScalar(strength) };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = uRim;
    sh.uniforms.uShade = riderShade;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;\nuniform float uShade;')
      .replace('#include <lights_fragment_end>', SHADE_GLSL)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        totalEmissiveRadiance += uRim * rimF * rimF * rimF * diffuseColor.rgb * mix(0.4, 1.0, uShade);
        totalEmissiveRadiance += diffuseColor.rgb * vec3(0.05, 0.06, 0.11);`
      );
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// Tapered capsule along +Y, centred on the origin: radius r0 at the bottom end, r1 at the top.
function limbGeo(len, r0, r1, bulge = 0.06, seg = 16) {
  const pts = [];
  const capN = 6;
  for (let i = 0; i <= capN; i++) {
    const a = -Math.PI / 2 + (i / capN) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r0), -len / 2 + Math.sin(a) * r0));
  }
  const bodyN = 8;
  for (let i = 1; i < bodyN; i++) {
    const t = i / bodyN;
    const r = r0 + (r1 - r0) * t + Math.sin(t * Math.PI) * (r0 + r1) * bulge;
    pts.push(new THREE.Vector2(r, -len / 2 + t * len));
  }
  for (let i = 0; i <= capN; i++) {
    const a = (i / capN) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r1), len / 2 + Math.sin(a) * r1));
  }
  return new THREE.LatheGeometry(pts, seg);
}

// Merge transformed geometries (optionally with a flat vertex colour each) into one.
function merge(parts, withColor = false) {
  const geos = parts.map(({ geo, m, color }) => {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
    if (withColor) {
      const n = g.getAttribute('position').count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    return g;
  });
  let total = 0;
  for (const g of geos) total += g.getAttribute('position').count;
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), C = withColor ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const g of geos) {
    const n = g.getAttribute('position').count;
    P.set(g.getAttribute('position').array, o * 3);
    N.set(g.getAttribute('normal').array, o * 3);
    if (C) C.set(g.getAttribute('color').array, o * 3);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (C) out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.computeBoundingSphere();
  return out;
}

const M4 = (pos, quat, scale) => new THREE.Matrix4().compose(pos || V3(0, 0, 0), quat || new THREE.Quaternion(), scale || V3(1, 1, 1));

function tube(a, b, r, mat, seg = 12) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, tmpV.copy(b).sub(a).normalize());
  m.castShadow = true;
  return m;
}

// A limb segment of fixed length, posed each frame between two joints.
class Bone {
  constructor(len, r0, r1, mat, parent, bulge) {
    this.len = len;
    this.mesh = new THREE.Mesh(limbGeo(len, r0, r1, bulge), mat);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }
  set(a, b) {
    this.mesh.position.copy(a).add(b).multiplyScalar(0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, tmpV.copy(b).sub(a).normalize());
  }
}

function solveIK(a, target, l1, l2, pole, outMid) {
  const d0 = tmpV2.copy(target).sub(a);
  let d = d0.length();
  const dir = d0.clone().divideScalar(Math.max(d, 1e-5));
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
  const bend = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  outMid.copy(a).addScaledVector(dir, x).addScaledVector(bend, h);
  return a.clone().addScaledVector(dir, d);
}

// Tousled hair: a scalp cap plus many swept, overlapping locks flowing back from the crown.
function hairGeometry(R) {
  const rnd = mulberry32(31);
  const base = new THREE.Color('#9a6634'), light = new THREE.Color('#d29a5a'), dark = new THREE.Color('#6a4220');
  const parts = [];
  const cap = new THREE.SphereGeometry(1, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.62);
  parts.push({ geo: cap, m: M4(V3(0, R * 0.04, R * 0.06), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0)), V3(R * 1.06, R * 1.08, R * 1.1)), color: base.clone().lerp(dark, 0.5) });
  const lock = new THREE.SphereGeometry(1, 10, 7);
  const crown = V3(0, R * 0.95, R * 0.35);
  const N = 150;
  for (let k = 0; k < N; k++) {
    // fibonacci points over the sphere, kept to the hair region
    const y = 1 - (k + 0.5) / N * 1.55;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = k * 2.39996323;
    const n = V3(Math.cos(phi) * r, y, Math.sin(phi) * r);
    const front = n.z < -0.25;
    if (front && n.y < 0.5) continue; // keep the face clear
    if (!front && n.y < -0.4) continue;
    if (n.z > 0.2 && n.y < -0.1 && Math.abs(n.x) < 0.5 && n.y < -0.3) continue;
    if (Math.abs(n.x) > 0.8 && n.y < 0.05 && n.z < 0.3) continue; // ears
    const p = n.clone().multiplyScalar(R * 1.02);
    let t = p.clone().sub(crown);
    t.sub(n.clone().multiplyScalar(t.dot(n)));
    if (t.lengthSq() < 1e-6) t.set(0, 0, 1);
    t.normalize().applyAxisAngle(n, (rnd() - 0.5) * 0.9);
    const X = new THREE.Vector3().crossVectors(n, t).normalize();
    const basis = new THREE.Matrix4().makeBasis(X, n, t);
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);
    const lift = new THREE.Quaternion().setFromAxisAngle(X, -0.08 - rnd() * 0.22);
    q.multiply(lift);
    const len = R * (0.42 + rnd() * 0.3) * (front ? 0.62 : 1);
    const pos = p.clone().addScaledVector(t, len * 0.4).addScaledVector(n, R * 0.035);
    const c = base.clone().lerp(rnd() < 0.5 ? light : dark, 0.2 + rnd() * 0.6);
    parts.push({ geo: lock, m: M4(pos, q, V3(R * (0.26 + rnd() * 0.12), R * 0.075, len)), color: c });
  }
  return merge(parts, true);
}

export class Rider {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'rider';
    scene.add(this.root);
    this.body = new THREE.Group(); // bike + kid, rotated by pitch/roll
    this.root.add(this.body);

    const frameMat = shadeify(new THREE.MeshStandardMaterial({ color: '#2a5cf0', roughness: 0.28, metalness: 0.45 }), 'sh-frame');
    const darkMat = shadeify(new THREE.MeshStandardMaterial({ color: '#23243a', roughness: 0.55, metalness: 0.2 }), 'sh-dark');
    const chromeMat = shadeify(new THREE.MeshStandardMaterial({ color: '#dfe4f4', roughness: 0.22, metalness: 0.85 }), 'sh-chrome');
    const leather = shadeify(new THREE.MeshStandardMaterial({ color: '#7a4626', roughness: 0.6 }), 'sh-leather');
    const tireMat = shadeify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'sh-tire');
    const shirt = rimify(new THREE.MeshStandardMaterial({ color: '#f6f4fc', roughness: 0.9 }), '#a9bcff', 0.7, 'rim-shirt');
    const pants = rimify(new THREE.MeshStandardMaterial({ color: '#eaecf6', roughness: 0.9 }), '#a9bcff', 0.7, 'rim-pants');
    const skin = rimify(new THREE.MeshStandardMaterial({ color: '#f2c29e', roughness: 0.7 }), '#ffc9a8', 0.5, 'rim-skin');
    const hairMat = rimify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), '#ffd9a0', 0.9, 'rim-hair');
    const shoeMat = rimify(new THREE.MeshStandardMaterial({ color: '#6e3f20', roughness: 0.65 }), '#ffb98a', 0.4, 'rim-shoe');
    const soleMat = shadeify(new THREE.MeshStandardMaterial({ color: '#efe6d8', roughness: 0.8 }), 'sh-sole');
    const eyeMat = new THREE.MeshStandardMaterial({ color: '#2a1a12', roughness: 0.3 });

    const B = this.body;
    // bike geometry (forward is -Z)
    this.rearAxle = V3(0, 0.34, 0.52);
    this.frontAxle = V3(0, 0.34, -0.55);
    this.bb = V3(0, 0.3, 0.08);
    const seatTop = V3(0, 0.9, 0.3);
    const headTop = V3(0, 0.9, -0.38);
    const headBot = V3(0, 0.74, -0.43);

    // gumwall tyre: tan sidewalls with a darker tread band
    const tireGeo = new THREE.TorusGeometry(0.316, 0.03, 12, 56);
    {
      const p = tireGeo.getAttribute('position');
      const col = new Float32Array(p.count * 3);
      const tan = new THREE.Color('#c98a4a'), tread = new THREE.Color('#3b2a22');
      for (let i = 0; i < p.count; i++) {
        const d = Math.hypot(p.getX(i), p.getY(i));
        const c = d > 0.316 + 0.03 * 0.55 ? tread : tan;
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      tireGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const wheel = () => {
      const g = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.rotation.y = Math.PI / 2;
      tire.castShadow = true;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.288, 0.012, 6, 48), chromeMat);
      rim.rotation.y = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 12), chromeMat);
      hub.rotation.z = Math.PI / 2;
      const sp = [];
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        const side = i % 2 ? 0.04 : -0.04;
        const a0 = a + (i % 4 < 2 ? 0.35 : -0.35); // crossed lacing
        sp.push(side, Math.cos(a0) * 0.02, Math.sin(a0) * 0.02, 0, Math.cos(a) * 0.284, Math.sin(a) * 0.284);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      const spokes = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: '#c9cfe4', transparent: true, opacity: 0.85 }));
      g.add(tire, rim, hub, spokes);
      return g;
    };
    this.rearWheel = wheel();
    this.rearWheel.position.copy(this.rearAxle);
    B.add(this.rearWheel);
    this.fork = new THREE.Group();
    this.fork.position.copy(headTop);
    this.fork.rotation.x = 0.3; // steering axis tilt
    B.add(this.fork);
    this.frontWheel = wheel();
    const fa = this.frontAxle.clone().sub(headTop);
    fa.applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.3);
    this.frontWheel.position.copy(fa);
    this.fork.add(this.frontWheel);
    for (const s of [-0.045, 0.045]) this.fork.add(tube(V3(s * 0.6, -0.12, 0), fa.clone().add(V3(s, 0, 0)), 0.012, frameMat));
    this.fork.add(tube(V3(-0.03, -0.12, 0), V3(0.03, -0.12, 0), 0.018, frameMat));
    this.fork.add(tube(V3(0, 0, 0), V3(0, 0.1, 0), 0.016, chromeMat));
    const bar = new THREE.Group();
    bar.position.set(0, 0.1, 0.02);
    // swept-back city bar
    const barPts = [V3(-0.3, 0.03, 0.12), V3(-0.2, 0.025, 0.06), V3(-0.08, 0.02, 0.0), V3(0.08, 0.02, 0.0), V3(0.2, 0.025, 0.06), V3(0.3, 0.03, 0.12)];
    const barCurve = new THREE.CatmullRomCurve3(barPts);
    const barM = new THREE.Mesh(new THREE.TubeGeometry(barCurve, 24, 0.011, 8), chromeMat);
    barM.castShadow = true;
    bar.add(barM);
    bar.add(tube(V3(0, -0.01, 0), V3(0, 0.02, 0.0), 0.016, chromeMat));
    for (const s of [-1, 1]) bar.add(tube(V3(s * 0.22, 0.026, 0.07), V3(s * 0.31, 0.031, 0.125), 0.018, leather));
    this.fork.add(bar);
    this.gripL = new THREE.Object3D(); this.gripL.position.set(-0.27, 0.13, 0.12); this.fork.add(this.gripL);
    this.gripR = new THREE.Object3D(); this.gripR.position.set(0.27, 0.13, 0.12); this.fork.add(this.gripR);

    // frame: top tube, down tube, seat tube, head tube, stays
    B.add(tube(this.bb, headBot, 0.024, frameMat));
    B.add(tube(V3(0, 0.82, 0.27), headTop.clone().add(V3(0, -0.03, 0)), 0.02, frameMat));
    B.add(tube(this.bb, V3(0, 0.86, 0.285), 0.022, frameMat));
    B.add(tube(headTop.clone().add(V3(0, 0.02, 0)), headBot.clone().add(V3(0, -0.02, 0)), 0.028, frameMat));
    for (const s of [-0.05, 0.05]) {
      B.add(tube(this.bb.clone().add(V3(s * 0.5, 0, 0)), this.rearAxle.clone().add(V3(s, 0, 0)), 0.011, frameMat));
      B.add(tube(V3(s * 0.4, 0.82, 0.27), this.rearAxle.clone().add(V3(s, 0, 0)), 0.01, frameMat));
    }
    B.add(tube(V3(0, 0.86, 0.285), seatTop, 0.014, chromeMat));
    // leather saddle
    const saddleG = merge([
      { geo: new THREE.SphereGeometry(1, 18, 10), m: M4(V3(0, 0, 0.03), null, V3(0.085, 0.032, 0.09)) },
      { geo: new THREE.SphereGeometry(1, 14, 8), m: M4(V3(0, 0.004, -0.07), null, V3(0.035, 0.026, 0.08)) },
    ]);
    const saddle = new THREE.Mesh(saddleG, leather);
    saddle.position.copy(seatTop).add(V3(0, 0.03, 0));
    saddle.castShadow = true;
    B.add(saddle);
    // crank, chainring and pedals
    this.crank = new THREE.Group();
    this.crank.position.copy(this.bb);
    B.add(this.crank);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.01, 6, 32), chromeMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = 0.05;
    this.crank.add(ring);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.crank.add(tube(V3(0.05, 0, 0), V3(0.05, Math.cos(a) * 0.085, Math.sin(a) * 0.085), 0.006, chromeMat, 6));
    }
    for (const s of [-1, 1]) {
      this.crank.add(tube(V3(s * 0.06, 0, 0), V3(s * 0.06, -s * 0.17, 0), 0.012, chromeMat));
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.07), darkMat);
      pedal.position.set(s * 0.11, -s * 0.17, 0);
      this.crank.add(pedal);
    }
    B.add(tube(this.bb.clone().add(V3(0.05, 0.085, 0)), this.rearAxle.clone().add(V3(0.05, 0.04, 0)), 0.005, darkMat, 6));
    B.add(tube(this.bb.clone().add(V3(0.05, -0.085, 0)), this.rearAxle.clone().add(V3(0.05, -0.04, 0)), 0.005, darkMat, 6));

    // ---- the kid ----
    this.kid = new THREE.Group();
    B.add(this.kid);
    const K = this.kid;
    // torso: a lathed shirt shape from waist to collar, posed hip -> shoulder
    this.torsoLen = 0.544;
    const prof = [[0.0, 0.0], [0.11, 0.0], [0.118, 0.06], [0.122, 0.16], [0.13, 0.27], [0.138, 0.38], [0.136, 0.45], [0.118, 0.51], [0.075, 0.55], [0.0, 0.56]];
    const torsoG = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), 24);
    torsoG.scale(1.12, 1, 0.76);
    this.torso = new THREE.Mesh(torsoG, shirt);
    this.torso.castShadow = true;
    K.add(this.torso);
    // a slightly untucked hem and a belt
    this.hem = new THREE.Mesh(new THREE.CylinderGeometry(0.128, 0.134, 0.05, 24, 1, true), shirt);
    this.hem.geometry.scale(1.12, 1, 0.78);
    this.hem.castShadow = true;
    this.torso.add(this.hem);
    this.hem.position.y = 0.03;
    this.hips = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), pants);
    this.hips.scale.set(1.06, 0.7, 0.78);
    this.hips.castShadow = true;
    K.add(this.hips);
    this.delts = [0, 1].map(() => { const d = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 10), shirt); d.castShadow = true; K.add(d); return d; });
    this.neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.046, 0.09, 12), skin);
    K.add(this.neck);
    this.collar = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.014, 8, 20), shirt);
    this.collar.rotation.x = Math.PI / 2;
    K.add(this.collar);

    // head with face, ears and a mop of hair
    this.head = new THREE.Group();
    K.add(this.head);
    const R = 0.118;
    const headG = merge([
      { geo: new THREE.SphereGeometry(1, 28, 20), m: M4(V3(0, 0, 0), null, V3(R * 0.94, R * 1.04, R)) },
      { geo: new THREE.SphereGeometry(1, 20, 14), m: M4(V3(0, -R * 0.42, -R * 0.28), null, V3(R * 0.72, R * 0.6, R * 0.7)) }, // jaw and cheeks
      { geo: new THREE.SphereGeometry(1, 10, 8), m: M4(V3(0, -R * 0.12, -R * 0.98), null, V3(R * 0.13, R * 0.15, R * 0.14)) }, // nose
      { geo: new THREE.SphereGeometry(1, 10, 8), m: M4(V3(-R * 0.93, -R * 0.08, R * 0.05), null, V3(R * 0.12, R * 0.22, R * 0.16)) },
      { geo: new THREE.SphereGeometry(1, 10, 8), m: M4(V3(R * 0.93, -R * 0.08, R * 0.05), null, V3(R * 0.12, R * 0.22, R * 0.16)) },
    ]);
    const headM = new THREE.Mesh(headG, skin);
    headM.castShadow = true;
    this.head.add(headM);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), eyeMat);
      eye.scale.set(R * 0.1, R * 0.14, R * 0.06);
      eye.position.set(s * R * 0.34, R * 0.02, -R * 0.95);
      this.head.add(eye);
      const brow = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial({ color: '#6a4220', roughness: 0.8 }));
      brow.scale.set(R * 0.17, R * 0.04, R * 0.05);
      brow.position.set(s * R * 0.34, R * 0.24, -R * 0.92);
      brow.rotation.z = -s * 0.15;
      this.head.add(brow);
    }
    const hairM = new THREE.Mesh(hairGeometry(R), hairMat);
    hairM.castShadow = true;
    this.head.add(hairM);
    this.hair = hairM;

    // limbs: trousers, long white sleeves, mitten hands, brown shoes
    this.thighs = [new Bone(0.43, 0.072, 0.06, pants, K, 0.04), new Bone(0.43, 0.072, 0.06, pants, K, 0.04)];
    this.shins = [new Bone(0.45, 0.058, 0.05, pants, K, 0.08), new Bone(0.45, 0.058, 0.05, pants, K, 0.08)];
    this.uppers = [new Bone(0.27, 0.052, 0.044, shirt, K, 0.06), new Bone(0.27, 0.052, 0.044, shirt, K, 0.06)];
    this.fores = [new Bone(0.25, 0.044, 0.04, shirt, K, 0.04), new Bone(0.25, 0.044, 0.04, shirt, K, 0.04)];
    this.wrists = [0, 1].map(() => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 10), skin); K.add(w); return w; });
    this.sleeveCuffs = [0, 1].map(() => { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.035, 14), shirt); c.castShadow = true; K.add(c); return c; });
    this.cuffs = [0, 1].map(() => { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.05, 14), pants); c.castShadow = true; K.add(c); return c; });
    const shoeG = merge([
      { geo: new THREE.SphereGeometry(1, 16, 10), m: M4(V3(0, 0.012, -0.045), null, V3(0.052, 0.045, 0.125)) },
      { geo: new THREE.SphereGeometry(1, 12, 8), m: M4(V3(0, 0.035, 0.035), null, V3(0.046, 0.05, 0.06)) },
    ]);
    const soleG = new THREE.BoxGeometry(0.1, 0.018, 0.25);
    soleG.translate(0, -0.028, -0.045);
    this.feet = [0, 1].map(() => {
      const f = new THREE.Group();
      const up = new THREE.Mesh(shoeG, shoeMat); up.castShadow = true;
      const so = new THREE.Mesh(soleG, soleMat); so.castShadow = true;
      f.add(up, so);
      K.add(f);
      return f;
    });
    const handG = merge([
      { geo: new THREE.SphereGeometry(1, 14, 10), m: M4(V3(0, 0, 0), null, V3(0.036, 0.042, 0.05)) },
      { geo: new THREE.SphereGeometry(1, 8, 6), m: M4(V3(0.0, 0.03, -0.02), null, V3(0.016, 0.016, 0.03)) },
    ]);
    this.hands = [0, 1].map(() => { const h = new THREE.Mesh(handG, skin); h.castShadow = true; K.add(h); return h; });

    this.cape = new Cape(scene);
    this.stand = 0;
    this.time = 0;
    this.lookYaw = 0;
    this.joints = { hip: new THREE.Vector3(), shoulder: new THREE.Vector3(), neckTop: new THREE.Vector3() };
    this._knee = new THREE.Vector3();
    this._elbow = new THREE.Vector3();
    this._inv = new THREE.Matrix4();
  }

  update(dt, st) {
    this.time += dt;
    this.rearWheel.rotation.x -= (st.speed / 0.346) * dt;
    this.frontWheel.rotation.x -= (st.speed / 0.346) * dt;
    this.crank.rotation.x = -st.crank;
    this.fork.rotation.y = st.steer * 0.32;

    const standTarget = st.airborne ? 0.9 : st.sprint ? 1 : 0;
    this.stand += (standTarget - this.stand) * Math.min(1, dt * 5);
    const s = this.stand;
    const sp = Math.abs(st.speed);
    const bob = Math.sin(st.crank * 2) * 0.012 * (0.4 + s);
    const sway = Math.sin(st.crank) * 0.05 * s;
    const breathe = Math.sin(this.time * 2.1) * 0.006;
    const lean = Math.min(1, sp / 18) * 0.05 + st.effort * 0.03;
    const V = THREE.Vector3;

    const hip = new V(sway * 0.6, 1.0 + 0.14 * s + bob, 0.3 - 0.14 * s);
    const shoulder = new V(sway, 1.44 + 0.06 * s + bob + breathe - lean * 0.5, -0.02 - 0.1 * s - lean);
    const neckTop = shoulder.clone().add(new V(0, 0.07, -0.025));
    this.joints.hip.copy(hip); this.joints.shoulder.copy(shoulder); this.joints.neckTop.copy(neckTop);

    this.hips.position.copy(hip).add(new V(0, 0.015, -0.025));
    const tdir = tmpV.copy(shoulder).sub(hip);
    const tlen = tdir.length();
    this.torso.position.copy(hip).add(new V(0, -0.02, 0));
    this.torso.quaternion.setFromUnitVectors(UP, tdir.normalize());
    this.torso.scale.set(1, tlen / this.torsoLen, 1);
    this.neck.position.copy(shoulder).lerp(neckTop, 0.55);
    this.neck.quaternion.setFromUnitVectors(UP, tmpV.copy(neckTop).sub(shoulder).normalize());
    this.collar.position.copy(shoulder).add(new V(0, 0.015, 0.0));
    this.collar.rotation.set(Math.PI / 2 - 0.5, 0, 0);
    this.head.position.copy(neckTop).add(new V(0, 0.1, -0.03));
    this.lookYaw += (-st.steer * 0.35 + st.look * 0.8 - this.lookYaw) * Math.min(1, dt * 4);
    this.head.rotation.set(0.32 - 0.15 * s + lean, this.lookYaw, -st.steer * 0.06);
    this.hair.rotation.x = -Math.min(0.08, sp * 0.004);

    // legs to the pedals
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const ang = st.crank + (i === 0 ? 0 : Math.PI);
      const pedal = new V(side * 0.11, this.bb.y + Math.cos(ang) * 0.17 + 0.045, this.bb.z - Math.sin(ang) * 0.17);
      const hipJ = hip.clone().add(new V(side * 0.085, -0.03, 0));
      const pole = new V(side * 0.18, 0.25, -1).normalize();
      const end = solveIK(hipJ, pedal, 0.43, 0.45, pole, this._knee);
      this.thighs[i].set(hipJ, this._knee);
      this.shins[i].set(this._knee, end);
      const cuffPos = this._knee.clone().lerp(end, 0.9);
      this.cuffs[i].position.copy(cuffPos);
      this.cuffs[i].quaternion.copy(this.shins[i].mesh.quaternion);
      const f = this.feet[i];
      f.position.copy(end).add(new V(0, -0.015, -0.01));
      f.rotation.set(Math.sin(ang) * 0.28 - 0.12, side * 0.06, 0);
    }
    // arms to the grips
    this.body.updateMatrixWorld(true);
    const inv = this._inv.copy(this.kid.matrixWorld).invert();
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const grip = (i === 0 ? this.gripL : this.gripR).getWorldPosition(new V()).applyMatrix4(inv);
      const sh = shoulder.clone().add(new V(side * 0.165, -0.035, 0.02));
      this.delts[i].position.copy(sh).add(new V(-side * 0.01, 0.01, 0));
      const pole = new V(side * 1, -0.5, 0.45).normalize();
      const end = solveIK(sh, grip, 0.27, 0.27, pole, this._elbow);
      const wristP = this._elbow.clone().lerp(end, 0.86);
      this.uppers[i].set(sh, this._elbow);
      this.fores[i].set(this._elbow, wristP);
      this.fores[i].mesh.scale.y = this._elbow.distanceTo(wristP) / 0.25;
      this.sleeveCuffs[i].position.copy(wristP);
      this.sleeveCuffs[i].quaternion.copy(this.fores[i].mesh.quaternion);
      this.wrists[i].position.copy(wristP).lerp(end, 0.5);
      this.wrists[i].quaternion.copy(this.fores[i].mesh.quaternion);
      const h = this.hands[i];
      h.position.copy(end);
      h.quaternion.copy(this.fores[i].mesh.quaternion);
    }
    this.kid.updateMatrixWorld(true);
    this.cape.update(dt, this, st);
  }
}

// Verlet cloth pinned across the shoulders, pushed by gravity and the relative wind.
class Cape {
  constructor(scene) {
    this.C = 11; this.R = 13;
    this.len = 0.74; this.topW = 0.34; this.botW = 0.98;
    const n = this.C * this.R;
    this.p = new Float32Array(n * 3);
    this.q = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.cons = [];
    this.inited = false;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    const uv = [];
    for (let j = 0; j < this.R; j++) for (let i = 0; i < this.C; i++) uv.push(i / (this.C - 1), j / (this.R - 1));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const idx = [];
    for (let j = 0; j < this.R - 1; j++) {
      for (let i = 0; i < this.C - 1; i++) {
        const a = j * this.C + i, b = a + 1, c = a + this.C, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    geo.setIndex(idx);
    this.geo = geo;
    const mat = new THREE.MeshStandardMaterial({ color: '#ff4612', roughness: 0.72, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uShade;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= gl_FrontFacing ? 1.0 : 0.82;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.0, 0.7, 0.62), smoothstep(0.35, 1.0, vUv.y) * 0.4);
// a narrow hem along the bottom edge
diffuseColor.rgb *= 1.0 - smoothstep(0.93, 0.96, vUv.y) * 0.18;`
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfloat rimF = 1.0 - abs(dot(normal, normalize(vViewPosition)));\ntotalEmissiveRadiance += (diffuseColor.rgb * (0.06 + rimF * rimF * 0.3) + vec3(0.02, 0.0, 0.015)) * mix(0.35, 1.0, uShade);')
        .replace('#include <lights_fragment_end>', SHADE_GLSL);
      sh.uniforms.uShade = riderShade;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>');
    };
    mat.defines = { USE_UV: '' };
    mat.customProgramCacheKey = () => 'cape';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.anchorsPrev = null;
    this.acc = 0;
    this.t = 0;
  }

  restLocal() {
    // rest layout in the kid's local frame: hanging down the back
    const out = [];
    for (let j = 0; j < this.R; j++) {
      const v = j / (this.R - 1);
      const w = this.topW + (this.botW - this.topW) * v;
      for (let i = 0; i < this.C; i++) {
        const u = i / (this.C - 1) - 0.5;
        out.push(new THREE.Vector3(u * w, -v * this.len, 0.06 + v * 0.05));
      }
    }
    return out;
  }

  anchorsWorld(rider) {
    const sh = rider.joints.shoulder;
    const m = rider.kid.matrixWorld;
    const res = [];
    for (let i = 0; i < this.C; i++) {
      const u = i / (this.C - 1) - 0.5;
      const x = u * this.topW;
      const curve = 1 - (u * 2) * (u * 2);
      res.push(new THREE.Vector3(sh.x + x, sh.y + 0.04 + curve * 0.03, sh.z + 0.06 + curve * 0.035).applyMatrix4(m));
    }
    return res;
  }

  init(rider) {
    const rest = this.restLocal();
    const sh = rider.joints.shoulder;
    const m = rider.kid.matrixWorld;
    rest.forEach((v, k) => {
      const w = v.clone().add(new THREE.Vector3(sh.x, sh.y + 0.04, sh.z)).applyMatrix4(m);
      this.p[k * 3] = this.q[k * 3] = w.x;
      this.p[k * 3 + 1] = this.q[k * 3 + 1] = w.y;
      this.p[k * 3 + 2] = this.q[k * 3 + 2] = w.z;
    });
    const C = this.C, R = this.R;
    const add = (a, b) => {
      const dx = rest[a].x - rest[b].x, dy = rest[a].y - rest[b].y, dz = rest[a].z - rest[b].z;
      this.cons.push([a, b, Math.hypot(dx, dy, dz)]);
    };
    for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
      const k = j * C + i;
      if (i < C - 1) add(k, k + 1);
      if (j < R - 1) add(k, k + C);
      if (i < C - 1 && j < R - 1) { add(k, k + C + 1); add(k + 1, k + C); }
      if (j < R - 2) add(k, k + 2 * C);
    }
    this.inited = true;
  }

  reset(rider) {
    rider.root.updateMatrixWorld(true);
    this.cons = [];
    this.inited = false;
    this.anchorsPrev = null;
    this.acc = 0;
    this.init(rider);
    this.nrm.fill(0);
  }

  update(dt, rider, st) {
    if (!this.inited) this.init(rider);
    const anchors = this.anchorsWorld(rider);
    // teleported (restart, respawn): drop the cloth back onto the shoulders
    if (this.anchorsPrev && this.anchorsPrev[0].distanceTo(anchors[0]) > 2.5) this.reset(rider);
    if (!this.anchorsPrev) this.anchorsPrev = anchors.map((a) => a.clone());
    const h = 1 / 120;
    this.acc = Math.min(this.acc + dt, h * 5);
    const steps = Math.floor(this.acc / h);
    this.acc -= steps * h;
    const C = this.C, R = this.R, n = C * R;
    const P = this.p, Q = this.q, N = this.nrm;
    const wind = st.wind;
    // body colliders in world space
    const m = rider.kid.matrixWorld;
    const sh = rider.joints.shoulder, hp = rider.joints.hip;
    const spheres = [
      [new THREE.Vector3().copy(hp).lerp(sh, 0.72).applyMatrix4(m), 0.15],
      [new THREE.Vector3().copy(hp).lerp(sh, 0.38).applyMatrix4(m), 0.155],
      [new THREE.Vector3(hp.x, hp.y, hp.z + 0.02).applyMatrix4(m), 0.15],
      [new THREE.Vector3(0, 0.62, 0.5).applyMatrix4(m), 0.28],
    ];
    for (let s = 0; s < steps; s++) {
      this.t += h;
      const f = (s + 1) / steps;
      for (let i = 0; i < C; i++) {
        const a = tmpV.copy(this.anchorsPrev[i]).lerp(anchors[i], f);
        P[i * 3] = a.x; P[i * 3 + 1] = a.y; P[i * 3 + 2] = a.z;
        Q[i * 3] = a.x; Q[i * 3 + 1] = a.y; Q[i * 3 + 2] = a.z;
      }
      for (let k = C; k < n; k++) {
        const j = Math.floor(k / C), i = k % C;
        const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2];
        const vx = (x - Q[k * 3]) / h, vy = (y - Q[k * 3 + 1]) / h, vz = (z - Q[k * 3 + 2]) / h;
        let rx = wind.x - vx, ry = wind.y - vy, rz = wind.z - vz;
        const rl = Math.hypot(rx, ry, rz);
        const nx = N[k * 3], ny = N[k * 3 + 1], nz = N[k * 3 + 2];
        const dn = nx * rx + ny * ry + nz * rz;
        const v = j / (R - 1);
        const flutter = (Math.sin(this.t * 15 - j * 1.25 + i * 0.7) * 0.75 + Math.sin(this.t * 6.1 - j * 0.5 + i * 0.25) * 0.4) * rl * v;
        const kd = 0.03, kn = 0.15;
        let ax = rx * rl * kd + nx * (dn * Math.abs(dn) * kn + flutter);
        let ay = -9.8 + ry * rl * kd + ny * (dn * Math.abs(dn) * kn + flutter);
        let az = rz * rl * kd + nz * (dn * Math.abs(dn) * kn + flutter);
        const am = Math.hypot(ax, ay, az);
        if (am > 400) { ax *= 400 / am; ay *= 400 / am; az *= 400 / am; }
        const damp = 0.992;
        const nx2 = x + (x - Q[k * 3]) * damp + ax * h * h;
        const ny2 = y + (y - Q[k * 3 + 1]) * damp + ay * h * h;
        const nz2 = z + (z - Q[k * 3 + 2]) * damp + az * h * h;
        Q[k * 3] = x; Q[k * 3 + 1] = y; Q[k * 3 + 2] = z;
        P[k * 3] = nx2; P[k * 3 + 1] = ny2; P[k * 3 + 2] = nz2;
      }
      for (let it = 0; it < 6; it++) {
        for (const [a, b, rest] of this.cons) {
          const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
          const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
          const dx = bx - ax, dy = by - ay, dz = bz - az;
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          const diff = (d - rest) / d;
          const wa = a < C ? 0 : 1, wb = b < C ? 0 : 1;
          const ws = wa + wb;
          if (!ws) continue;
          const k1 = (diff * wa) / ws, k2 = (diff * wb) / ws;
          P[a * 3] += dx * k1; P[a * 3 + 1] += dy * k1; P[a * 3 + 2] += dz * k1;
          P[b * 3] -= dx * k2; P[b * 3 + 1] -= dy * k2; P[b * 3 + 2] -= dz * k2;
        }
        for (let k = C; k < n; k++) {
          for (const [c, r] of spheres) {
            const dx = P[k * 3] - c.x, dy = P[k * 3 + 1] - c.y, dz = P[k * 3 + 2] - c.z;
            const d = Math.hypot(dx, dy, dz);
            if (d < r && d > 1e-6) {
              const s2 = r / d;
              P[k * 3] = c.x + dx * s2; P[k * 3 + 1] = c.y + dy * s2; P[k * 3 + 2] = c.z + dz * s2;
            }
          }
        }
      }
    }
    for (let i = 0; i < C; i++) this.anchorsPrev[i].copy(anchors[i]);
    this.pos.array.set(P);
    this.pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    const na = this.geo.getAttribute('normal').array;
    N.set(na);
  }
}
