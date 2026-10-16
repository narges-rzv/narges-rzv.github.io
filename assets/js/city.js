/* City mode: a neon night-time Midtown Manhattan where each section is a landmark.
   Pick one, a route lights up along the street grid, you travel there and the section opens beside it.
   Loaded on demand by site.js. Runs entirely in the browser (three.js from a CDN, no API keys). */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Map units: avenues run north-south (x), streets east-west (z). North is -z.
const AV = 7, ST = 2.4, AVW = 0.7, STW = 0.35; // spacing and half-widths of avenues and streets
const ax = (i) => i * AV;                 // 0 = 8th Ave, 1 = 7th, 2 = 6th, 3 = 5th, 4 = Madison, 5 = Park, 6 = Lexington
const sz = (n) => -(n - 30) * ST;         // street number -> z
const AVES = [-2, 9], STREETS = [22, 72]; // extent of the grid (10th Ave .. 1st Ave, 22nd .. 72nd St)
const BROADWAY = [[ax(3), 23], [ax(2), 34], [ax(1), 45], [ax(0), 59], [ax(-1), 66], [ax(-2), 73]]; // [x, street]
const START = [ax(2), sz(38)];           // 6th Ave & 38th St
const FOG = 0.0105;

const SECTIONS = {
  about: { label: "About", place: "Empire State Building", src: ".hero-text", color: "#ff2e88" },
  research: { label: "Research", place: "Chrysler Building", src: "#research > .wrap", color: "#b15cff" },
  publications: { label: "Publications", place: "Public Library", src: "#publications > .wrap", color: "#00e5ff" },
  teaching: { label: "Teaching", place: "Grand Central", src: "#teaching > .wrap", color: "#ffb000" },
  contact: { label: "Contact", place: "Times Square", src: "#contact > .wrap", color: "#39ff88" },
};

const $ = (s, el = document) => el.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })(); // same city every visit
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const broadwayX = (n) => {
  for (let i = 0; i < BROADWAY.length - 1; i++) {
    const [x0, n0] = BROADWAY[i], [x1, n1] = BROADWAY[i + 1];
    if (n <= n1 || i === BROADWAY.length - 2) return x0 + (x1 - x0) * (n - n0) / (n1 - n0);
  }
};
const zToStreet = (z) => 30 - z / ST;

let ui, world, active = false, current = null, busy = false, journey = 0;
const homes = new Map();

// ------------------------------------------------------------------ public API
export const isActive = () => active;
export async function toggle() { active ? exit() : await enter(); }

export async function enter() {
  active = true;
  if (!ui) buildUI();
  document.documentElement.classList.add("city-on");
  $("main").inert = $("footer").inert = true;
  ui.root.hidden = false;
  requestAnimationFrame(() => ui.root.classList.add("shown"));
  setPressed(true);
  if (!world) {
    ui.root.classList.add("loading");
    await ui.cssReady;
    world = await createWorld(ui.canvas).catch((e) => { console.error(e); return null; });
    ui.root.classList.remove("loading");
  }
  if (!world) { ui.root.classList.add("no-gl"); return; }
  world.start();
}

export function exit() {
  active = false;
  journey++;
  busy = false;
  closePanel();
  world?.reset();
  document.documentElement.classList.remove("city-on");
  $("main").inert = $("footer").inert = false;
  ui.root.classList.remove("shown");
  setPressed(false);
  setTimeout(() => { if (!active) { ui.root.hidden = true; world?.stop(); } }, 400);
}

function setPressed(on) {
  const b = $(".city-toggle");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Back to the regular site" : "City mode";
}

// ------------------------------------------------------------------ DOM
function buildUI() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../css/city.css", import.meta.url).href;
  const cssReady = new Promise((r) => { link.onload = link.onerror = r; });
  document.head.append(link);

  const root = document.createElement("div");
  root.className = "city";
  root.hidden = true;
  root.innerHTML = `
    <canvas class="city-canvas" aria-hidden="true"></canvas>
    <svg class="city-leader" aria-hidden="true"><polyline fill="none"/><circle r="5"/><circle class="ping" r="5"/></svg>
    <div class="city-hud"><span>Midtown · Manhattan</span><span class="city-hint">Pick a destination. Drag to look around.</span></div>
    <nav class="city-dest" aria-label="Destinations">
      ${Object.entries(SECTIONS).map(([id, s]) => `<button type="button" data-id="${id}" style="--c:${s.color}"><b>${s.label}</b><small>${s.place}</small></button>`).join("")}
    </nav>
    <section class="city-panel" tabindex="-1" hidden>
      <header class="city-panel-head">
        <span class="city-arrived"></span>
        <button type="button" class="city-back">← Back to map</button>
      </header>
      <div class="city-panel-body"></div>
    </section>`;
  document.body.append(root);
  ui = { root, cssReady, canvas: $(".city-canvas", root), panel: $(".city-panel", root), body: $(".city-panel-body", root), leader: $(".city-leader", root) };

  $(".city-dest", root).addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.id); });
  $(".city-back", root).addEventListener("click", () => back());
  ui.body.addEventListener("click", (e) => {
    if (current === "research" && e.target.closest(".theme")) setTimeout(() => go("publications"), 0);
  });
  $(".brand").addEventListener("click", (e) => { if (active) { e.preventDefault(); back(); } });
  document.addEventListener("keydown", (e) => {
    if (!active || e.key !== "Escape") return;
    current ? back() : exit();
  });
}

function setBusy(on) {
  busy = on;
  ui.root.classList.toggle("busy", on);
}

async function go(id) {
  if (busy || !world || id === current) return;
  const token = ++journey;
  setBusy(true);
  ui.root.querySelectorAll(".city-dest button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
  closePanel();
  const ok = await world.travel(id, () => token === journey);
  if (!ok || token !== journey) return;
  openPanel(id);
  setBusy(false);
}

async function back() {
  if (!current && !busy) return;
  const token = ++journey;
  closePanel();
  ui.root.querySelectorAll(".city-dest button").forEach((b) => b.removeAttribute("aria-current"));
  setBusy(true);
  await world?.overview(() => token === journey);
  if (token === journey) setBusy(false);
}

function openPanel(id) {
  const s = SECTIONS[id], el = document.querySelector(s.src);
  if (!el) return;
  homes.set(id, { el, parent: el.parentNode, next: el.nextSibling });
  ui.body.append(el);
  current = id;
  const { panel, root } = ui;
  panel.style.setProperty("--c", s.color);
  root.style.setProperty("--c", s.color);
  $(".city-arrived", panel).textContent = `◉ Arrived · ${s.place}`;
  panel.hidden = false;
  panel.classList.remove("boot");
  void panel.offsetWidth;
  panel.classList.add("boot");
  panel.scrollTop = 0;
  root.classList.add("open");
  panel.focus({ preventScroll: true });
}

function closePanel() {
  if (!ui || !current) return;
  const home = homes.get(current);
  if (home) home.parent.insertBefore(home.el, home.next);
  current = null;
  ui.panel.hidden = true;
  ui.root.classList.remove("open");
}

// The panel sits on the right (wide screens) or as a bottom sheet (narrow), and the camera shifts to keep
// the landmark centred in the space that is left.
function panelInset() {
  const w = innerWidth, h = innerHeight;
  return w >= 820 ? { x: Math.min(600, w * 0.46) + 24, y: 0 } : { x: 0, y: Math.round(h * 0.56) };
}

// ------------------------------------------------------------------ the city
const SHADER_COMMON = `
  float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  vec3 fogged(vec3 c, vec3 wp) {
    float d = length(wp - cameraPosition) * ${FOG};
    return mix(c, uFog, 1. - exp(-d * d));
  }`;

function buildingMaterial(fog) {
  return new THREE.ShaderMaterial({
    uniforms: { uFog: { value: fog }, uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vWorld; varying vec3 vNormal;
      void main() {
        #ifdef USE_INSTANCING
          mat4 m = modelMatrix * instanceMatrix;
        #else
          mat4 m = modelMatrix;
        #endif
        vec4 wp = m * vec4(position, 1.);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(m) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uFog; uniform float uTime;
      varying vec3 vWorld; varying vec3 vNormal;
      ${SHADER_COMMON}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 col = vec3(.006, .008, .02);
        if (abs(n.y) < .5) {
          float u = abs(n.x) > .5 ? vWorld.z : vWorld.x;
          vec2 cell = vec2(u / .3, vWorld.y / .42);
          vec2 f = fract(cell), id = floor(cell);
          float win = step(.2, f.x) * step(f.x, .75) * step(.25, f.y) * step(f.y, .78);
          float face = floor(dot(n, vec3(1., 0., 2.)) + 3.);
          float r = hash(vec3(id, face + floor(vWorld.x * .25) * 3.1 + floor(vWorld.z * .9) * 7.3));
          float lit = step(.8, r) * step(.3, vWorld.y);
          vec3 warm = vec3(1., .62, .26), cool = vec3(.35, .62, 1.);
          vec3 wc = mix(warm, cool, step(.75, hash(vec3(id.yx, face))));
          col += win * lit * wc * (.12 + .38 * hash(vec3(id, 9.)));
          col += win * (1. - lit) * vec3(.008, .012, .03);
          col += vec3(.05, .012, .09) * exp(-vWorld.y * .9); // street glow on the lower floors
        }
        gl_FragColor = vec4(fogged(col, vWorld), 1.);
      }`,
  });
}

async function createWorld(canvas) {
  await document.fonts.load('600 64px "Chakra Petch"').catch(() => {});
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  const fog = new THREE.Color("#04060e");
  const scene = new THREE.Scene();
  scene.background = fog.clone();
  scene.fog = new THREE.FogExp2(fog, FOG);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 600);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new THREE.Vector2(256, 256);
  const bloomPass = new UnrealBloomPass(bloom, 0.85, 0.55, 0.62);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  const time = { value: 0 };
  const bmat = buildingMaterial(fog);
  bmat.uniforms.uTime = time;
  const neon = (hex, k = 2.2) => new THREE.Color(hex).multiplyScalar(k);
  const lineMat = (hex, k, opacity = 1) => new THREE.LineBasicMaterial({ color: neon(hex, k), transparent: opacity < 1, opacity });

  // ---------------- landmarks
  const reserved = [];   // { r: [x0, x1, z0, z1], id, soft }: footprints that buildings and routes avoid (soft: a route may enter its own)
  const landmarks = {};
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); return g; };
  const cyl = (rt, rb, h, x, y, z, seg = 16) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y + h / 2, z); return g; };

  function landmark(id, { parts, glow = [], glowK = 2.6, at, door, look, cam, reserve, hard, extra }) {
    const color = SECTIONS[id].color;
    const group = new THREE.Group();
    group.position.set(at[0], 0, at[1]);
    for (const g of parts) {
      group.add(new THREE.Mesh(g, bmat));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), lineMat(color, 1.6));
      group.add(edges);
    }
    for (const g of glow) group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: neon(color, glowK) })));
    extra?.(group, color);
    scene.add(group);
    group.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(group);
    const top = new THREE.Vector3(at[0], bb.max.y, at[1]);

    // A light beam and a floating label
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.3, 70, 12, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: neon(color, 1) }, uTime: time },
      vertexShader: `varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; varying float vY;
        void main() { float a = pow(1. - vY, 3.) * (.22 + .06 * sin(uTime * 2. + vY * 20.)); gl_FragColor = vec4(uColor * a, a); }`,
    }));
    beam.position.set(at[0], bb.max.y + 35, at[1]);
    scene.add(beam);
    const label = makeLabel(SECTIONS[id].label, SECTIONS[id].place, color);
    label.position.set(at[0], bb.max.y + 4.2, at[1]);
    label.userData.id = id;
    scene.add(label);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(bb.max.x - bb.min.x + 1, bb.max.y + 2, bb.max.z - bb.min.z + 1), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set((bb.max.x + bb.min.x) / 2, bb.max.y / 2, (bb.max.z + bb.min.z) / 2);
    hit.userData.id = id;
    scene.add(hit);

    for (const r of reserve || [[bb.min.x - 0.2, bb.max.x + 0.2, bb.min.z - 0.2, bb.max.z + 0.2]]) reserved.push({ r, id, soft: true });
    for (const r of hard || []) reserved.push({ r, id, soft: false });
    landmarks[id] = { group, label, beam, hit, door: new THREE.Vector3(door[0], 0, door[1]), top,
      look: new THREE.Vector3(...look), cam: new THREE.Vector3(...cam), color };
  }

  // About: Empire State Building (5th Ave & 34th)
  {
    const [x, z] = [17.6, sz(33)];
    landmark("about", {
      at: [x, z], door: [ax(3), sz(34)], look: [x, 17, z], cam: [x + 27, 23, z + 34],
      parts: [box(5.2, 3, 4.2, 0, 0, 0), box(3.4, 16, 2.8, 0, 3, 0), box(2.6, 4, 2.2, 0, 19, 0), box(1.8, 3, 1.5, 0, 23, 0), box(1.2, 2.2, 1.1, 0, 26, 0)],
      glow: [cyl(0.42, 0.5, 2.6, 0, 28.2, 0, 12), cyl(0.05, 0.1, 4.5, 0, 30.8, 0, 6)],
    });
  }
  // Research: Chrysler Building (Lexington & 42nd)
  {
    const [x, z] = [44.4, sz(42.5)];
    const crown = [];
    for (let i = 0; i < 6; i++) crown.push(cyl(0.95 - i * 0.14, 1.05 - i * 0.14, 0.8, 0, 21.5 + i * 0.8, 0, 8));
    landmark("research", {
      at: [x, z], door: [ax(6), sz(42)], look: [x, 15.5, z], cam: [x - 17, 20, z + 33],
      parts: [box(3.4, 4, 2.2, 0, 0, 0), box(2.2, 17.5, 1.9, 0, 4, 0), ...crown],
      glow: [new THREE.ConeGeometry(0.22, 4.4, 8).translate(0, 28.5, 0)],
    });
  }
  // Publications: New York Public Library with Bryant Park (5th Ave & 41st)
  {
    const [x, z] = [18.9, sz(41)];
    const cols = [];
    for (let i = 0; i < 6; i++) cols.push(cyl(0.09, 0.09, 1.7, 1.75, 0.35, -1.1 + i * 0.44, 8));
    landmark("publications", {
      at: [x, z], door: [ax(3), sz(41)], look: [x - 0.5, 1.2, z], cam: [x + 11, 12, z + 9],
      parts: [box(3.2, 2.4, 4.4, 0, 0, 0), box(0.6, 0.35, 2.8, 1.85, 0, 0), box(0.5, 0.45, 2.9, 1.8, 2.05, 0)],
      glow: cols,
      reserve: [[14.6, 20.6, sz(42) + 0.3, sz(40) - 0.3]],
      extra(group, color) {
        // Bryant Park, lit with strings of lights
        const park = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 4.4), new THREE.MeshBasicMaterial({ color: "#0b3a22" }));
        park.rotation.x = -Math.PI / 2;
        park.position.set(-2.9, 0.03, 0);
        group.add(park);
        const pts = [];
        for (let i = 0; i < 70; i++) pts.push(-2.9 + (rng() - 0.5) * 3, 0.5 + rng() * 0.6, (rng() - 0.5) * 4.2);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: neon("#ffd28a", 1.6), size: 0.14 })));
      },
    });
  }
  // Teaching: Grand Central with the MetLife tower behind (Park Ave & 42nd)
  {
    const [x, z] = [ax(5), sz(43)];
    landmark("teaching", {
      at: [x, z], door: [ax(5), sz(42)], look: [x, 5, z - 2], cam: [x + 7, 15, z + 21], glowK: 1.3,
      parts: [box(5.4, 3.2, 3.6, 0, 0, 0), box(2, 1, 3, 0, 3.2, 0), box(4.4, 14, 1.6, 0, 0, -3.7)],
      glow: [
        ...[-1.5, 0, 1.5].map((dx) => box(0.7, 1.9, 0.05, dx, 0.7, 1.82)),
        cyl(0.42, 0.42, 0.06, 0, 0, 0, 24).rotateX(Math.PI / 2).translate(0, 3.55, 1.84),
      ],
      reserve: [[x - 2.9, x + 2.9, z - 4.6, z + 1.9]],
    });
  }
  // Contact: Times Square (7th Ave & Broadway, 42nd-47th)
  {
    const [x, z] = [ax(1), sz(42.55)];
    const towers = [], boards = [];
    const sides = [[-1.6, 9.5], [1.6, 8.5]];
    for (const [dx, h] of sides) for (const n of [43.5, 45.5]) {
      towers.push(box(1.6, h + (n > 44 ? 1.5 : 0), 1.8, dx * 1.05, 0, sz(n) - z));
      for (let k = 0; k < 2; k++) boards.push({ x: dx > 0 ? dx * 1.05 - 0.82 : dx * 1.05 + 0.82, y: 3 + k * 2.6, z: sz(n) - z, flip: dx > 0, w: 1.6, h: 2.2 });
    }
    landmark("contact", {
      at: [x, z], door: [ax(1), sz(44)], look: [x, 6, z - 6], cam: [x + 3, 6.5, z + 13],
      parts: [box(1.1, 10, 1.3, 0, 0, 0), ...towers],
      glow: [new THREE.SphereGeometry(0.35, 16, 12).translate(0, 10.6, 0)],
      reserve: [[x - 3.2, x + 3.2, sz(47.5), z + 0.8]],
      hard: [[x - 0.65, x + 0.65, z - 0.75, z + 0.75]], // One Times Square stands in the middle of 7th Ave
      extra(group) {
        for (const b of boards) group.add(billboard(b, time));
        for (let k = 0; k < 3; k++) group.add(billboard({ x: 0, y: 2.2 + k * 2.3, z: 0.67, w: 1.05, h: 2, face: "south" }, time));
        const hello = contactBoard();
        hello.position.set(-1.6 * 1.05 + 0.82, 9.3, sz(45.5) - z);
        hello.rotation.y = Math.PI / 2;
        group.add(hello);
      },
    });
  }

  // ---------------- generic buildings
  const lots = [];
  const inRect = (x0, x1, z0, z1) => reserved.some(({ r: [a, b, c, d] }) => x0 < b && x1 > a && z0 < d && z1 > c);
  // Sight lines run from each landmark's base to its camera, so even low facades stay visible.
  const views = Object.values(landmarks).map((l) => [l.look.clone().setY(0.5), l.cam]);
  for (let i = AVES[0]; i < AVES[1]; i++) for (let n = STREETS[0]; n < STREETS[1]; n++) {
    const bx0 = ax(i) + AVW, bx1 = ax(i + 1) - AVW, bz0 = sz(n + 1) + STW, bz1 = sz(n) - STW;
    if (n >= 59 && i >= 0 && i < 3) continue; // Central Park
    let k = 1 + Math.floor(rng() * 3), x = bx0;
    const weights = Array.from({ length: k }, () => 0.6 + rng()), sum = weights.reduce((a, b) => a + b, 0);
    for (const wgt of weights) {
      let x0 = x + 0.08, x1 = x + (bx1 - bx0) * wgt / sum - 0.08;
      x += (bx1 - bx0) * wgt / sum;
      // Broadway cuts diagonally through the grid
      const bw = broadwayX(n + 0.5);
      if (bw > x0 - 0.9 && bw < x1 + 0.9) {
        if (bw - 0.9 - x0 > x1 - (bw + 0.9)) x1 = bw - 0.9; else x0 = bw + 0.9;
      }
      if (x1 - x0 < 0.7) continue;
      if (inRect(x0, x1, bz0, bz1)) continue;
      const cx = (x0 + x1) / 2, cz = (bz0 + bz1) / 2;
      const core = Math.exp(-(((cx - 24) / 34) ** 2 + ((n - 47) / 16) ** 2));
      let h = 1.2 + (2 + 6 * core) * Math.pow(rng(), 1.7);
      if (rng() < 0.04 + 0.08 * core) h = 8 + 9 * rng();                            // office towers
      if (n >= 56 && n <= 57 && i >= -1 && i < 3 && rng() < 0.4) h = 18 + 8 * rng();  // Billionaires' Row
            // Keep sight lines to every landmark clear
      for (const [a, b] of views) {
        const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cz - a.z) * dz) / len2));
        const d = Math.hypot(a.x + dx * t - cx, a.z + dz * t - cz);
        if (d < Math.max(x1 - x0, bz1 - bz0) / 2 + 1.2) h = Math.min(h, Math.max(0.6, a.y + (b.y - a.y) * t - 2.2));
      }
      lots.push([cx, cz, x1 - x0, bz1 - bz0, h]);
    }
  }
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const city = new THREE.InstancedMesh(unit, bmat, lots.length);
  const m = new THREE.Matrix4();
  const roof = [], roofColor = [];
  const roofHues = [neon("#00e5ff", 0.55), neon("#ff2e88", 0.5), neon("#7d8bff", 0.45)];
  lots.forEach(([cx, cz, w, d, h], i) => {
    city.setMatrixAt(i, m.makeScale(w, h, d).setPosition(cx, 0, cz));
    if (h < 4 && rng() < 0.6) return;
    const c = roofHues[(rng() * roofHues.length) | 0].clone().multiplyScalar(Math.min(1.4, h / 10));
    const [a, b, e, f] = [cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2];
    roof.push(a, h, e, b, h, e, b, h, e, b, h, f, b, h, f, a, h, f, a, h, f, a, h, e);
    for (let k = 0; k < 8; k++) roofColor.push(c.r, c.g, c.b);
  });
  scene.add(city);
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute("position", new THREE.Float32BufferAttribute(roof, 3));
  roofGeo.setAttribute("color", new THREE.Float32BufferAttribute(roofColor, 3));
  scene.add(new THREE.LineSegments(roofGeo, new THREE.LineBasicMaterial({ vertexColors: true })));

  // Central Park trees
  {
    const trees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: "#0e3a24" }), 520);
    const c = new THREE.Color();
    for (let i = 0; i < 520; i++) {
      const s = 0.6 + rng() * 0.9;
      trees.setMatrixAt(i, m.makeScale(s, s * 1.2, s).setPosition(ax(0) + AVW + rng() * (ax(3) - 2 * AVW), 0.4 * s, sz(59.3) - rng() * (sz(59.3) - sz(STREETS[1]))));
      trees.setColorAt(i, c.setHSL(0.36 + rng() * 0.08, 0.6, 0.06 + rng() * 0.06));
    }
    scene.add(trees);
  }

  // ---------------- ground: streets, Broadway, the park, the rivers
  {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShaderMaterial({
      uniforms: { uFog: { value: fog }, uTime: time, uBway: { value: BROADWAY.map(([x, n]) => new THREE.Vector2(x, sz(n))) } },
      vertexShader: `varying vec3 vWorld; void main() { vec4 wp = modelMatrix * vec4(position, 1.); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `
        uniform vec3 uFog; uniform float uTime; uniform vec2 uBway[${BROADWAY.length}];
        varying vec3 vWorld;
        ${SHADER_COMMON}
        float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.)); }
        void main() {
          vec2 p = vWorld.xz;
          vec3 col = vec3(.004, .005, .012);
          float ax = abs(p.x / ${AV.toFixed(1)} - floor(p.x / ${AV.toFixed(1)} + .5)) * ${AV.toFixed(1)};
          float sz = abs(p.y / ${ST.toFixed(1)} - floor(p.y / ${ST.toFixed(1)} + .5)) * ${ST.toFixed(1)};
          float street = max(step(ax, ${AVW.toFixed(2)}), step(sz, ${STW.toFixed(2)}));
          col = mix(col, vec3(.012, .014, .03), street);
          col += vec3(.5, .1, .9) * .22 * exp(-ax * ax * 60.) * step(ax, ${AVW.toFixed(2)});   // avenue centre lines
          col += vec3(.1, .5, 1.) * .1 * exp(-sz * sz * 160.) * step(sz, ${STW.toFixed(2)});
          float bw = 1e3;
          for (int i = 0; i < ${BROADWAY.length - 1}; i++) bw = min(bw, seg(p, uBway[i], uBway[i + 1]));
          col = mix(col, vec3(.02, .015, .03), step(bw, .9));
          col += vec3(1., .35, .7) * .35 * exp(-bw * bw * 10.);
          // Times Square glow
          vec2 ts = p - vec2(${ax(1).toFixed(1)}, ${sz(45).toFixed(1)});
          col += vec3(.3, 1., .6) * .12 * exp(-dot(ts, ts) * .05) + vec3(1., .2, .6) * .08 * exp(-dot(ts - vec2(0., 4.), ts - vec2(0., 4.)) * .08);
          // Central Park
          float park = step(${(ax(0) + AVW).toFixed(2)}, p.x) * step(p.x, ${(ax(3) - AVW).toFixed(2)}) * step(p.y, ${(sz(59) - STW).toFixed(2)});
          col = mix(col, vec3(.004, .022, .012), park);
          // Rivers with neon reflections
          float river = 1. - step(${(ax(AVES[0]) - 3.5).toFixed(1)}, p.x) * step(p.x, ${(ax(AVES[1]) + 3.5).toFixed(1)});
          float ripple = pow(max(0., sin(p.y * 1.3 + sin(p.x * .4 + uTime * .7) * 2.)), 20.);
          col = mix(col, vec3(.003, .008, .02) + ripple * vec3(.02, .06, .14), river);
          gl_FragColor = vec4(fogged(col, vWorld), 1.);
        }`,
    }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  // ---------------- traffic: light points flowing along avenues and streets
  {
    const N = 900, lane = [], speed = [], offset = [], color = [];
    const head = new THREE.Color("#fff1d6").multiplyScalar(1.6), tail = new THREE.Color("#ff2a3a").multiplyScalar(1.4);
    for (let k = 0; k < N; k++) {
      const avenue = rng() < 0.6;
      const line = avenue ? ax(AVES[0] + Math.floor(rng() * (AVES[1] - AVES[0] + 1))) : sz(STREETS[0] + Math.floor(rng() * (STREETS[1] - STREETS[0])));
      const dir = rng() < 0.5 ? 1 : -1;
      lane.push(line + dir * 0.25, avenue ? 1 : 0);
      speed.push(dir * (0.012 + rng() * 0.02) * (avenue ? 1 : 2));
      offset.push(rng());
      const c = dir > 0 ? head : tail;
      color.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute("aLane", new THREE.Float32BufferAttribute(lane, 2));
    g.setAttribute("aSpeed", new THREE.Float32BufferAttribute(speed, 1));
    g.setAttribute("aOffset", new THREE.Float32BufferAttribute(offset, 1));
    g.setAttribute("aColor", new THREE.Float32BufferAttribute(color, 3));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: time, uFog: { value: fog } },
      vertexShader: `
        attribute vec2 aLane; attribute float aSpeed, aOffset; attribute vec3 aColor;
        uniform float uTime; varying vec3 vColor; varying vec3 vWorld;
        void main() {
          float t = fract(aOffset + uTime * aSpeed);
          vec3 p = aLane.y > .5 ? vec3(aLane.x, .12, mix(${sz(STREETS[1]).toFixed(1)}, ${sz(STREETS[0]).toFixed(1)}, t))
                                : vec3(mix(${ax(AVES[0]).toFixed(1)}, ${ax(AVES[1]).toFixed(1)}, t), .12, aLane.x);
          vWorld = p; vColor = aColor;
          vec4 mv = viewMatrix * vec4(p, 1.);
          gl_PointSize = 140. / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uFog; varying vec3 vColor; varying vec3 vWorld;
        void main() {
          float d = length(gl_PointCoord - .5);
          float a = smoothstep(.5, .1, d);
          float f = length(vWorld - cameraPosition) * ${FOG};
          gl_FragColor = vec4(vColor * a * exp(-f * f), 1.);
        }`,
    }));
    pts.frustumCulled = false;
    scene.add(pts);
  }

  // ---------------- the traveller, the route and the destination ring
  const traveller = new THREE.Group();
  traveller.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: neon("#ffffff", 3) })));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: neon("#7fe8ff", 1.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(3);
  traveller.add(halo);
  traveller.position.set(START[0], 0.45, START[1]);
  scene.add(traveller);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 48), new THREE.MeshBasicMaterial({ color: neon("#7fe8ff", 2), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);

  const pathMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uProgress: { value: 0 }, uTime: time, uColor: { value: new THREE.Color() }, uFade: { value: 1 } },
    vertexShader: `attribute float aDist; attribute float aSide; varying float vDist; varying float vSide;
      void main() { vDist = aDist; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform float uProgress, uTime, uFade; uniform vec3 uColor; varying float vDist; varying float vSide;
      void main() {
        if (vDist > uProgress) discard;
        float edge = 1. - abs(vSide);
        float dash = smoothstep(.5, 1., fract((vDist - uTime * 7.) / 2.2));
        float head = exp(-(uProgress - vDist) * .8);
        gl_FragColor = vec4(uColor * (edge * .9 + dash * edge * 1.6 + head * 2.) * uFade, 1.);
      }`,
  });
  const path = new THREE.Mesh(new THREE.BufferGeometry(), pathMat);
  path.frustumCulled = false;
  scene.add(path);

  function setPath(points) {
    const pos = [], dist = [], side = [], idx = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
      dir.normalize();
      const nx = -dir.z * 0.32, nz = dir.x * 0.32, ext = 0.32;
      const a2 = a.clone().addScaledVector(dir, i ? -ext : 0), b2 = b.clone().addScaledVector(dir, i < points.length - 2 ? ext : 0);
      const base = pos.length / 3;
      for (const [p, d] of [[a2, total - (i ? ext : 0)], [b2, total + len + (i < points.length - 2 ? ext : 0)]]) {
        pos.push(p.x + nx, 0.08 + i * 0.002, p.z + nz, p.x - nx, 0.08 + i * 0.002, p.z - nz);
        dist.push(d, d); side.push(1, -1);
      }
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      total += len;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aDist", new THREE.Float32BufferAttribute(dist, 1));
    g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    path.geometry.dispose();
    path.geometry = g;
    return total;
  }

  // Routes follow the grid: try L-shaped and Z-shaped routes and keep the shortest one that doesn't
  // run through a landmark.
  function route(from, to, dest) {
    const blocked = (a, b) => reserved.some(({ r: [x0, x1, z0, z1], id, soft }) => {
      if (soft && id === dest) return false;
      const lx = Math.min(a.x, b.x) - 0.25, hx = Math.max(a.x, b.x) + 0.25, lz = Math.min(a.z, b.z) - 0.25, hz = Math.max(a.z, b.z) + 0.25;
      return lx < x1 - 0.1 && hx > x0 + 0.1 && lz < z1 - 0.1 && hz > z0 + 0.1;
    });
    const V = (x, z) => new THREE.Vector3(x, 0, z);
    const cands = [[from, V(to.x, from.z), to], [from, V(from.x, to.z), to]];
    for (let n = 30; n <= 52; n++) cands.push([from, V(from.x, sz(n)), V(to.x, sz(n)), to]);
    for (let i = -1; i <= 8; i++) cands.push([from, V(ax(i), from.z), V(ax(i), to.z), to]);
    let best = null, bestLen = Infinity;
    for (const c of cands) {
      const pts = c.filter((p, i) => i === 0 || p.distanceTo(c[i - 1]) > 0.01);
      let len = 0, ok = true;
      for (let i = 0; i < pts.length - 1; i++) {
        if (blocked(pts[i], pts[i + 1])) { ok = false; break; }
        len += pts[i].distanceTo(pts[i + 1]);
      }
      len += pts.length * 0.5;
      if (ok && len < bestLen) { best = pts; bestLen = len; }
    }
    return best || [from, V(to.x, from.z), to];
  }

  // ---------------- camera
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.06, minDistance: 22, maxDistance: 150,
    minPolarAngle: 0.25, maxPolarAngle: 1.22, autoRotate: !reduced, autoRotateSpeed: 0.25, screenSpacePanning: false });
  const overviewPose = () => {
    const portrait = innerWidth / innerHeight < 0.9;
    const k = portrait ? 1.7 : 1;
    return { pos: new THREE.Vector3(30, 62 * k, sz(41) + 66 * k), look: new THREE.Vector3(27, 0, sz(42)) };
  };
  const home = overviewPose();
  camera.position.copy(home.pos);
  controls.target.copy(home.look);
  const look = new THREE.Vector3().copy(home.look);
  let inset = 0; // 0..1, how far the view is shifted to make room for the panel

  function applyInset() {
    const w = innerWidth, h = innerHeight, p = panelInset();
    const ox = p.x * inset, oy = p.y * inset;
    camera.aspect = (w + ox) / (h + oy);
    if (ox || oy) camera.setViewOffset(w + ox, h + oy, ox, oy, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloomPass.resolution.set(w / 2, h / 2);
    applyInset();
  }

  // ---------------- animation helpers
  const tasks = new Set();
  const run = (fn) => new Promise((resolve) => tasks.add({ fn, resolve }));
  const tween = (dur, fn, alive) => {
    let t = 0;
    return run((dt) => {
      if (!alive()) return true;
      t += dt;
      const k = reduced ? 1 : Math.min(1, t / dur);
      fn(k);
      return k >= 1;
    });
  };
  const fly = (pos, target, dur, alive, insetTo) => {
    const p0 = camera.position.clone(), l0 = look.clone(), i0 = inset;
    return tween(dur, (k) => {
      const e = ease(k);
      camera.position.lerpVectors(p0, pos, e);
      look.lerpVectors(l0, target, e);
      if (insetTo !== undefined) { inset = i0 + (insetTo - i0) * e; applyInset(); }
      camera.lookAt(look);
    }, alive);
  };

  let here = traveller.position.clone().setY(0), at = null;
  const showMarkers = (except) => Object.entries(landmarks).forEach(([k, l]) => { l.label.visible = l.beam.visible = k !== except; });

  async function travel(id, alive) {
    const L = landmarks[id];
    showMarkers(null);
    controls.enabled = false;
    controls.autoRotate = false;
    if (!at) look.copy(controls.target);
    const pts = route(here, L.door, id);
    const total = setPath(pts);
    pathMat.uniforms.uColor.value.set(L.color).multiplyScalar(1.4);
    pathMat.uniforms.uFade.value = 1;
    pathMat.uniforms.uProgress.value = 0;
    ring.material.color.set(L.color).multiplyScalar(2);
    ring.position.set(L.door.x, 0.1, L.door.z);
    ring.visible = true;
    halo.material.color.set(L.color).multiplyScalar(1.4);

    // 1. Rise up to see the whole route, while it draws itself.
    const bb = new THREE.Box3().setFromPoints(pts);
    const mid = bb.getCenter(new THREE.Vector3());
    const span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 12);
    const over = new THREE.Vector3(mid.x + span * 0.15, 14 + span * 0.85, mid.z + 10 + span * 0.75);
    await Promise.all([
      fly(over, mid, 1.3, alive, 0),
      tween(1.6, (k) => (pathMat.uniforms.uProgress.value = total * ease(k)), alive),
    ]);
    if (!alive()) return false;

    // 2. Ride along the route with a chase camera.
    const dur = reduced ? 0 : Math.min(4.2, 1.4 + total / 18);
    const segs = [];
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) { const l = pts[i].distanceTo(pts[i + 1]); segs.push([pts[i], pts[i + 1], acc, l]); acc += l; }
    const at_ = (d) => { const s = segs.find(([, , a, l]) => d <= a + l) || segs[segs.length - 1]; const k = (d - s[2]) / (s[3] || 1); return [s[0].clone().lerp(s[1], Math.min(1, k)), s[1].clone().sub(s[0]).normalize()]; };
    const want = new THREE.Vector3(), wantLook = new THREE.Vector3();
    let t = 0;
    await run((dt) => {
      if (!alive()) return true;
      t += dt;
      const k = dur ? Math.min(1, t / dur) : 1;
      const [p, dir] = at_(total * ease(k));
      traveller.position.set(p.x, 0.45, p.z);
      want.copy(p).addScaledVector(dir, -7).setY(6.5);
      wantLook.copy(p).addScaledVector(dir, 5).setY(1.2);
      const s = 1 - Math.exp(-dt * 3.2);
      camera.position.lerp(want, s);
      look.lerp(wantLook, s);
      camera.lookAt(look);
      return k >= 1;
    });
    if (!alive()) return false;
    here = L.door.clone();
    at = id;

    // 3. Swing round to frame the landmark, leaving room for the panel.
    showMarkers(id);
    const portrait = innerWidth < 820;
    await fly(portrait ? L.look.clone().lerp(L.cam, 1.6) : L.cam, L.look, 1.6, alive, 1);
    return alive();
  }

  async function overview(alive) {
    const pose = overviewPose();
    await Promise.all([
      fly(pose.pos, pose.look, 1.6, alive, 0),
      tween(1, (k) => (pathMat.uniforms.uFade.value = 1 - k), alive),
    ]);
    if (!alive()) return;
    pathMat.uniforms.uProgress.value = 0;
    ring.visible = false;
    at = null;
    showMarkers(null);
    controls.target.copy(pose.look);
    controls.enabled = true;
    controls.autoRotate = !reduced;
  }

  // ---------------- picking landmarks on the map
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickables = Object.values(landmarks).flatMap((l) => [l.hit, l.label]);
  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(pickables, false)[0]?.object.userData.id;
  };
  let down = null, hover = null;
  canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
  canvas.addEventListener("pointerup", (e) => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) { const id = pick(e); if (id) go(id); }
    down = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || busy) return;
    const id = pick(e);
    if (id === hover) return;
    hover = id;
    canvas.style.cursor = id ? "pointer" : "";
    Object.entries(landmarks).forEach(([k, l]) => l.label.userData.target = k === id ? 1.25 : 1);
  });

  // ---------------- the leader line from the landmark to the panel
  const leaderLine = $("polyline", ui.leader), [dot, ping] = ui.leader.querySelectorAll("circle");
  const proj = new THREE.Vector3();
  function drawLeader() {
    if (!current) { ui.leader.style.opacity = 0; return; }
    const L = landmarks[current], w = innerWidth, h = innerHeight;
    proj.copy(L.look).project(camera);
    const x = (proj.x + 1) / 2 * w, y = (1 - proj.y) / 2 * h;
    const r = ui.panel.getBoundingClientRect();
    const pts = r.left > w / 3
      ? [[x, y], [x + Math.min(60, (r.left - x) / 2), y], [r.left - 24, r.top + 26], [r.left, r.top + 26]]
      : [[x, y], [x, r.top - 24], [r.left + 30, r.top]];
    leaderLine.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
    for (const c of [dot, ping]) { c.setAttribute("cx", x); c.setAttribute("cy", y); }
    ui.leader.style.opacity = 1;
  }

  // ---------------- loop
  let raf = 0, last = 0;
  function frame(ms) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (ms - last) / 1000 : 1 / 60);
    last = ms;
    time.value += dt;
    for (const t of [...tasks]) if (t.fn(dt)) { tasks.delete(t); t.resolve(); }
    if (controls.enabled) controls.update();
    const pulse = 1 + 0.15 * Math.sin(time.value * 4);
    ring.scale.setScalar(pulse);
    halo.scale.setScalar(2.6 * pulse);
    for (const l of Object.values(landmarks)) {
      const s = l.label.scale, k = l.label.userData.target || 1;
      s.x += (l.label.userData.w * k - s.x) * 0.15; s.y += (l.label.userData.h * k - s.y) * 0.15;
    }
    composer.render();
    drawLeader();
  }

  const onResize = () => raf && resize();
  addEventListener("resize", onResize);

  return {
    travel, overview,
    start() { if (raf) return; resize(); last = 0; raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    reset() {
      tasks.forEach((t) => t.resolve());
      tasks.clear();
      const pose = overviewPose();
      inset = 0; applyInset();
      camera.position.copy(pose.pos);
      controls.target.copy(pose.look);
      look.copy(pose.look);
      controls.enabled = true;
      controls.autoRotate = !reduced;
      pathMat.uniforms.uProgress.value = 0;
      ring.visible = false;
      at = null;
    },
  };
}

// ------------------------------------------------------------------ textures
function makeLabel(title, place, color) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 300;
  const g = c.getContext("2d");
  g.textAlign = "center";
  g.shadowColor = color; g.shadowBlur = 28;
  g.fillStyle = color;
  g.font = '600 118px "Chakra Petch", "Inter", sans-serif';
  g.fillText(title.toUpperCase(), 512, 150);
  g.shadowBlur = 10;
  g.fillStyle = "#e8f6ff";
  g.font = '500 50px "Chakra Petch", "Inter", sans-serif';
  g.fillText(place.toUpperCase(), 512, 240);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  s.material.color.setScalar(1.25);
  s.renderOrder = 10;
  s.userData.w = 11; s.userData.h = 11 * 300 / 1024;
  s.scale.set(s.userData.w, s.userData.h, 1);
  return s;
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.25, "rgba(255,255,255,.45)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Animated Times Square billboards
function billboard({ x, y, z, w, h, flip, face }, time) {
  const seed = Math.random() * 10;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({
    uniforms: { uTime: time, uSeed: { value: seed } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform float uTime, uSeed; varying vec2 vUv;
      vec3 pal(float t) { return .5 + .5 * cos(6.2832 * (t + vec3(0., .33, .67))); }
      void main() {
        float t = uTime * .35 + uSeed;
        float scene = floor(mod(t, 3.));
        vec3 c = pal(uSeed * .17 + vUv.y * .3 + t * .1);
        if (scene == 0.) c *= .55 + .45 * step(.5, fract(vUv.x * 4. - t * 2.));
        else if (scene == 1.) c = mix(c, pal(uSeed + .5), smoothstep(.3, .7, fract(vUv.y * 2. + t)));
        else c *= .5 + .5 * sin(length(vUv - .5) * 20. - t * 6.);
        float frame = step(.04, vUv.x) * step(vUv.x, .96) * step(.04, vUv.y) * step(vUv.y, .96);
        gl_FragColor = vec4(c * (frame * 1.35 + .2), 1.);
      }`,
  }));
  mesh.position.set(x, y + h / 2, z);
  if (face === "south") mesh.rotation.y = 0;
  else mesh.rotation.y = flip ? -Math.PI / 2 : Math.PI / 2;
  return mesh;
}

function contactBoard() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#03140b"; g.fillRect(0, 0, 512, 256);
  g.textAlign = "center"; g.shadowColor = "#39ff88"; g.shadowBlur = 18; g.fillStyle = "#39ff88";
  g.font = '600 74px "Chakra Petch", sans-serif';
  g.fillText("SAY HELLO", 256, 118);
  g.font = '500 26px "Chakra Petch", sans-serif'; g.fillStyle = "#d9ffe9";
  g.fillText("narges.razavian@nyulangone.org", 256, 184);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshBasicMaterial({ map: tex });
  m.color.setScalar(1.4);
  return new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.7), m);
}
