import * as THREE from 'three';
import { heightAt } from './world.js';

export function glowTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,230,190,0.75)');
  grd.addColorStop(0.45, 'rgba(255,170,90,0.22)');
  grd.addColorStop(1, 'rgba(255,140,60,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Lanterns {
  constructor(scene, list) {
    this.group = new THREE.Group();
    this.group.name = 'lanterns';
    scene.add(this.group);
    const prof = [[0, -0.36], [0.12, -0.35], [0.22, -0.27], [0.28, -0.12], [0.29, 0.02], [0.26, 0.17], [0.17, 0.3], [0.08, 0.35], [0, 0.36]].map(([r, y]) => new THREE.Vector2(r, y));
    const body = new THREE.LatheGeometry(prof, 20);
    const paper = new THREE.MeshStandardMaterial({ color: '#ffc27a', emissive: '#ff8a2a', emissiveIntensity: 2.6, roughness: 0.9, side: THREE.DoubleSide });
    const capMat = new THREE.MeshStandardMaterial({ color: '#3a2140', roughness: 0.6 });
    const cap = new THREE.CylinderGeometry(0.12, 0.14, 0.06, 14);
    const ribGeo = new THREE.TorusGeometry(0.285, 0.008, 4, 28);
    const glowTex = glowTexture();
    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0.22 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform float uAlpha; varying vec2 vUv;
        void main(){ float a = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 2.2) * (0.6 + 0.4 * sin(uTime * 2.0 + vUv.y * 8.0));
        gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a * uAlpha, 1.0); }`,
    });
    this.items = list.map((l, i) => {
      const g = new THREE.Group();
      const baseY = l.air ? l.lipY() + l.air : heightAt(l.x, l.z) + 2.3;
      g.position.set(l.x, baseY, l.z);
      const lantern = new THREE.Group();
      const m = new THREE.Mesh(body, paper);
      m.scale.set(1, 1.15, 1);
      lantern.add(m);
      for (const y of [-0.15, 0.0, 0.15]) {
        const rib = new THREE.Mesh(ribGeo, capMat);
        rib.rotation.x = Math.PI / 2;
        rib.position.y = y * 1.15;
        rib.scale.setScalar(1 - Math.abs(y) * 0.9);
        lantern.add(rib);
      }
      const top = new THREE.Mesh(cap, capMat); top.position.y = 0.42; lantern.add(top);
      const bot = new THREE.Mesh(cap, capMat); bot.position.y = -0.42; lantern.add(bot);
      const tassel = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.03, 0.22, 6), new THREE.MeshStandardMaterial({ color: '#ff4f1a' }));
      tassel.position.y = -0.56;
      lantern.add(tassel);
      g.add(lantern);
      const sMat = new THREE.SpriteMaterial({ map: glowTex, color: '#ffb46a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const glow = new THREE.Sprite(sMat);
      glow.scale.setScalar(3.2);
      g.add(glow);
      const haloMat = sMat.clone();
      haloMat.opacity = 0.35;
      const halo = new THREE.Sprite(haloMat);
      halo.scale.setScalar(9);
      g.add(halo);
      const bm = beamMat.clone();
      bm.uniforms = { uTime: { value: 0 }, uAlpha: { value: 0.22 } };
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.9, 70, 16, 1, true), bm);
      beam.geometry.translate(0, 35, 0);
      beam.position.y = 0.4;
      g.add(beam);
      this.group.add(g);
      return { def: l, g, lantern, glow, halo, beam, baseY, phase: i * 1.37, taken: false, t: 0, gone: false };
    });
    this.count = 0;
    this.total = list.length;
  }

  update(dt, time, center, onTake) {
    for (const it of this.items) {
      if (it.gone) continue;
      if (!it.taken) {
        it.g.position.y = it.baseY + Math.sin(time * 1.6 + it.phase) * 0.18;
        it.lantern.rotation.y = time * 0.6 + it.phase;
        it.lantern.rotation.z = Math.sin(time * 1.1 + it.phase) * 0.08;
        it.beam.material.uniforms.uTime.value = time;
        const s = 3.1 + Math.sin(time * 3 + it.phase) * 0.25;
        it.glow.scale.setScalar(s);
        const d = it.g.position.distanceTo(center);
        // keep the beacon visible from afar, quieter up close
        it.beam.material.uniforms.uAlpha.value = 0.08 + 0.2 * Math.min(1, d / 120);
        it.halo.material.opacity = 0.15 + 0.3 * Math.min(1, d / 200);
        it.halo.scale.setScalar(5 + Math.min(16, d * 0.035));
        if (d < 2.7) {
          it.taken = true;
          it.t = 0;
          this.count++;
          onTake?.(it, this.count);
        }
      } else {
        it.t += dt;
        const k = it.t;
        it.g.position.y += (2 + k * 14) * dt;
        it.lantern.rotation.y += dt * (4 + k * 6);
        const f = Math.max(0, 1 - k / 1.8);
        it.lantern.scale.setScalar(0.4 + 0.6 * f);
        it.glow.material.opacity = f;
        it.halo.material.opacity = f * 0.5;
        it.beam.material.uniforms.uAlpha.value *= Math.exp(-dt * 4);
        if (k > 1.8) { it.gone = true; it.g.visible = false; }
      }
    }
  }

  nearest(p) {
    let best = null, bd = Infinity;
    for (const it of this.items) {
      if (it.taken) continue;
      const d = Math.hypot(it.g.position.x - p.x, it.g.position.z - p.z);
      if (d < bd) { bd = d; best = it; }
    }
    return best ? { x: best.g.position.x, z: best.g.position.z, dist: bd, air: !!best.def.air } : null;
  }

  resetAll() {
    for (const it of this.items) {
      it.taken = false; it.gone = false; it.g.visible = true; it.t = 0;
      it.g.position.y = it.baseY;
      it.lantern.scale.setScalar(1);
      it.glow.material.opacity = 1;
    }
    this.count = 0;
  }
}
