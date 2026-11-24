import * as THREE from 'three';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Scene -> HDR target, cheap two-level bloom, then a composite pass with
// radial speed blur, grading, vignette, grain and a fade.
export class Post {
  constructor(renderer) {
    this.r = renderer;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.a = new THREE.WebGLRenderTarget(1, 1, opts);
    this.b = new THREE.WebGLRenderTarget(1, 1, opts);
    this.c = new THREE.WebGLRenderTarget(1, 1, opts);
    this.d = new THREE.WebGLRenderTarget(1, 1, opts);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);

    this.bright = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.85 } },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform float uThreshold; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          // never let a stray NaN/Inf pixel into the blur, where it would grow into a block
          if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
          c = clamp(c, 0.0, 64.0);
          float l = max(c.r, max(c.g, c.b));
          float k = smoothstep(uThreshold, uThreshold + 0.6, l);
          gl_FragColor = vec4(c * k, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
          c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
          c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
          c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
          c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.copy = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: FS_VERT,
      fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }',
      depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.scene.texture },
        tBloomA: { value: this.a.texture },
        tBloomB: { value: this.c.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uBlur: { value: 0 },
        uCenter: { value: new THREE.Vector2(0.5, 0.52) },
        uRider: { value: new THREE.Vector2(0.5, 0.3) },
        uRiderR: { value: 0.12 },
        uFade: { value: 1 },
        uFadeColor: { value: new THREE.Color(1, 1, 1) },
        uExposure: { value: 1.0 },
        uBars: { value: 0 },
        uSat: { value: 1.18 },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene, tBloomA, tBloomB;
        uniform vec2 uRes, uCenter, uRider;
        uniform float uTime, uBlur, uFade, uExposure, uBars, uSat, uRiderR;
        uniform vec3 uFadeColor;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
        vec3 toSRGB(vec3 c) {
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        void main() {
          vec2 uv = vUv;
          float aspect = uRes.x / uRes.y;
          vec2 dir = uv - uCenter;
          float rd = length((uv - uRider) * vec2(aspect, 1.0));
          float riderMask = smoothstep(uRiderR, uRiderR * 2.4, rd);
          float edge = smoothstep(0.05, 0.6, length(dir * vec2(aspect, 1.0)));
          float amt = uBlur * riderMask * edge;
          vec3 col;
          if (amt > 0.0005) {
            float j = hash(uv * uRes + fract(uTime) * 61.0);
            col = vec3(0.0);
            for (int i = 0; i < 10; i++) {
              float t = (float(i) + j) / 10.0;
              col += texture2D(tScene, uv - dir * amt * t).rgb;
            }
            col /= 10.0;
          } else {
            col = texture2D(tScene, uv).rgb;
          }
          // slight chromatic fringe at speed toward the edges
          float ca = amt * 0.1;
          col.r = mix(col.r, texture2D(tScene, uv - dir * ca).r, 0.5);
          col.b = mix(col.b, texture2D(tScene, uv + dir * ca).b, 0.5);
          col += texture2D(tBloomA, uv).rgb * 0.28 + texture2D(tBloomB, uv).rgb * 0.32;
          if (any(isnan(col)) || any(isinf(col))) col = vec3(0.5, 0.6, 0.9);
          col *= uExposure;
          col = aces(col);
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, uSat);
          // cool, violet-leaning shadows and warm highlights
          col += vec3(-0.012, -0.004, 0.03) * (1.0 - l) * (1.0 - l);
          col *= mix(vec3(0.97, 0.98, 1.03), vec3(1.03, 1.01, 0.97), smoothstep(0.35, 0.95, l));
          col = clamp(col, 0.0, 1.0);
          // vignette
          vec2 vq = (uv - 0.5) * vec2(aspect, 1.0);
          col *= mix(1.0, 0.78, smoothstep(0.45, 1.05, length(vq)));
          col = toSRGB(col);
          col += (hash(uv * uRes + uTime * 17.0) - 0.5) * 0.022;
          col = mix(col, uFadeColor, uFade);
          float bar = step(uv.y, uBars) + step(1.0 - uBars, uv.y);
          col = mix(col, vec3(0.03, 0.05, 0.16), bar);
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.scene.setSize(w, h);
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    const qw = Math.max(1, Math.floor(w / 8)), qh = Math.max(1, Math.floor(h / 8));
    this.a.setSize(hw, hh); this.b.setSize(hw, hh);
    this.c.setSize(qw, qh); this.d.setSize(qw, qh);
    this.comp.uniforms.uRes.value.set(w, h);
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.r.render(this.fsScene, this.cam);
  }

  render(scene, camera) {
    const r = this.r;
    r.setRenderTarget(this.scene);
    r.render(scene, camera);
    // bloom
    this.bright.uniforms.tSrc.value = this.scene.texture;
    this.pass(this.bright, this.a);
    this.blur.uniforms.tSrc.value = this.a.texture;
    this.blur.uniforms.uDir.value.set(1 / this.a.width, 0);
    this.pass(this.blur, this.b);
    this.blur.uniforms.tSrc.value = this.b.texture;
    this.blur.uniforms.uDir.value.set(0, 1 / this.a.height);
    this.pass(this.blur, this.a);
    this.copy.uniforms.tSrc.value = this.a.texture;
    this.pass(this.copy, this.c);
    this.blur.uniforms.tSrc.value = this.c.texture;
    this.blur.uniforms.uDir.value.set(1.5 / this.c.width, 0);
    this.pass(this.blur, this.d);
    this.blur.uniforms.tSrc.value = this.d.texture;
    this.blur.uniforms.uDir.value.set(0, 1.5 / this.c.height);
    this.pass(this.blur, this.c);
    this.comp.uniforms.uTime.value = performance.now() / 1000;
    this.pass(this.comp, null);
  }
}
