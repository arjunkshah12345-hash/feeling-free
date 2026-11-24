import * as THREE from 'three';
import { installFog } from './fog.js';
import { buildTerrain, buildHeightTexture } from './terrain.js';
import { buildGrass, buildFlowers } from './grass.js';
import { buildSky, buildMountains, buildTrees, SKY } from './sky.js';
import { buildCliff, buildWalls, brickTexture } from './cliff.js';
import { buildCity } from './city.js';
import { Rider, riderShade } from './rider.js';
import { Player, Autopilot, STEP } from './player.js';
import { CameraRig } from './camera.js';
import { Lanterns } from './lanterns.js';
import { buildPollen, Bursts, Birds } from './fx.js';
import { Sound } from './audio.js';
import { Post } from './post.js';
import { START, GATE, KEEP, LANTERNS, heightAt, clamp, smoothstep, wallX } from './world.js';

installFog();

const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const progress = async (p, note) => {
  $('ld-fill').style.width = `${Math.round(p * 100)}%`;
  if (note) $('ld-note').textContent = note;
  await nextFrame();
};

const SUN_DIR = new THREE.Vector3(0.74, 0.37, 0.56).normalize();
const coarse = matchMedia('(pointer: coarse)').matches;
const QUALITY = coarse || navigator.hardwareConcurrency <= 4 ? 0.55 : 1;

async function boot() {
  const canvas = $('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  if (!renderer.capabilities.isWebGL2) throw new Error('This ride needs WebGL2. Try a recent Chrome, Safari, Firefox or Edge.');
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(SKY.fog);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(SKY.fog, 0.0003);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 14000);

  const shared = {
    uTime: { value: 0 },
    uGrassCenter: { value: new THREE.Vector2(START.x, START.z) },
    uGrassRadius: { value: QUALITY < 1 ? 34 : 44 },
    uPlayer: { value: new THREE.Vector3(START.x, 0, START.z) },
    uWindDir: { value: new THREE.Vector2(0.32, 0.95).normalize() },
    uWind: { value: 0.5 },
    uPixelRatio: { value: 1 },
    uSunDir: { value: SUN_DIR.clone() },
    uWallTop: { value: null },
    uWallSpan: { value: new THREE.Vector3(0, 0, 2) },
  };

  // light
  const sun = new THREE.DirectionalLight('#fff1d6', 4.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(QUALITY < 1 ? 1024 : 2048, QUALITY < 1 ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 420;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#8aa2ff', '#7a8f6a', 1.45);
  scene.add(hemi);

  await progress(0.08, 'shaping the meadow');
  const terrain = buildTerrain(shared);
  scene.add(terrain);
  await progress(0.28, 'growing the grass');
  const hm = buildHeightTexture();
  scene.add(buildGrass(shared, hm, QUALITY));
  scene.add(buildFlowers(shared, hm, QUALITY));
  await progress(0.42, 'painting the sky');
  const sky = buildSky(shared, SUN_DIR);
  scene.add(sky);
  scene.add(buildMountains());
  scene.add(buildTrees());
  await progress(0.52, 'raising the cliff');
  scene.add(buildCliff());
  const walls = buildWalls(brickTexture());
  shared.uWallTop.value = walls.shadow.tex;
  shared.uWallSpan.value.set(walls.shadow.z0, walls.shadow.z1, walls.shadow.n);
  // the same sun-vs-wall test the meadow shaders use, for shading the rider
  const wallShadeAt = (x, y, z) => {
    const S = SUN_DIR, W = walls.shadow, d = W.tex.image.data;
    let s = (wallX(z) - 2 - x) / S.x;
    s = (wallX(z + s * S.z) - 2 - x) / S.x;
    if (s <= 0) return 1;
    const zw = z + s * S.z;
    if (zw > W.z0 || zw < W.z1) return 1;
    const k = (W.z0 - zw) / 2;
    const ki = Math.min(W.n - 2, Math.max(0, Math.floor(k)));
    const top = d[ki] + (d[ki + 1] - d[ki]) * clamp(k - ki, 0, 1);
    return smoothstep(-1.2, 1.2, y + s * S.y - top);
  };
  scene.add(walls.group);
  await progress(0.66, 'building the white city');
  const city = buildCity();
  scene.add(city.group);
  await progress(0.82, 'finding a bike');

  const turrets = [...walls.turrets, { x: GATE.x - 27, z: GATE.z + 2, r: 10.5 }, { x: GATE.x + 27, z: GATE.z + 2, r: 10.5 }];
  const player = new Player(turrets);
  const rider = new Rider(scene);
  const rig = new CameraRig(camera);
  const lanterns = new Lanterns(scene, LANTERNS);
  const pollen = buildPollen(shared);
  scene.add(pollen);
  const bursts = new Bursts(scene, shared);
  const birds = new Birds(scene);
  const sound = new Sound();
  const post = new Post(renderer);
  const auto = new Autopilot();
  $('ltotal').textContent = lanterns.total;

  // ---- sizing / dynamic resolution ----
  let scale = 1;
  const maxPR = Math.min(devicePixelRatio || 1, QUALITY < 1 ? 1.25 : 1.75);
  const resize = () => {
    const w = innerWidth, h = innerHeight;
    const pr = maxPR * scale;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    post.setSize(Math.floor(w * pr), Math.floor(h * pr));
    shared.uPixelRatio.value = pr;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  // ---- input ----
  const keys = new Set();
  const input = { pedal: false, brake: false, left: false, right: false, sprint: false, jump: false, steerAxis: 0 };
  const touch = { pedal: false, steer: 0, jump: false };
  let state = 'loading';
  const syncInput = () => {
    input.pedal = keys.has('KeyW') || keys.has('ArrowUp') || touch.pedal;
    input.brake = keys.has('KeyS') || keys.has('ArrowDown');
    input.left = keys.has('KeyA') || keys.has('ArrowLeft');
    input.right = keys.has('KeyD') || keys.has('ArrowRight');
    input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    input.steerAxis = touch.steer;
  };
  addEventListener('keydown', (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (state === 'title' && (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyW' || e.code === 'ArrowUp')) { startRide(); return; }
    if (e.code === 'Space') input.jump = true;
    if (e.code === 'KeyC') rig.mode = (rig.mode + 1) % 2;
    if (e.code === 'KeyM') sound.setMuted(!sound.muted);
    if (e.code === 'KeyR' && state === 'ride') restart();
    if ((e.code === 'Escape' || e.code === 'KeyP') && (state === 'ride' || state === 'paused')) togglePause();
    syncInput();
  });
  addEventListener('keyup', (e) => { keys.delete(e.code); syncInput(); });
  addEventListener('blur', () => { keys.clear(); syncInput(); if (state === 'ride') togglePause(); });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    rig.dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!rig.dragging) return;
    rig.orbitYaw -= e.movementX * 0.006;
    rig.orbitPitch = clamp(rig.orbitPitch - e.movementY * 0.004, -0.15, 0.6);
    rig.idle = 0;
  });
  canvas.addEventListener('pointerup', () => { rig.dragging = false; rig.idle = 0; });

  if (coarse) {
    $('touch').classList.add('on');
    $('touch').classList.remove('hidden');
    const stick = $('stick'), knob = stick.querySelector('i');
    let sid = null;
    const move = (e) => {
      const r = stick.getBoundingClientRect();
      const dx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
      touch.steer = -dx;
      knob.style.transform = `translateX(${dx * 38}px)`;
      syncInput();
    };
    stick.addEventListener('pointerdown', (e) => { sid = e.pointerId; stick.setPointerCapture(sid); move(e); });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) move(e); });
    const end = () => { sid = null; touch.steer = 0; knob.style.transform = ''; syncInput(); };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    const hold = (el, on, off) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('down'); on(); syncInput(); });
      const up = () => { el.classList.remove('down'); off(); syncInput(); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    hold($('t-pedal'), () => (touch.pedal = true), () => (touch.pedal = false));
    hold($('t-jump'), () => (input.jump = true), () => {});
  }

  // ---- ui helpers ----
  let toastTimer = 0;
  const toast = (msg, ms = 2400) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  };
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  // ---- events ----
  player.on('land', (impact, air) => {
    rig.shake(Math.min(0.9, impact * 0.06));
    sound.thump(impact);
    const p = player.pos.clone();
    bursts.emit(p, Math.min(40, 8 + impact * 3), { speed: 2 + impact * 0.3, up: 1.5, color: [0.75, 0.95, 0.45], size: 0.08, life: 0.9, grav: -6, spread: 0.8 });
    bursts.emit(p, 10, { speed: 1.5, up: 2.5, color: [1, 1, 1], size: 0.07, life: 1.4, grav: -1.5, spread: 0.8 });
    if (state === 'ride' && air > 1.1) toast(`${air.toFixed(1)} seconds of air`, 1600);
  });
  player.on('jump', () => sound.whoosh());
  player.on('bump', (s) => { rig.shake(Math.min(0.6, s * 0.04)); sound.thump(s * 0.5); });

  let fade = 1, fadeTarget = 0, fadeCb = null, fadeSpeed = 1.2;
  const fadeTo = (target, speed, cb) => { fadeTarget = target; fadeSpeed = speed; fadeCb = cb || null; };
  let bars = 0.085;
  let rideTime = 0;
  let finished = false;
  let hintTimer = 0;

  const placeAtStart = () => {
    player.reset(START.x, START.z, START.yaw);
    player.speed = 7;
    rider.root.position.copy(player.pos);
    rider.root.rotation.set(0, player.yaw, 0);
    rider.update(0, riderState());
    rider.cape.reset(rider);
    rig.yaw = player.yaw;
    rig.orbitYaw = 0; rig.orbitPitch = 0;
    rig.snap();
  };

  function startRide() {
    if (state !== 'title') return;
    state = 'starting';
    sound.start();
    show('title', false);
    fadeTo(1, 3.5, () => {
      placeAtStart();
      state = 'ride';
      bars = 0;
      show('hud', true);
      $('hint').classList.remove('fade');
      hintTimer = 0;
      fadeTo(0, 1.1);
      canvas.focus();
    });
  }

  function restart() {
    sound.finaleHold = 0;
    fadeTo(1, 4, () => {
      placeAtStart();
      fadeTo(0, 1.5);
    });
  }

  function togglePause() {
    if (state === 'ride') { state = 'paused'; show('pause', true); }
    else if (state === 'paused') { state = 'ride'; show('pause', false); clock.getDelta(); }
  }
  $('resume').addEventListener('click', togglePause);
  $('start').addEventListener('click', startRide);

  function startFinish() {
    state = 'finish';
    finished = true;
    sound.chime(10);
    setTimeout(() => sound.chime(12), 380);
    sound.finale();
    rig.finT = 0;
    fadeTo(0.7, 1.4, () => {
      fadeTo(0.08, 0.3);
      const mins = Math.floor(rideTime / 60), secs = Math.floor(rideTime % 60);
      $('fstats').innerHTML = `
        <div><b>${mins}:${String(secs).padStart(2, '0')}</b><span>ride time</span></div>
        <div><b>${lanterns.count} / ${lanterns.total}</b><span>lanterns</span></div>
        <div><b>${(player.distance / 1000).toFixed(2)} km</b><span>distance</span></div>
        <div><b>${player.maxAir.toFixed(1)} s</b><span>longest air</span></div>`;
      show('finish', true);
      show('hud', false);
    });
  }
  $('again').addEventListener('click', () => {
    show('finish', false);
    sound.finaleHold = 0;
    player.reset(GATE.x, GATE.z + 40, Math.PI);
    player.speed = 6;
    rider.root.position.copy(player.pos);
    rider.cape.reset(rider);
    rig.yaw = player.yaw; rig.snap();
    state = 'ride';
    show('hud', true);
    fadeTo(0, 1.2);
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'ride') togglePause(); });

  // ---- per-frame state ----
  const windVec = new THREE.Vector3();
  const riderState = () => ({
    speed: player.speed,
    crank: player.crank,
    steer: player.steer,
    airborne: !player.grounded,
    sprint: player.sprinting,
    effort: player.effort,
    look: 0,
    // a steady crosswind from the left so the cape streams out to the side, as in the clip
    wind: windVec.clone().sub(player.vel).add(new THREE.Vector3(Math.cos(player.yaw), 0.08, -Math.sin(player.yaw)).multiplyScalar(1.5 + Math.abs(player.speed) * 0.28)),
  });

  const clock = { last: performance.now(), getDelta() { const n = performance.now(); const d = (n - this.last) / 1000; this.last = n; return d; } };
  let acc = 0;
  let time = 0;
  let hudT = 0;
  let perfT = 0, perfN = 0, perfSum = 0;
  const tmp = new THREE.Vector3();
  const noInput = { pedal: false, brake: true, left: false, right: false, sprint: false, jump: false, steerAxis: 0 };

  // starting point for the title flythrough
  player.reset(-40, 60, 0);
  player.speed = 12;
  rider.root.position.copy(player.pos);
  rider.update(0, riderState());
  rig.snap();

  const frame = () => {
    requestAnimationFrame(frame);
    let dt = Math.min(clock.getDelta(), 0.05);
    if (state === 'paused') dt = 0;
    time += dt;
    shared.uTime.value = time;
    perfSum += dt; perfN++; perfT += dt;

    const gust = 0.5 + 0.5 * Math.sin(time * 0.6) * Math.sin(time * 0.23 + 1.0);
    shared.uWind.value = 0.4 + 0.35 * gust;
    const wd = shared.uWindDir.value;
    windVec.set(wd.x, 0, wd.y).multiplyScalar(2.2 + gust * 3);

    let inp;
    if (state === 'title' || state === 'loading' || state === 'starting') inp = auto.input(player);
    else if (state === 'ride') inp = input;
    else inp = noInput;
    if (dt > 0) {
      acc += dt;
      while (acc >= STEP) {
        player.step(STEP, inp);
        inp.jump = false;
        input.jump = false;
        acc -= STEP;
      }
    }

    rider.root.position.copy(player.pos);
    rider.root.rotation.set(0, player.yaw, 0);
    rider.body.rotation.set(player.pitch, 0, player.lean);
    rider.root.updateMatrixWorld(true);
    riderShade.value += (wallShadeAt(player.pos.x, player.pos.y + 1.2, player.pos.z) - riderShade.value) * Math.min(1, dt * 10);
    if (dt > 0) rider.update(dt, riderState());

    const fwd = player.forward;
    shared.uGrassCenter.value.set(player.pos.x + fwd.x * 16, player.pos.z + fwd.z * 16);
    shared.uPlayer.value.copy(player.pos);

    // camera
    if (state === 'ride' || state === 'paused') rig.updateChase(dt, player);
    else if (state === 'finish') rig.updateFinish(dt, player, KEEP, GATE);
    else rig.updateCinematic(dt, player);
    sky.position.copy(camera.position);

    // sun + shadow frustum follow the rider, snapped to texels
    const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
    tmp.copy(player.pos).addScaledVector(fwd, 18);
    tmp.x = Math.round(tmp.x / texel) * texel;
    tmp.z = Math.round(tmp.z / texel) * texel;
    sun.target.position.copy(tmp);
    sun.position.copy(tmp).addScaledVector(SUN_DIR, 200);
    sun.target.updateMatrixWorld();

    // world animation
    city.update(time);
    birds.update(time);
    bursts.update(dt);
    if (state === 'ride') {
      rideTime += dt;
      const center = tmp.copy(player.pos).add(new THREE.Vector3(0, 1.1, 0));
      lanterns.update(dt, time, center, (it, n) => {
        sound.chime(n - 1);
        bursts.emit(it.g.position, 70, { speed: 6, up: 2, color: [1.6, 1.05, 0.45], size: 0.1, life: 1.6, grav: -2 });
        bursts.emit(it.g.position, 30, { speed: 2, up: 4, color: [1.4, 1.3, 1.1], size: 0.06, life: 2.4, grav: 0.5 });
        const el = $('hud-lanterns');
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
        $('lcount').textContent = n;
        if (n === lanterns.total) toast('every lantern found. now, the white city', 3600);
        else toast(`lantern ${n} of ${lanterns.total}`);
      });
      // finish once per visit: after "Keep riding" the gate re-arms only once
      // the rider has ridden well clear of it
      if (finished && Math.hypot(player.pos.x - GATE.x, player.pos.z - GATE.z) > 120) finished = false;
      if (!finished && player.atGate() && player.speed > -1) startFinish();
    } else {
      lanterns.update(0, time, tmp.set(0, -1e5, 0), null);
    }
    if (dt > 0) sound.update(dt, player.speed, player.pedaling, !player.grounded);

    // hud
    hudT += dt;
    if (state === 'ride' && hudT > 0.1) {
      hudT = 0;
      $('kmh').textContent = Math.round(Math.abs(player.speed) * 3.6);
      const tgt = lanterns.nearest(player.pos);
      let tx, tz, label;
      if (tgt) { tx = tgt.x; tz = tgt.z; label = tgt.air ? 'lantern · catch air' : 'nearest lantern'; }
      else { tx = GATE.x; tz = GATE.z; label = 'the white city'; }
      const dx = tx - camera.position.x, dz = tz - camera.position.z;
      const cf = new THREE.Vector3(); camera.getWorldDirection(cf);
      const cyaw = Math.atan2(-cf.x, -cf.z);
      const rx = Math.cos(cyaw), rz = -Math.sin(cyaw);
      const ang = Math.atan2(dx * rx + dz * rz, dx * cf.x + dz * cf.z);
      $('chev').style.transform = `rotate(${ang}rad)`;
      $('cdist').textContent = `${Math.round(Math.hypot(tx - player.pos.x, tz - player.pos.z))} m`;
      $('clabel').textContent = label;
      hintTimer += 0.1;
      if (hintTimer > 10) $('hint').classList.add('fade');
    }

    // fade
    if (fade !== fadeTarget) {
      const d = fadeTarget - fade;
      const step = fadeSpeed * dt;
      fade = Math.abs(d) <= step ? fadeTarget : fade + Math.sign(d) * step;
      if (fade === fadeTarget && fadeCb) { const cb = fadeCb; fadeCb = null; cb(); }
    }

    // post params
    const sp = Math.abs(player.speed);
    const blurT = Math.pow(clamp((sp - 5) / 17, 0, 1), 1.3) * 0.085 + (player.sprinting ? 0.025 : 0);
    const u = post.comp.uniforms;
    u.uBlur.value += (blurT - u.uBlur.value) * Math.min(1, dt * 4);
    const rp = tmp.copy(player.pos).add(new THREE.Vector3(0, 1.0, 0));
    const dcam = rp.distanceTo(camera.position);
    rp.project(camera);
    u.uRider.value.set(rp.x * 0.5 + 0.5, rp.y * 0.5 + 0.5);
    u.uRiderR.value = clamp(0.5 / Math.max(dcam, 0.5), 0.05, 0.3);
    const foe = tmp.copy(player.pos).addScaledVector(fwd, 200).add(new THREE.Vector3(0, 2, 0)).project(camera);
    u.uCenter.value.set(clamp(foe.x * 0.5 + 0.5, 0.15, 0.85), clamp(foe.y * 0.5 + 0.5, 0.2, 0.85));
    u.uFade.value = fade;
    const barsT = state === 'title' || state === 'starting' || state === 'loading' || state === 'finish' ? 0.085 : 0;
    bars += (barsT - bars) * Math.min(1, dt * 2);
    u.uBars.value = bars;

    post.render(scene, camera);

    // adapt resolution every couple of seconds
    if (perfT > 2.5) {
      const avg = perfSum / perfN;
      if (avg > 1 / 42 && scale > 0.6) { scale = Math.max(0.6, scale - 0.12); resize(); }
      else if (avg < 1 / 57 && scale < 1) { scale = Math.min(1, scale + 0.06); resize(); }
      perfT = 0; perfSum = 0; perfN = 0;
    }
  };

  await progress(0.92, 'warming up');
  renderer.compile(scene, camera);
  await progress(1, 'ready');
  state = 'title';
  show('loading', false);
  show('title', true);
  fadeTo(0, 0.8);
  clock.getDelta();
  frame();

  window.__ff = { sound,
    THREE, scene, camera, renderer, player, rider, rig, lanterns, post, shared, startRide, input, heightAt,
    get state() { return state; },
    setState: (s) => (state = s),
    setFade: (v) => { fade = fadeTarget = v; },
    setScale: (s) => { scale = s; resize(); },
  };
}

boot().catch((err) => {
  console.error(err);
  $('errmsg').textContent = err?.message || String(err);
  show('loading', false);
  $('err').classList.remove('hidden');
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
});
