/* Paint mode: the site becomes a blank canvas, and each section arrives on a pour of bright paint.
   Loaded on demand by site.js. Runs entirely in the browser (three.js from a CDN, no API keys). */
const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js";

const SECTIONS = [
  { id: "about", label: "About", src: ".hero-text", colors: ["#ff2e88", "#ffb000"] },
  { id: "research", label: "Research", src: "#research > .wrap", colors: ["#7b2fff", "#ff4fd8"] },
  { id: "publications", label: "Publications", src: "#publications > .wrap", colors: ["#00a6ff", "#2f45ff"] },
  { id: "teaching", label: "Teaching", src: "#teaching > .wrap", colors: ["#ffd000", "#ff5e00"] },
  { id: "contact", label: "Contact", src: "#contact > .wrap", colors: ["#1fd66b", "#00c2b8"] },
];
const PALETTE = SECTIONS.flatMap((s) => s.colors);
const MAX_SPLATS = 32;

const $ = (s, el = document) => el.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const rand = (a, b) => a + Math.random() * (b - a);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

let ui, painter, active = false, current = null;
const homes = new Map(); // section id -> { el, parent, next } so moved content can go back

// ------------------------------------------------------------------ public API
export const isActive = () => active;
export async function toggle() {
  active ? exit() : await enter();
}

async function enter() {
  active = true;
  if (!ui) buildUI();
  document.documentElement.classList.add("magic-on");
  $("main").inert = $("footer").inert = true;
  ui.root.hidden = false;
  requestAnimationFrame(() => ui.root.classList.add("shown"));
  setPressed(true);
  if (!painter) painter = await createPainter(ui.canvas).catch(() => null);
  if (!painter) ui.root.classList.add("no-gl");
  painter?.start();
}

export function exit() {
  active = false;
  closePanel(true);
  document.documentElement.classList.remove("magic-on");
  $("main").inert = $("footer").inert = false;
  ui.root.classList.remove("shown");
  setPressed(false);
  setTimeout(() => { if (!active) { ui.root.hidden = true; painter?.stop(); } }, 350);
}

function setPressed(on) {
  const b = $(".magic-toggle");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Back to the regular site" : "Paint mode";
}

// ------------------------------------------------------------------ DOM
function buildUI() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../css/magic.css", import.meta.url).href;
  document.head.append(link);

  const root = document.createElement("div");
  root.className = "magic";
  root.hidden = true;
  root.innerHTML = `
    <canvas class="magic-canvas" aria-hidden="true"></canvas>
    <div class="magic-home">
      <p class="magic-eyebrow">NYU Langone Health</p>
      <h1 class="magic-title">Razavian Lab</h1>
      <p class="magic-hint">Pick a color. Or click anywhere to splash.</p>
    </div>
    <nav class="magic-pots" aria-label="Sections">
      ${SECTIONS.map((s) => `<button type="button" class="magic-pot" data-id="${s.id}" style="--c:${s.colors[0]};--c2:${s.colors[1]}"><i></i><span>${s.label}</span></button>`).join("")}
      <button type="button" class="magic-wash" title="Fresh canvas" aria-label="Fresh canvas">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
      </button>
    </nav>
    <section class="magic-panel" tabindex="-1" hidden>
      <button type="button" class="magic-close" aria-label="Close section">×</button>
      <div class="magic-panel-body"></div>
    </section>`;
  document.body.append(root);
  ui = { root, canvas: $(".magic-canvas", root), panel: $(".magic-panel", root), body: $(".magic-panel-body", root) };

  $(".magic-pots", root).addEventListener("click", (e) => {
    const pot = e.target.closest(".magic-pot");
    if (pot) openSection(pot.dataset.id, pot);
    if (e.target.closest(".magic-wash")) { painter?.wash(); closePanel(true); }
  });
  $(".magic-close", root).addEventListener("click", () => closePanel());
  // A research theme filters the publications; follow it there.
  ui.body.addEventListener("click", (e) => {
    if (current === "research" && e.target.closest(".theme")) setTimeout(() => openSection("publications"), 0);
  });

  // Painting on the bare canvas: tap for a splash, drag to draw.
  let drag = null;
  ui.canvas.addEventListener("pointerdown", (e) => {
    if (!painter) return;
    const color = PALETTE[(Math.random() * PALETTE.length) | 0];
    drag = { color, x: e.clientX, y: e.clientY, moved: 0 };
    ui.canvas.setPointerCapture(e.pointerId);
  });
  ui.canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.moved += Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    painter.stroke(drag.x, drag.y, e.clientX, e.clientY, drag.color);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  ui.canvas.addEventListener("pointerup", (e) => {
    if (drag && drag.moved < 8) painter.pour(e.clientX, e.clientY, [drag.color], { size: rand(0.06, 0.1) });
    drag = null;
  });

  // In paint mode the brand returns home; Escape closes the section, then leaves paint mode.
  $(".brand").addEventListener("click", (e) => { if (active) { e.preventDefault(); closePanel(); } });
  document.addEventListener("keydown", (e) => {
    if (!active || e.key !== "Escape") return;
    current ? closePanel() : exit();
  });
}

function openSection(id, fromEl) {
  if (id === current) return;
  const s = SECTIONS.find((x) => x.id === id);
  closePanel(true);
  const el = document.querySelector(s.src);
  if (!el) return;
  homes.set(id, { el, parent: el.parentNode, next: el.nextSibling });
  ui.body.append(el);
  current = id;

  const { panel, root } = ui;
  panel.dataset.section = id;
  panel.style.setProperty("--c", s.colors[0]);
  panel.style.setProperty("--c2", s.colors[1]);
  root.classList.add("open");
  root.querySelectorAll(".magic-pot").forEach((p) => p.setAttribute("aria-current", String(p.dataset.id === id)));

  // Pour into the margins on either side of the panel, so the paint frames it.
  const w = innerWidth, h = innerHeight;
  const side = Math.random() < 0.5 ? -1 : 1;
  const edge = Math.max(0.1 * w, (w - Math.min(920, w)) / 2 * 0.55);
  const delay = painter && !reduced ? 650 : 0;
  if (painter) {
    painter.pour(w / 2 + side * (w / 2 - edge), rand(0.3, 0.6) * h, [s.colors[0]], { size: rand(0.26, 0.32) });
    setTimeout(() => painter.pour(w / 2 - side * (w / 2 - edge * 0.8), rand(0.45, 0.75) * h, [s.colors[1]], { size: rand(0.18, 0.24) }), reduced ? 0 : 280);
  }
  panel.classList.remove("landed");
  panel.style.animationDelay = `${delay}ms`;
  panel.hidden = false;
  void panel.offsetWidth; // restart the landing animation
  panel.classList.add("landed");
  panel.scrollTop = 0;
  setTimeout(() => panel.focus({ preventScroll: true }), delay);
}

function closePanel(silent) {
  if (!ui || !current) return;
  const home = homes.get(current);
  if (home) home.parent.insertBefore(home.el, home.next);
  current = null;
  ui.panel.hidden = true;
  ui.root.classList.remove("open");
  ui.root.querySelectorAll(".magic-pot").forEach((p) => p.removeAttribute("aria-current"));
  if (!silent && painter && !reduced) painter.pour(innerWidth * rand(0.2, 0.8), innerHeight * rand(0.3, 0.7),
    [PALETTE[(Math.random() * PALETTE.length) | 0]], { size: 0.08 });
}

// ------------------------------------------------------------------ paint simulation
// State texture: rgb = pigment color, a = paint thickness. Thick paint is wet: it drips, swirls and shines.
const NOISE = `
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0., a = .5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= .5; } return v; }`;

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

const SIM = `
  precision highp float;
  uniform sampler2D uPrev;
  uniform vec2 uTexel;
  uniform float uAspect, uTime, uDrip, uFlow, uDry, uWash;
  uniform int uCount;
  uniform vec4 uSplat[${MAX_SPLATS}]; // x, y, radius (in screen heights), strength
  uniform vec4 uColor[${MAX_SPLATS}]; // r, g, b, seed
  varying vec2 vUv;
  ${NOISE}
  vec2 curl(vec2 p) {
    float e = .02;
    return vec2(fbm(p + vec2(0, e)) - fbm(p - vec2(0, e)), fbm(p - vec2(e, 0)) - fbm(p + vec2(e, 0))) / (2. * e);
  }
  void main() {
    vec4 here = texture2D(uPrev, vUv);
    float above = texture2D(uPrev, vUv + vec2(0., 2. * uTexel.y)).a;
    float wet = smoothstep(.45, 1.5, max(here.a, above));
    // Gravity pulls thick paint down in a few narrow runs; wet paint also swirls a little.
    float run = smoothstep(.6, .78, noise(vec2(vUv.x / uTexel.x / 7., 1.7)));
    vec2 vel = vec2(0., -uDrip * wet * wet * run);
    vel += curl(vUv * vec2(uAspect, 1.) * 2.5 + uTime * .04) * uFlow * wet;
    vec4 p = texture2D(uPrev, vUv - vel);
    if (p.a > .32) p.a = max(.32, p.a - uDry);
    p.a *= 1. - uWash;

    vec2 asp = vec2(uAspect, 1.);
    for (int i = 0; i < ${MAX_SPLATS}; i++) {
      if (i >= uCount) break;
      vec4 s = uSplat[i];
      vec2 d = (vUv - s.xy) * asp;
      float len = length(d);
      if (len > s.z * 1.35) continue;
      float ang = atan(d.y, d.x);
      float n = fbm(vec2(cos(ang), sin(ang)) * 1.7 + uColor[i].w * 17.);
      float r = s.z * (.62 + .75 * n);
      float m = s.w * (1. - smoothstep(r * .82, r, len));
      if (m <= 0.) continue;
      p.rgb = mix(p.rgb, uColor[i].rgb, clamp(m / (p.a * .5 + m), 0., 1.));
      p.a = min(p.a + m, 2.);
    }
    gl_FragColor = p;
  }`;

const DISPLAY = `
  precision highp float;
  uniform sampler2D uPaint;
  uniform vec2 uTexel;
  uniform vec3 uPaper;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    vec4 p = texture2D(uPaint, vUv);
    float hl = texture2D(uPaint, vUv - vec2(uTexel.x, 0.)).a, hr = texture2D(uPaint, vUv + vec2(uTexel.x, 0.)).a;
    float hd = texture2D(uPaint, vUv - vec2(0., uTexel.y)).a, hu = texture2D(uPaint, vUv + vec2(0., uTexel.y)).a;
    vec3 n = normalize(vec3((hl - hr) * 2.2, (hd - hu) * 2.2, 1.));
    vec3 L = normalize(vec3(-.45, .6, .66));
    float diff = clamp(dot(n, L), 0., 1.);
    float wet = smoothstep(.3, 1.3, p.a);
    float spec = pow(max(dot(n, normalize(L + vec3(0., 0., 1.))), 0.), 70.) * (.2 + .8 * wet);
    float cov = smoothstep(.02, .08, p.a);
    float rim = cov * (1. - smoothstep(.08, .32, p.a));      // pigment pools at the edges
    vec3 paint = p.rgb * (.8 + .3 * diff) * (1. - .2 * rim) + spec * .6;
    vec3 paper = uPaper + (hash(gl_FragCoord.xy) - .5) * .03;
    gl_FragColor = vec4(mix(paper, paint, cov), 1.);
  }`;

const COPY = `precision highp float; uniform sampler2D uSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(uSrc, vUv); }`;

async function createPainter(canvas) {
  const THREE = await import(THREE_URL);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const scene = new THREE.Scene();
  scene.add(quad);

  const makeTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  const splats = Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4());
  const colors = Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4());
  const sim = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: SIM,
    uniforms: {
      uPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uTime: { value: 0 },
      uDrip: { value: 0 }, uFlow: { value: 0 }, uDry: { value: 0 }, uWash: { value: 0 },
      uCount: { value: 0 }, uSplat: { value: splats }, uColor: { value: colors },
    },
  });
  const display = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: DISPLAY,
    uniforms: { uPaint: { value: null }, uTexel: { value: new THREE.Vector2() }, uPaper: { value: new THREE.Vector3(1, 1, 1) } },
  });
  const copy = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY, uniforms: { uSrc: { value: null } } });

  let read, write, simW = 0, simH = 0;
  const pass = (material, target) => { quad.material = material; renderer.setRenderTarget(target); renderer.render(scene, camera); };

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    const scale = Math.min(devicePixelRatio, 2) * 0.5;
    const nw = Math.max(2, Math.round(w * scale)), nh = Math.max(2, Math.round(h * scale));
    if (nw === simW && nh === simH) return;
    const a = makeTarget(nw, nh), b = makeTarget(nw, nh);
    renderer.setClearColor(0x000000, 0);
    for (const t of [a, b]) { renderer.setRenderTarget(t); renderer.clear(); }
    if (read) { copy.uniforms.uSrc.value = read.texture; pass(copy, a); read.dispose(); write.dispose(); }
    read = a; write = b; simW = nw; simH = nh;
    sim.uniforms.uTexel.value.set(1 / nw, 1 / nh);
    display.uniforms.uTexel.value.set(1 / nw, 1 / nh);
    sim.uniforms.uAspect.value = w / h;
  }

  function readPaper() {
    const bg = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || [255, 255, 255];
    display.uniforms.uPaper.value.set(bg[0] / 255, bg[1] / 255, bg[2] / 255);
  }
  new MutationObserver(readPaper).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readPaper);

  // Splats queue up and are applied up to MAX_SPLATS per frame; emitters add splats over time.
  const queue = [], emitters = [];
  let now = 0, washUntil = 0, raf = 0, last = 0;
  const toUv = (x, y) => [x / innerWidth, 1 - y / innerHeight];
  const add = (u, v, r, s, rgb, seed) => queue.push([u, v, r, s, rgb, seed]);
  const after = (delay, dur, fn) => emitters.push({ start: now + delay, dur, fn, last: 0 });

  function pour(x, y, hexes, { size = 0.25 } = {}) {
    const [u, v] = toUv(x, y);
    const aspect = innerWidth / innerHeight;
    hexes.forEach((hex, ci) => {
      const rgb = hexRgb(hex), seed = Math.random();
      const R = size * (ci ? 0.55 : 1);
      const cu = u + (ci ? rand(-1, 1) * R * 0.6 / aspect : 0), cv = v + (ci ? rand(-1, 1) * R * 0.6 : 0);
      if (reduced) { add(cu, cv, R, 2, rgb, seed); return; }
      const fall = 0.32 + (1 - cv) * 0.12, su = cu + rand(-0.02, 0.02);
      // The stream: a thin ribbon of paint falling from the top edge to the impact point.
      after(0, fall, (k, k0) => {
        const steps = Math.ceil((k - k0) * (1.03 - cv) / 0.003);
        for (let i = 1; i <= steps; i++) {
          const kk = k0 + (k - k0) * (i / steps), e = kk * kk;
          add(su + (cu - su) * kk, 1.03 - (1.03 - cv) * e, 0.007 + 0.004 * kk, 0.9, rgb, seed + 0.5);
        }
      });
      // The pool spreads out from the impact point...
      after(fall, 1.2, (k) => add(cu, cv, R * (1 - Math.pow(1 - k, 3)), 0.16 * (1 - 0.6 * k), rgb, seed));
      // ...while the stream thins out above it,
      after(fall, 0.7, (k) => add(su + (cu - su) * 0.9, cv + rand(0, 1 - cv), 0.006 * (1 - k), 0.5, rgb, seed + 0.5));
      // and the impact flings droplets and crown spikes outward.
      after(fall + 0.04, 0, () => {
        for (let i = 0; i < 18; i++) {
          const a = rand(0, Math.PI * 2), d = R * rand(1.0, 2.1);
          add(cu + Math.cos(a) * d / aspect, cv + Math.sin(a) * d, 0.003 + Math.pow(Math.random(), 2) * 0.014, 1.4, rgb, Math.random());
        }
        for (let j = 0; j < 7; j++) {
          const a = rand(0, Math.PI * 2), len = rand(0.35, 0.7);
          for (let t = 0; t <= 1; t += 0.12) {
            const d = R * (0.85 + len * t);
            add(cu + Math.cos(a) * d / aspect, cv + Math.sin(a) * d, R * 0.11 * (1 - t * 0.8), 1.2, rgb, Math.random());
          }
        }
      });
    });
  }

  function stroke(x0, y0, x1, y1, hex) {
    const [u0, v0] = toUv(x0, y0), [u1, v1] = toUv(x1, y1), rgb = hexRgb(hex);
    const n = Math.min(12, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
    for (let i = 1; i <= n; i++) add(u0 + (u1 - u0) * i / n, v0 + (v1 - v0) * i / n, 0.012, 0.35, rgb, 0.3);
  }

  function frame(ms) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (ms - last) / 1000 : 1 / 60);
    last = ms; now += dt;
    for (let i = emitters.length - 1; i >= 0; i--) {
      const e = emitters[i];
      if (now < e.start) continue;
      const k = e.dur ? Math.min(1, (now - e.start) / e.dur) : 1;
      e.fn(k, e.last);
      e.last = k;
      if (k >= 1) emitters.splice(i, 1);
    }
    const batch = queue.splice(0, MAX_SPLATS);
    batch.forEach(([u, v, r, s, rgb, seed], i) => { splats[i].set(u, v, r, s); colors[i].set(rgb[0], rgb[1], rgb[2], seed); });
    const f = dt * 60;
    sim.uniforms.uCount.value = batch.length;
    sim.uniforms.uTime.value = now;
    sim.uniforms.uDrip.value = reduced ? 0 : 0.0011 * f;
    sim.uniforms.uFlow.value = reduced ? 0 : 0.00025 * f;
    sim.uniforms.uDry.value = 0.0035 * f;
    sim.uniforms.uWash.value = now < washUntil ? 0.07 * f : 0;
    sim.uniforms.uPrev.value = read.texture;
    pass(sim, write);
    [read, write] = [write, read];
    display.uniforms.uPaint.value = read.texture;
    pass(display, null);
  }

  addEventListener("resize", () => raf && resize());
  return {
    pour, stroke,
    wash() { washUntil = now + 1.2; },
    start() { if (raf) return; resize(); readPaper(); last = 0; raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
