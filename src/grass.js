import * as THREE from 'three';
import { GLSL_NOISE } from './noise.js';
import { GLSL_MEADOW, meadowUniforms } from './terrain.js';
import { GLSL_WALLSHADOW } from './world.js';
import { mulberry32 } from './noise.js';

// World-anchored blade field that wraps around a moving centre (just ahead of the rider).
const GLSL_FIELD = /* glsl */ `
attribute vec2 aOffset;
attribute vec4 aRand;
uniform float uTime;
uniform vec2 uGrassCenter;
uniform float uGrassRadius;
uniform float uTile;
uniform sampler2D uHeight;
uniform vec4 uHBounds;
uniform vec2 uHRes;
uniform vec3 uPlayer;
uniform vec2 uWindDir;
uniform float uWind;
float fieldHeight(vec2 xz) {
  vec2 uv = (xz - uHBounds.xy) / uHBounds.zw * (uHRes - 1.0);
  uv = clamp(uv, vec2(0.0), uHRes - 1.001);
  vec2 i = floor(uv); vec2 f = uv - i; ivec2 ii = ivec2(i);
  float a = texelFetch(uHeight, ii, 0).r;
  float b = texelFetch(uHeight, ii + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeight, ii + ivec2(0, 1), 0).r;
  float d = texelFetch(uHeight, ii + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

function bladeGeometry() {
  const segs = 4;
  const pos = [];
  for (let s = 0; s < segs; s++) {
    const t = s / segs;
    pos.push(-0.5, t, 0, 0.5, t, 0);
  }
  pos.push(0, 1, 0);
  const idx = [];
  for (let s = 0; s < segs - 1; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const a = (segs - 1) * 2;
  idx.push(a, a + 1, a + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

function fieldGeometry(base, count, tile, seed) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('normal', base.getAttribute('normal'));
  if (base.getAttribute('uv')) g.setAttribute('uv', base.getAttribute('uv'));
  const r = mulberry32(seed);
  const off = new Float32Array(count * 2);
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    off[i * 2] = r() * tile;
    off[i * 2 + 1] = r() * tile;
    rnd[i * 4] = r(); rnd[i * 4 + 1] = r(); rnd[i * 4 + 2] = r(); rnd[i * 4 + 3] = r();
  }
  g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 2));
  g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 4));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

function fieldUniforms(shared, hm, tile) {
  return {
    uTime: shared.uTime,
    uGrassCenter: shared.uGrassCenter,
    uGrassRadius: shared.uGrassRadius,
    uTile: { value: tile },
    uHeight: { value: hm.tex },
    uHBounds: { value: hm.bounds },
    uHRes: { value: hm.res },
    uPlayer: shared.uPlayer,
    uWindDir: shared.uWindDir,
    uWind: shared.uWind,
    uSunDir: shared.uSunDir,
    uWallTop: shared.uWallTop,
    uWallSpan: shared.uWallSpan,
  };
}

export function buildGrass(shared, hm, quality = 1) {
  const tile = 2 * shared.uGrassRadius.value;
  const count = Math.round(118000 * quality);
  const geo = fieldGeometry(bladeGeometry(), count, tile, 7);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const mu = meadowUniforms();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fieldUniforms(shared, hm, tile), mu, { uSunTint: { value: new THREE.Color('#fff1b0') } });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${GLSL_NOISE}
${GLSL_FIELD}
${GLSL_MEADOW}
${GLSL_WALLSHADOW}
varying float vT;
varying vec3 vGCol;
varying float vWallSh;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec2 rel = mod(aOffset - uGrassCenter + 0.5 * uTile, uTile) - 0.5 * uTile;
vec2 wxz = uGrassCenter + rel;
float dist = length(rel);
float fade = 1.0 - smoothstep(uGrassRadius * 0.55, uGrassRadius * 0.98, dist);
float ground = fieldHeight(wxz);
float patchN = vnoise(wxz * 0.045);
float hgt = (0.24 + 0.5 * aRand.x) * (0.7 + 0.6 * patchN) * fade;
float ang = aRand.y * 6.28318;
float wdt = 0.04 + 0.045 * aRand.z;
float t = position.y;
float ph = dot(wxz, uWindDir);
float gust = 0.5 + 0.5 * sin(ph * 0.08 - uTime * 1.6 + vnoise(wxz * 0.015 + uTime * 0.12) * 5.0);
float flutter = sin(uTime * 6.5 + aRand.w * 30.0 + ph * 0.7) * 0.07;
float bend = uWind * (0.12 + 0.55 * gust) + flutter + 0.18 * aRand.w;
vec2 bdir = uWindDir;
vec2 toP = wxz - uPlayer.xz;
float dp = length(toP);
float push = (1.0 - smoothstep(0.35, 1.9, dp)) * (1.0 - smoothstep(0.6, 2.4, uPlayer.y - ground));
bdir = normalize(bdir * (1.0 - push) + toP / max(dp, 0.001) * push * 2.5 + vec2(1e-4));
bend = mix(bend, 1.35, push);
vec2 side = vec2(cos(ang), sin(ang));
float lean = bend * t * t;
float wv = position.x * wdt * (1.0 - 0.75 * t);
vec3 gp = vec3(side.x * wv, t * hgt * (1.0 - 0.28 * lean * lean), side.y * wv);
gp.xz += bdir * lean * hgt * 0.85;
vec3 grassPos = vec3(wxz.x, ground - 0.05, wxz.y) + gp;
vec3 fnrm = normalize(vec3(-side.y, 0.0, side.x));
vec3 objectNormal = normalize(mix(fnrm, vec3(0.0, 1.0, 0.0), 0.7) + vec3(bdir.x, 0.0, bdir.y) * 0.2 * t);
vT = t;
vGCol = meadowColor(wxz) * (0.85 + 0.3 * aRand.z);
vWallSh = wallShade(grassPos);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = grassPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vT;\nvarying vec3 vGCol;\nvarying float vWallSh;\nuniform vec3 uSunTint;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 gBase = vGCol * 0.42;
vec3 gTip = vGCol * 1.12 + vec3(0.01, 0.04, 0.0);
diffuseColor.rgb *= mix(gBase, gTip, smoothstep(0.0, 1.0, vT));`
      )
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGCol * uSunTint * 0.14 * vT * vT * vWallSh;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= mix(0.08, 1.0, vWallSh);\nreflectedLight.indirectDiffuse *= mix(vec3(1.25, 1.4, 1.85), vec3(1.0), vWallSh);');
  };
  mat.customProgramCacheKey = () => 'grass-blades';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = 'grass';
  return mesh;
}

export function buildFlowers(shared, hm, quality = 1) {
  const tile = 2 * shared.uGrassRadius.value;
  const count = Math.round(14000 * quality);
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = fieldGeometry(quad, count, tile, 21);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fieldUniforms(shared, hm, tile));
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${GLSL_NOISE}
${GLSL_FIELD}
${GLSL_WALLSHADOW}
varying vec2 vFUv;
varying float vKind;
varying float vWallSh;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec2 rel = mod(aOffset - uGrassCenter + 0.5 * uTile, uTile) - 0.5 * uTile;
vec2 wxz = uGrassCenter + rel;
float fade = 1.0 - smoothstep(uGrassRadius * 0.5, uGrassRadius * 0.92, length(rel));
float patchN = smoothstep(0.35, 0.75, fbm3(wxz * 0.018 + 31.0));
float keep = step(aRand.z, 0.1 + patchN * 0.9);
float ground = fieldHeight(wxz);
float size = (0.048 + 0.034 * aRand.x) * fade * keep;
float stem = (0.2 + 0.3 * aRand.y) * fade;
float ph = dot(wxz, uWindDir);
float sway = uWind * (0.15 + 0.25 * sin(ph * 0.08 - uTime * 1.6)) + 0.05 * sin(uTime * 3.0 + aRand.w * 20.0);
vec2 toP = wxz - uPlayer.xz;
float dp = length(toP);
float push = (1.0 - smoothstep(0.35, 1.9, dp)) * (1.0 - smoothstep(0.6, 2.4, uPlayer.y - ground));
vec3 head = vec3(wxz.x, ground + stem * (1.0 - 0.3 * push), wxz.y);
head.xz += uWindDir * sway * stem + toP / max(dp, 0.001) * push * 0.4;
vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
vec3 grassPos = head + (camR * position.x + camU * position.y) * size;
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vFUv = uv;
vKind = aRand.w;
vWallSh = wallShade(grassPos);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = grassPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFUv;\nvarying float vKind;\nvarying float vWallSh;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec2 q = vFUv - 0.5;
float r = length(q) * 2.0;
float a = atan(q.y, q.x);
float petals = 0.62 + 0.38 * cos(a * (vKind > 0.8 ? 6.0 : 5.0));
if (r > petals) discard;
vec3 petal = vKind > 0.86 ? vec3(1.0, 0.86, 0.35) : vec3(1.0);
diffuseColor.rgb = mix(vec3(1.0, 0.72, 0.12), petal, smoothstep(0.22, 0.34, r));`
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.1 * vWallSh;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= mix(0.08, 1.0, vWallSh);\nreflectedLight.indirectDiffuse *= mix(vec3(1.25, 1.4, 1.85), vec3(1.0), vWallSh);');
  };
  mat.customProgramCacheKey = () => 'grass-flowers';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = 'flowers';
  return mesh;
}
