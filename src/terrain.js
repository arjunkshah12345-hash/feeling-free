import * as THREE from 'three';
import { heightAt, GLSL_WALLSHADOW } from './world.js';
import { GLSL_NOISE } from './noise.js';

function axis(spans) {
  const out = [];
  for (const [a, b, step] of spans) {
    for (let v = a; v < b - 1e-6; v += step) out.push(v);
  }
  out.push(spans[spans.length - 1][1]);
  return out;
}

// Painterly meadow colouring shared by terrain and grass blades so the two blend.
export const GLSL_MEADOW = /* glsl */ `
uniform vec3 uGrassA;
uniform vec3 uGrassB;
uniform vec3 uGrassC;
vec3 meadowColor(vec2 p) {
  float big = fbm3(p * 0.0045);
  float mid = fbm3(p * 0.03 + 5.0);
  vec3 c = mix(uGrassA, uGrassB, smoothstep(0.32, 0.68, big * 0.65 + mid * 0.35));
  c = mix(c, uGrassC, smoothstep(0.55, 0.82, mid) * 0.55);
  return c;
}
`;

export function meadowUniforms() {
  return {
    uGrassA: { value: new THREE.Color('#3a8419') },
    uGrassB: { value: new THREE.Color('#80cc34') },
    uGrassC: { value: new THREE.Color('#c6de4e') },
    uFlower: { value: new THREE.Color('#f3f5ff') },
  };
}

export function buildTerrain(shared) {
  const xs = axis([[-4200, -900, 60], [-900, -720, 12], [-720, 480, 3.5], [480, 720, 12]]);
  const zs = axis([[-4600, -2400, 60], [-2400, -1560, 10], [-1560, 520, 3.5], [520, 2600, 40]]);
  const nx = xs.length, nz = zs.length;
  const H = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    for (let i = 0; i < nx; i++) H[j * nx + i] = heightAt(xs[i], z);
  }
  const pos = new Float32Array(nx * nz * 3);
  const nor = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    const j0 = Math.max(0, j - 1), j1 = Math.min(nz - 1, j + 1);
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
      const k = j * nx + i;
      pos[k * 3] = xs[i];
      pos[k * 3 + 1] = H[k];
      pos[k * 3 + 2] = zs[j];
      const dx = (H[j * nx + i1] - H[j * nx + i0]) / (xs[i1] - xs[i0]);
      const dz = (H[j1 * nx + i] - H[j0 * nx + i]) / (zs[j1] - zs[j0]);
      const l = Math.hypot(dx, 1, dz);
      nor[k * 3] = -dx / l;
      nor[k * 3 + 1] = 1 / l;
      nor[k * 3 + 2] = -dz / l;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let o = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mu = meadowUniforms();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mu, { uGrassCenter: shared.uGrassCenter, uGrassRadius: shared.uGrassRadius, uSunDir: shared.uSunDir, uWallTop: shared.uWallTop, uWallSpan: shared.uWallSpan });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNor = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos;
varying vec3 vWNor;
uniform vec3 uFlower;
uniform vec2 uGrassCenter;
uniform float uGrassRadius;
${GLSL_NOISE}
${GLSL_MEADOW}
${GLSL_WALLSHADOW}
vec3 terrainColor(vec3 wp, vec3 nrm) {
  vec2 p = wp.xz;
  vec3 c = meadowColor(p);
  float streak = vnoise(vec2(p.x * 0.09, p.y * 0.012));
  c *= 0.86 + 0.26 * streak;
  // flowers: real dots up close, an averaged tint further away
  float patchN = fbm3(p * 0.018 + 31.0);
  float density = smoothstep(0.42, 0.72, patchN);
  vec2 g = p * 1.4;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float r = hash12(cell);
  vec2 off = vec2(hash12(cell + 7.1), hash12(cell + 3.7)) - 0.5;
  float dotm = smoothstep(0.17, 0.09, length(f - off * 0.6)) * step(1.0 - density * 0.75, r);
  float fw = length(fwidth(g));
  float near = 1.0 - smoothstep(0.25, 0.9, fw);
  float inField = smoothstep(uGrassRadius * 0.5, uGrassRadius * 0.9, length(p - uGrassCenter));
  float flower = mix(density * 0.06, dotm * inField, near);
  c = mix(c, uFlower, clamp(flower, 0.0, 1.0));
  // the ground under the blade field is shaded by the blades
  float dg = length(p - uGrassCenter);
  c *= mix(0.72, 1.0, smoothstep(uGrassRadius * 0.45, uGrassRadius * 0.95, dg));
  float slope = 1.0 - clamp(nrm.y, 0.0, 1.0);
  c *= 1.0 - slope * 0.35;
  return c;
}`
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= terrainColor(vWPos, normalize(vWNor));')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nfloat wsh = wallShade(vWPos);\nreflectedLight.directDiffuse *= mix(0.08, 1.0, wsh);\nreflectedLight.indirectDiffuse *= mix(vec3(1.25, 1.4, 1.85), vec3(1.0), wsh);');
  };
  mat.customProgramCacheKey = () => 'terrain';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

// Height texture used by the grass vertex shader (manual bilinear via texelFetch).
export function buildHeightTexture() {
  const minX = -720, minZ = -1540, sizeX = 1240, sizeZ = 2080, step = 2.5;
  const rx = Math.round(sizeX / step) + 1, rz = Math.round(sizeZ / step) + 1;
  const data = new Float32Array(rx * rz);
  for (let j = 0; j < rz; j++) {
    const z = minZ + (j / (rz - 1)) * sizeZ;
    for (let i = 0; i < rx; i++) data[j * rx + i] = heightAt(minX + (i / (rx - 1)) * sizeX, z);
  }
  const tex = new THREE.DataTexture(data, rx, rz, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return {
    tex,
    bounds: new THREE.Vector4(minX, minZ, sizeX, sizeZ),
    res: new THREE.Vector2(rx, rz),
  };
}
