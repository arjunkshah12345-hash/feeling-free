// World layout: the meadow height field, the cliff line, the wall line and the city footprint.
// Everything that needs the ground (terrain mesh, grass, physics, props) reads it from here.
import { noise2, fbm2 } from './noise.js';

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;

// The player rides toward -Z. The white city sits at the far end, the cliff runs along +X.
export const KEEP = { x: -40, z: -1910 };
export const CITY_SCALE = 1.4; // the city is modelled at radius 505 and scaled up about the keep
export const CITY_R = 505 * CITY_SCALE;
export const GATE = { x: KEEP.x, z: KEEP.z + CITY_R };
export const START = { x: 25, z: 170, yaw: 0.06 };
export const BOUNDS = { minX: -660, maxZ: 460, minZ: -1520 };

export function cliffX(z) {
  return 255 + 40 * Math.sin(z * 0.0021 + 0.6) + 18 * Math.sin(z * 0.0063 + 2.1);
}
export function wallX(z) {
  return cliffX(z) - 60 - 9 * Math.sin(z * 0.0047 + 1.3);
}
export function ridgeH(z) {
  return 12 + 70 * smoothstep(-1500, 300, z);
}

// Grass ramps that launch you toward the city (-Z). Each has a lip at z, run-up of length L behind it.
export const KICKERS = [
  { x: -60, z: -150 },
  { x: -205, z: -390 },
  { x: -25, z: -560 },
  { x: -140, z: -770 },
  { x: -325, z: -940 },
  { x: -45, z: -1080 },
  { x: -235, z: -1115 },
].map((k) => ({ ...k, A: 4.2, L: 15, back: 6.5, w: 9 }));

function kickerH(k, x, z) {
  const lat = Math.abs(x - k.x);
  if (lat > k.w) return 0;
  const u = k.z + k.L - z;
  if (u <= 0 || u > k.L + k.back * 4) return 0;
  const lf = 1 - smoothstep(k.w * 0.45, k.w, lat);
  let f;
  if (u <= k.L) {
    const q = u / k.L;
    f = k.A * q * q;
  } else {
    const d = u - k.L;
    f = k.A * Math.exp(-(d * d) / (2 * k.back * k.back));
  }
  return f * lf;
}

export function heightAt(x, z) {
  const dk = Math.hypot(x - KEEP.x, z - KEEP.z);
  const away = smoothstep(CITY_R + 30, CITY_R + 260, dk);
  let h = (8 * fbm2(x * 0.0042, z * 0.0042, 4) + 1.5 * noise2(x * 0.021 + 13.1, z * 0.021 - 7.7)) * (0.3 + 0.7 * away);
  h += Math.max(z + 1420, -300) * 0.011;
  const wx = wallX(z);
  const t = smoothstep(wx - 310, wx + 8, x);
  h += t * t * ridgeH(z);
  const far = smoothstep(-720, -1700, x);
  if (far > 0) h += far * 26 * (fbm2(x * 0.0016 + 3.3, z * 0.0016 - 1.2, 3) + 0.45);
  for (let i = 0; i < KICKERS.length; i++) h += kickerH(KICKERS[i], x, z);
  return h;
}

// Lanterns to find. "air" ones float past a kicker lip and need a launch to reach.
const airLantern = (k, ahead, air) => ({ x: k.x, z: k.z - ahead, air, lipY: () => heightAt(k.x, k.z) });
export const LANTERNS = [
  { x: 20, z: -40 },
  airLantern(KICKERS[0], 9, 3.4),
  { x: -340, z: -210 },
  { x: 118, z: -270 },
  airLantern(KICKERS[1], 10, 3.9),
  { x: -500, z: -540 },
  { x: 70, z: -710 },
  airLantern(KICKERS[3], 10, 4.2),
  { x: -420, z: -880 },
  airLantern(KICKERS[5], 10, 4.4),
  { x: 150, z: -1150 },
  { x: -365, z: -1135 },
];

// Sun shadow of the castle wall on the meadow, traced against the wall line and a
// baked strip of wall-top heights (see buildWalls). 0 = in the wall's shadow.
export const GLSL_WALLSHADOW = /* glsl */ `
uniform vec3 uSunDir;
uniform sampler2D uWallTop;
uniform vec3 uWallSpan; // z0, z1, samples
float ffWallX(float z) {
  float cx = 255.0 + 40.0 * sin(z * 0.0021 + 0.6) + 18.0 * sin(z * 0.0063 + 2.1);
  return cx - 60.0 - 9.0 * sin(z * 0.0047 + 1.3);
}
float wallShade(vec3 p) {
  float s = (ffWallX(p.z) - 2.0 - p.x) / uSunDir.x;
  s = (ffWallX(p.z + s * uSunDir.z) - 2.0 - p.x) / uSunDir.x;
  if (s <= 0.0) return 1.0;
  float zw = p.z + s * uSunDir.z;
  if (zw > uWallSpan.x || zw < uWallSpan.y) return 1.0;
  float k = (uWallSpan.x - zw) / 2.0;
  int ki = int(clamp(floor(k), 0.0, uWallSpan.z - 2.0));
  float t0 = texelFetch(uWallTop, ivec2(ki, 0), 0).r;
  float t1 = texelFetch(uWallTop, ivec2(ki + 1, 0), 0).r;
  float top = mix(t0, t1, clamp(k - float(ki), 0.0, 1.0));
  float yr = p.y + s * uSunDir.y;
  return smoothstep(-1.2, 1.2, yr - top);
}`;
