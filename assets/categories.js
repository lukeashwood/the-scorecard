/* Category Model: a 3D map of the Scorecard's own measurement categories, as spheres.
   One sphere per category (sized by how many measures it holds, coloured by how many are off track),
   a small "moon" per individual measure orbiting it, and a central sphere for the site-wide total.
   No policy content, no external links baked into the visualisation — every number comes from data/metrics.js. */
(function () {
  const D = window.SCORECARD;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isMobile = window.matchMedia("(max-width: 760px)").matches;
  const $ = (s) => document.querySelector(s);
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fmtNum = window.Charts ? window.Charts.fmtNum : (v) => String(v);

  const CYAN = 0x5fd4ff, RED = 0xff4d55, AMBER = 0xf5c04a, GREEN = 0x3ecf6b, WHITE = 0xffffff, INFO = 0x8fb4ff;
  const STATUS_COLOR = { fail: RED, warn: AMBER, pass: GREEN, info: INFO };
  const STATUS_HEX = { fail: "#ff4d55", warn: "#f5c04a", pass: "#3ecf6b", info: "#8fb4ff" };

  // A simple two-stop traffic-light ramp: 0 = all on track (green) -> 1 = all off track (red), amber at the midpoint.
  function rampColor(off, watch, rated) {
    if (!rated) return INFO;
    const bad = (off + watch * 0.5) / rated;                    // 0..1 "how much of this category needs attention"
    const stops = bad <= 0.5 ? [[0x3e, 0xcf, 0x6b], [0xf5, 0xc0, 0x4a]] : [[0xf5, 0xc0, 0x4a], [0xff, 0x4d, 0x55]];
    const t = bad <= 0.5 ? bad / 0.5 : (bad - 0.5) / 0.5;
    const [a, b] = stops;
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return (c[0] << 16) | (c[1] << 8) | c[2];
  }
  function hexOf(n) { return "#" + n.toString(16).padStart(6, "0"); }

  /* ---------------------------------------------------------------- build the data graph */
  const sections = D.sections.map((sec) => {
    const metrics = D.metrics.filter((m) => m.section === sec.id);
    const rated = metrics.filter((m) => m.status !== "info");
    const off = rated.filter((m) => m.status === "fail").length;
    const watch = rated.filter((m) => m.status === "warn").length;
    const on = rated.filter((m) => m.status === "pass").length;
    return { ...sec, type: "category", metrics, rated: rated.length, off, watch, on, color: rampColor(off, watch, rated.length) };
  }).filter((s) => s.metrics.length);
  const S = D.summary;
  const overall = { id: "overall", type: "overall", name: "The whole Scorecard", metrics: D.metrics,
    rated: S.metrics_rated, off: S.metrics_off_track, watch: S.metrics_watch, on: S.metrics_on_track,
    color: rampColor(S.metrics_off_track, S.metrics_watch, S.metrics_rated) };
  overall.pos = { x: 0, y: 0, z: 0 };
  overall.radius = 1.05;

  const RING_R = isMobile ? 4.6 : 6.2;
  sections.forEach((s, i) => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / sections.length);          // start at top, clockwise
    s.angle = a;
    s.pos = { x: RING_R * Math.cos(a), y: 0, z: RING_R * Math.sin(a) };
    s.radius = overall.radius;          // every planet is the same size as the sun/overall sphere
    s.moonR = s.radius + 0.15;          // close enough to the surface to stay inside the planet's own visible glow
    s.metrics.forEach((m, k) => { m.__moonAngle = k * (2 * Math.PI / s.metrics.length); m.__section = s; });
  });

  const nodesById = { overall };
  sections.forEach((s) => (nodesById[s.id] = s));
  D.metrics.forEach((m) => (nodesById[m.id] = m));

  /* ---------------------------------------------------------------- three.js scene */
  const stage = $("#stage");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch (e) {
    document.body.classList.add("no-webgl");
    $("#text-version").hidden = false;
    $("#no-webgl").hidden = false;
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x040918, 1);
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x040918, 0.024);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);

  // A single cool key light plus a dim ambient fill — used only by the planets' lit inner core, so a
  // sphere reads as a shaded 3D ball (a lit side, a terminator, a soft specular highlight) rather than
  // a flat tinted circle. Everything else in the scene stays on unlit materials and is unaffected.
  const keyLight = new THREE.DirectionalLight(0xcfe8ff, 1.15);
  keyLight.position.set(6, 8, 7);
  scene.add(keyLight);
  scene.add(new THREE.AmbientLight(0x16233f, 0.85));

  // A soft, gradually-fading radial glow. Stops are scaled proportionally to the caller's own alpha
  // (not hardcoded), so the taper is a smooth, monotonically-decreasing curve at any brightness —
  // it reads as a diffuse haze rather than a bright ring sitting on a flat tinted disc.
  function glowTexture(inner, outer) {
    const c = document.createElement("canvas"); c.width = c.height = 160;
    const g = c.getContext("2d");
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]+([\d.]+))?\s*\)/.exec(outer);
    const [r, gr, b] = [m[1], m[2], m[3]].map(Number);
    const a = m[4] !== undefined ? Number(m[4]) : 1;
    const stop = (f) => `rgba(${r},${gr},${b},${(a * f).toFixed(4)})`;
    const grd = g.createRadialGradient(80, 80, 0, 80, 80, 80);
    grd.addColorStop(0, inner);
    grd.addColorStop(0.1, stop(1));
    grd.addColorStop(0.32, stop(0.5));
    grd.addColorStop(0.58, stop(0.22));
    grd.addColorStop(0.82, stop(0.08));
    grd.addColorStop(1, stop(0));
    g.fillStyle = grd; g.fillRect(0, 0, 160, 160);
    return new THREE.CanvasTexture(c);
  }
  function rgba(hex, a) { const n = hex; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
  // A "solar halo": the same corona look as the flag sun's own glow — a blazing white-hot core burning
  // outward into the planet's own status colour, rather than a single flat tint — so every planet reads
  // as lit from within, the way the sun at the centre does.
  function solarHaloTexture(hex) {
    const n = hex, r = (n >> 16) & 255, g2 = (n >> 8) & 255, b = n & 255;
    const c = document.createElement("canvas"); c.width = c.height = 200;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(100, 100, 0, 100, 100, 100);
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(0.1, "rgba(255,255,255,0.55)");
    grd.addColorStop(0.24, `rgba(${r},${g2},${b},0.55)`);
    grd.addColorStop(0.48, `rgba(${r},${g2},${b},0.26)`);
    grd.addColorStop(0.7, `rgba(${r},${g2},${b},0.12)`);
    grd.addColorStop(0.88, `rgba(${r},${g2},${b},0.04)`);
    grd.addColorStop(1, `rgba(${r},${g2},${b},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, 200, 200);
    return new THREE.CanvasTexture(c);
  }
  const sprite = (tex, scale, opacity) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.set(scale, scale, 1); return s;
  };
  function sparkleTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d");
    g.translate(64, 64);
    const core = g.createRadialGradient(0, 0, 0, 0, 0, 64);
    core.addColorStop(0, "rgba(255,255,255,1)"); core.addColorStop(0.14, "rgba(255,255,255,0.85)"); core.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = core; g.fillRect(-64, -64, 128, 128);
    const ray = (len, w) => {
      const grd = g.createLinearGradient(0, -len, 0, len);
      grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.5, "rgba(255,255,255,0.85)"); grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd; g.fillRect(-w / 2, -len, w, len * 2);
    };
    ray(62, 3); g.rotate(Math.PI / 2); ray(62, 3);
    return new THREE.CanvasTexture(c);
  }

  /* ---------------------------------------------------------------- the Australian flag, drawn on a canvas
     (a national symbol, used only for the centre "whole Scorecard" sphere — no party content). */
  const FLAG_BLUE = "#012169", FLAG_RED = "#C8102E", FLAG_WHITE = "#FFFFFF";
  function starPath(ctx, cx, cy, outerR, innerR, points, rot) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = rot + (i * Math.PI) / points - Math.PI / 2;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  function drawStar(ctx, cx, cy, outerR, points, rot) {
    starPath(ctx, cx, cy, outerR, outerR * 0.45, points, rot || 0);
    ctx.fillStyle = FLAG_WHITE; ctx.fill();
  }
  function drawUnionJack(ctx, x, y, w, h) {
    ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.fillStyle = FLAG_BLUE; ctx.fillRect(0, 0, w, h);
    // white saltire (St Andrew's cross)
    const diagW = h * 0.16;
    ctx.strokeStyle = FLAG_WHITE; ctx.lineWidth = diagW;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w, 0); ctx.lineTo(0, h); ctx.stroke();
    // red saltire (St Patrick's cross), counterchanged — offset opposite ways in opposite quadrant pairs
    const off = diagW * 0.4;
    ctx.strokeStyle = FLAG_RED; ctx.lineWidth = diagW * 0.42;
    ctx.save(); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.closePath(); ctx.clip();
    ctx.beginPath(); ctx.moveTo(-off, off); ctx.lineTo(w - off, h + off); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.lineTo(w, h); ctx.closePath(); ctx.clip();
    ctx.beginPath(); ctx.moveTo(off, -off); ctx.lineTo(w + off, h - off); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.moveTo(w, 0); ctx.lineTo(0, 0); ctx.lineTo(0, h); ctx.closePath(); ctx.clip();
    ctx.beginPath(); ctx.moveTo(w + off, off); ctx.lineTo(off, h - off); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.moveTo(w, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.clip();
    ctx.beginPath(); ctx.moveTo(w - off, -off); ctx.lineTo(-off, h + off); ctx.stroke(); ctx.restore();
    // straight cross: white border, red centre (St George's cross)
    const whiteW = h * 0.34, redW = h * 0.2;
    ctx.fillStyle = FLAG_WHITE;
    ctx.fillRect(w / 2 - whiteW / 2, 0, whiteW, h); ctx.fillRect(0, h / 2 - whiteW / 2, w, whiteW);
    ctx.fillStyle = FLAG_RED;
    ctx.fillRect(w / 2 - redW / 2, 0, redW, h); ctx.fillRect(0, h / 2 - redW / 2, w, redW);
    ctx.restore();
  }
  function flagTexture() {
    const W = 512, H = 256;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d");
    // Paint onto a dark backdrop at reduced alpha, so the flag's own colours read as glowing-through and
    // translucent — matching the soft, lit-from-within look of the category "planet" spheres — rather than
    // a flat, fully-opaque decal. This is baked into the texture itself, so it works regardless of how the
    // material's own transparency/blending is set up.
    g.fillStyle = "#040918"; g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.85;
    g.fillStyle = FLAG_BLUE; g.fillRect(0, 0, W, H);
    drawUnionJack(g, 0, 0, W * 0.5, H * 0.5);
    // Commonwealth Star: centred in the hoist, below the canton.
    drawStar(g, W * 0.25, H * 0.7, H * 0.125, 7, 0.12);
    // Southern Cross, in the fly: a tall, slightly tilted kite — Gamma at top, Beta and Delta forming the
    // cross-arm, Alpha (largest) at the bottom, and small Epsilon just off-centre between them, matching the
    // real constellation's asymmetric shape rather than a symmetric plus.
    drawStar(g, W * 0.79, H * 0.09, H * 0.095, 7, -0.05);   // Gamma Crucis (top)
    drawStar(g, W * 0.945, H * 0.36, H * 0.095, 7, 0.35);   // Beta Crucis (right)
    drawStar(g, W * 0.625, H * 0.42, H * 0.1, 7, -0.3);     // Delta Crucis (left)
    drawStar(g, W * 0.815, H * 0.87, H * 0.13, 7, 0.15);    // Alpha Crucis (bottom, largest)
    drawStar(g, W * 0.735, H * 0.6, H * 0.052, 5, 0.1);     // Epsilon Crucis (small)
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }
  // A soft blue-white-red haze (the flag's own colours) — gradual stops so it reads as a diffuse aura,
  // not a solid tinted disc.
  function flagGlowTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, "rgba(255,255,255,0.36)");
    grd.addColorStop(0.16, "rgba(255,255,255,0.22)");
    grd.addColorStop(0.32, "rgba(40,100,230,0.26)");
    grd.addColorStop(0.55, "rgba(40,100,230,0.12)");
    grd.addColorStop(0.75, "rgba(220,25,45,0.1)");
    grd.addColorStop(0.92, "rgba(220,25,45,0.03)");
    grd.addColorStop(1, "rgba(220,25,45,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }
  // A thin, view-angle-dependent rim light (the classic "atmosphere" shader) — bright at the grazing edge of
  // the globe, invisible face-on, so the shine sits at the silhouette the way light rims a spinning planet.
  const ATMOSPHERE_VERT = "varying vec3 vNormal;\nvoid main() {\n  vNormal = normalize(normalMatrix * normal);\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}";
  const ATMOSPHERE_FRAG = "varying vec3 vNormal;\nuniform vec3 glowColor;\nvoid main() {\n  float rim = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.6);\n  gl_FragColor = vec4(glowColor, 1.0) * clamp(rim, 0.0, 1.0);\n}";
  function makeAtmosphere(radius, color) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color(color) } },
      vertexShader: ATMOSPHERE_VERT, fragmentShader: ATMOSPHERE_FRAG,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
  }

  // base: grid, rings, disc
  const grid = new THREE.GridHelper(44, 44, 0x123a6b, 0x0a1f45);
  grid.material.transparent = true; grid.material.opacity = 0.22; grid.position.y = -2.4;
  scene.add(grid);
  const rings = [];
  [[RING_R - 0.015, RING_R + 0.015, 0.4]].forEach(([ri, ro, op], i) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(ri, ro, 128, 1, 0, Math.PI * 2),
      new THREE.MeshBasicMaterial({ color: CYAN, side: THREE.DoubleSide, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = Math.PI / 2 + 0.06; m.userData.spin = 0.04 + i * 0.02;
    scene.add(m); rings.push(m);
  });
  const sweep = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.94, 96), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  sweep.rotation.x = Math.PI / 2; scene.add(sweep);
  let sweepT = 0;

  // particles
  const P = isMobile ? 220 : 600;
  const ppos = new Float32Array(P * 3), pvel = new Float32Array(P);
  for (let i = 0; i < P; i++) { const r = 2 + Math.random() * 10, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    ppos[i * 3] = r * Math.sin(ph) * Math.cos(th); ppos[i * 3 + 1] = r * Math.cos(ph) * 0.5; ppos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    pvel[i] = (0.05 + Math.random() * 0.1) * (Math.random() < 0.5 ? 1 : -1); }
  const pgeo = new THREE.BufferGeometry(); pgeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3));
  const TEX_CYAN = glowTexture("rgba(255,255,255,1)", "rgba(95,212,255,0.55)");
  const particles = new THREE.Points(pgeo, new THREE.PointsMaterial({ size: 0.08, map: TEX_CYAN, color: CYAN, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(particles);

  // spheres: overall (faceted wireframe) + categories (solid glowing orbs, no wireframe)
  const meshes = {};        // id -> {group, core, [wire|inner], halo, moons:[{mesh,halo,id}]}
  const pickables = [];

  function makeOverallSphere(node) {
    // The centre sphere stands for the whole country, not a rating — a spinning globe wrapped in the
    // Australian flag, inside a faceted containment shell, with a rim-lit atmosphere and a fixed
    // "studio light" highlight and sparkle so it reads as lit and glossy rather than a flat decal.
    const g = new THREE.Group(); g.position.set(node.pos.x, node.pos.y, node.pos.z);
    const coreR = node.radius * 0.7;
    const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(node.radius * 1.05, 2), new THREE.MeshBasicMaterial({ color: 0xeaf6ff, wireframe: true, transparent: true, opacity: 0.32 }));
    const core = new THREE.Mesh(new THREE.SphereGeometry(coreR, 48, 32), new THREE.MeshBasicMaterial({ map: flagTexture(), transparent: true, opacity: 0.94 }));
    core.userData.id = node.id; pickables.push(core);
    const atmosphere = makeAtmosphere(coreR * 1.16, 0x7fb2ff);
    g.add(atmosphere, core, wire); scene.add(g);
    const halo = sprite(flagGlowTexture(), node.radius * 4.8, 0.5);
    halo.position.copy(g.position); scene.add(halo);
    // a fixed "studio light" hotspot — offset from centre, always facing the camera, independent of the globe's spin
    const shineOffset = new THREE.Vector3(coreR * 0.5, coreR * 0.55, coreR * 0.7);
    const shine = sprite(glowTexture("rgba(255,255,255,1)", "rgba(255,255,255,0.55)"), coreR * 0.85, 0.75);
    shine.position.copy(g.position).add(shineOffset); scene.add(shine);
    const sparkle = sprite(sparkleTexture(), coreR * 1.5, 0.85);
    sparkle.position.copy(shine.position); scene.add(sparkle);
    return { group: g, wire, core, atmosphere, halo, shine, sparkle };
  }

  // A softly-lit orb: a near-invisible outer shell (just the clickable hit area, not a visible glow layer),
  // a lit inner core, and a solar-halo sprite — the same white-hot-core corona look as the flag sun's own
  // glow, tinted to the planet's current status colour — always camera-facing, so it glows evenly in every
  // direction rather than favouring one side the way a rim/edge light would. Its reach uses the same radius
  // multiplier as the flag sun's own halo, so it emanates the same relative distance. Unlike the flat, unlit
  // colour the core used before, it now uses the scene's key light + a matching emissive glow, so the sphere
  // shows a lit side and a soft terminator — the shading cue that reads as "a solid ball" rather than "a flat
  // tinted circle" — without a specular highlight (black specular disables it), and at less than full opacity
  // so the sphere reads as a lightly translucent orb rather than a fully solid one.
  function makeCategorySphere(node) {
    const g = new THREE.Group(); g.position.set(node.pos.x, node.pos.y, node.pos.z);
    const outer = new THREE.Mesh(new THREE.SphereGeometry(node.radius, 32, 24), new THREE.MeshBasicMaterial({ color: node.color, transparent: true, opacity: 0.08, depthWrite: false }));
    const inner = new THREE.Mesh(new THREE.SphereGeometry(node.radius * 0.6, 32, 24), new THREE.MeshPhongMaterial({
      color: node.color, emissive: node.color, emissiveIntensity: 0.3, specular: 0x000000, shininess: 0,
      transparent: true, opacity: 0.92,
    }));
    outer.userData.id = node.id; pickables.push(outer);
    g.add(outer, inner); scene.add(g);
    const tex = solarHaloTexture(node.color);
    const halo = sprite(tex, node.radius * 4.8, 0.16);
    halo.position.copy(g.position); scene.add(halo);
    return { group: g, core: outer, inner, halo, tex };
  }

  meshes.overall = makeOverallSphere(overall);
  sections.forEach((s) => { meshes[s.id] = makeCategorySphere(s); meshes[s.id].moons = []; });

  // spokes: category -> overall, each with a small stream of glowing orbs travelling inward along the line
  const PULSE_TEX = glowTexture("rgba(255,255,255,1)", "rgba(180,225,255,0.9)");
  const spokes = sections.map((s, i) => {
    const pts = [new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), new THREE.Vector3(0, 0, 0)];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.16 }));
    scene.add(line);
    const pulses = [0, 0.33, 0.66].map((phase) => {
      const s2 = sprite(PULSE_TEX, 0.32, 0);
      scene.add(s2);
      return { mesh: s2, phase: phase + i * 0.11 };
    });
    return { id: s.id, line, pos: s.pos, pulses };
  });

  /* ---------------------------------------------------------------- HTML labels (overall, categories, and every individual measure) */
  const hud = $("#labels");
  const labelEls = {};
  const moonById = {};      // metric id -> its moon {mesh, halo, ...}, used to position its label each frame
  function addLabel(node) {
    const el = h("button", "lbl " + (node.type === "overall" ? "lbl-overall" : "lbl-category"));
    el.type = "button";
    if (node.type === "category") {
      const sw = h("span", "lbl-swatch"); sw.style.background = hexOf(node.color); el.appendChild(sw);
      el.appendChild(h("span", "lbl-text", node.title));
      el.appendChild(h("span", "lbl-count", `${node.off}/${node.rated}`));
    } else {
      el.appendChild(h("span", "lbl-text", "Overall"));
    }
    el.setAttribute("aria-label", node.type === "category" ? node.title : "Overall: every measure");
    el.addEventListener("click", (e) => { e.stopPropagation(); select(node.id, true); });
    hud.appendChild(el); labelEls[node.id] = el;
  }
  // Short, readable names for the measure labels — the full title is still in the tooltip, the panel and
  // the aria-label; this is purely so 30 small orbiting labels don't crowd the scene with long sentences.
  const SHORT_NAME = {
    inflation: "Inflation", prices_vs_wages: "Prices vs wages", real_wages: "Real wages",
    electricity: "Electricity", power_bills: "Power bills", wholesale_gas: "Gas prices",
    emissions_target: "Emissions", mortgage: "Mortgage costs", interest_rates: "Interest rates",
    housing_accord: "Housing Accord", home_prices: "Home prices", unemployment: "Unemployment",
    public_private_jobs: "Public/private jobs", jobs_by_sector: "Job creation", productivity: "Productivity",
    insolvencies: "Insolvencies", consumer_confidence: "Confidence", gdp_per_capita: "GDP per person",
    household_income: "Household income", bulk_billing: "Bulk billing", government_size: "Govt size",
    gross_debt: "Gross debt", budget_balance: "Budget deficit", interest_costs: "Debt interest",
    spending_gdp: "Govt spending", aps_headcount: "Public service", ndis: "NDIS growth",
    migration: "Migration", defence_spending: "Defence", legislation: "Laws passed",
  };
  function shortLabel(m) {
    if (SHORT_NAME[m.id]) return SHORT_NAME[m.id];
    const base = m.title.split(":")[0].trim();
    return base.length > 18 ? base.slice(0, 17) + "…" : base;
  }
  function addMoonLabel(m) {
    const el = h("button", "lbl lbl-moon");
    el.type = "button";
    const sw = h("span", "lbl-swatch"); sw.style.background = STATUS_HEX[m.status] || STATUS_HEX.info; el.appendChild(sw);
    el.appendChild(h("span", "lbl-text", shortLabel(m)));
    el.setAttribute("aria-label", `${m.title}: ${headline(m)}`);
    el.addEventListener("click", (e) => { e.stopPropagation(); select(m.id, true); });
    hud.appendChild(el); labelEls[m.id] = el;
  }
  addLabel(overall);
  sections.forEach(addLabel);
  const reticle = $("#reticle");

  // moons: one per metric, orbiting its category — each gets a small persistent label showing its headline value
  const moonGeo = new THREE.SphereGeometry(1, 12, 10);
  sections.forEach((s) => {
    const tilt = 0.35 + Math.random() * 0.25;
    // One shared angular speed per planet — every moon in its ring turns at the same rate, so the even
    // spacing they start with (each __moonAngle is a fixed fraction of a full turn) never drifts apart.
    const speed = 0.18 + Math.random() * 0.1;
    s.metrics.forEach((m) => {
      const col = STATUS_COLOR[m.status] || INFO;
      const mesh = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 }));
      mesh.scale.setScalar(isMobile ? 0.075 : 0.09);
      mesh.userData.id = m.id;
      scene.add(mesh); pickables.push(mesh);
      const halo = sprite(glowTexture("rgba(255,255,255,1)", rgba(col, 0.35)), 0.5, 0.3);
      scene.add(halo);
      const moon = { mesh, halo, id: m.id, angle: m.__moonAngle, tilt, speed };
      meshes[s.id].moons.push(moon);
      moonById[m.id] = moon;
      addMoonLabel(m);
    });
  });

  /* ---------------------------------------------------------------- camera / orbit */
  const cam = { theta: 0.5, phi: 1.05, r: isMobile ? 15 : 12.5, target: new THREE.Vector3(0, 0, 0) };
  const goal = { theta: cam.theta, phi: cam.phi, r: cam.r, target: cam.target.clone() };
  let viewShift = 0, viewShiftGoal = 0;
  let dragging = false, lastX = 0, lastY = 0, lastInteract = performance.now(), pinch = null;
  const canvas = renderer.domElement;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; lastInteract = performance.now(); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
    goal.theta -= dx * 0.006; goal.phi = Math.max(0.3, Math.min(1.5, goal.phi - dy * 0.005));
    cam.theta = goal.theta; cam.phi = goal.phi; lastInteract = performance.now();
  });
  const endDrag = () => { dragging = false; };
  canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); goal.r = Math.max(3.5, Math.min(24, goal.r + e.deltaY * 0.012)); lastInteract = performance.now(); }, { passive: false });
  canvas.addEventListener("touchstart", (e) => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinch) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); goal.r = Math.max(3.5, Math.min(24, goal.r * (pinch / d))); pinch = d; dragging = false; }
  }, { passive: true });
  canvas.addEventListener("touchend", () => { pinch = null; });

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null, hoverId = null;
  const tip = h("div", "hud-tip"); stage.appendChild(tip);
  canvas.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    const id = hit ? hit.object.userData.id : null;
    if (id !== hoverId) {
      hoverId = id;
      if (id && nodesById[id] && nodesById[id].headline) {
        const m = nodesById[id];
        tip.innerHTML = "";
        tip.appendChild(h("div", "tt-date", m.title));
        const row = h("div", "tt-row"); const dot = h("i"); dot.style.background = STATUS_HEX[m.status] || STATUS_HEX.info;
        row.append(dot, h("b", null, headline(m)));
        tip.appendChild(row);
        tip.classList.add("show");
        tip.style.left = Math.min(stage.clientWidth - tip.offsetWidth - 8, e.clientX - r.left + 14) + "px";
        tip.style.top = Math.max(4, e.clientY - r.top - 40) + "px";
        canvas.style.cursor = "pointer";
      } else { tip.classList.remove("show"); canvas.style.cursor = dragging ? "grabbing" : "grab"; }
    } else if (id) {
      tip.style.left = Math.min(stage.clientWidth - tip.offsetWidth - 8, e.clientX - r.left + 14) + "px";
      tip.style.top = Math.max(4, e.clientY - r.top - 40) + "px";
    }
  });
  canvas.addEventListener("click", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit) select(hit.object.userData.id, true); else select(null, true);
  });

  function resize() {
    const w = stage.clientWidth, hh = stage.clientHeight;
    renderer.setSize(w, hh, false); camera.aspect = w / hh; camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize); resize();

  /* ---------------------------------------------------------------- selection */
  let selected = null, related = null, tick = 0;
  const nearestTheta = (t) => { while (t - cam.theta > Math.PI) t -= Math.PI * 2; while (t - cam.theta < -Math.PI) t += Math.PI * 2; return t; };
  function select(id, user) {
    if (user && tour.active && !tour.stepping) tour.stop();
    const node = id ? nodesById[id] : null;
    // clicking a metric moon: select its parent category, but keep the moon highlighted too
    const metricId = node && node.headline ? node.id : null;
    selected = node && node.headline ? node.__section : node;
    related = null;
    if (selected) {
      const set = new Set([selected.id]);
      if (selected.type === "overall") sections.forEach((s) => set.add(s.id));
      else selected.metrics.forEach((m) => set.add(m.id));
      related = set;
      if (selected.type === "overall") { goal.phi = 1.05; goal.r = isMobile ? 15 : 12.5; goal.target.set(0, 0, 0); }
      else { goal.theta = nearestTheta(Math.PI / 2 - selected.angle); goal.phi = 1.1; goal.r = isMobile ? 8.5 : 6.8; goal.target.set(selected.pos.x * 0.55, 0, selected.pos.z * 0.55); }
    } else { goal.phi = 1.05; goal.r = isMobile ? 15 : 12.5; goal.target.set(0, 0, 0); }
    viewShiftGoal = selected ? 1 : 0;
    lastInteract = performance.now();
    Object.keys(labelEls).forEach((k) => { labelEls[k].classList.toggle("dim", !!(related && !related.has(k))); labelEls[k].classList.toggle("sel", k === (selected && selected.id)); });
    renderPanel(metricId);
    document.body.classList.toggle("has-selection", !!selected);
    history.replaceState(null, "", selected ? "#" + selected.id : location.pathname);
  }

  /* ---------------------------------------------------------------- panel */
  const panel = $("#panel");
  let typing = null;
  function typewrite(el, text) {
    if (typing) cancelAnimationFrame(typing);
    if (reduced) { el.textContent = text; return; }
    el.textContent = ""; let i = 0;
    const step = () => { i += 3; el.textContent = text.slice(0, i); if (i < text.length) typing = requestAnimationFrame(step); };
    typing = requestAnimationFrame(step);
  }
  function headline(m) {
    const hd = m.headline;
    const v = fmtNum(hd.value, hd.unit === "$" ? "$" : "", hd.decimals, { signed: hd.signed, compact: Math.abs(hd.value) >= 1e5 });
    return v + (hd.unit === "%" ? "%" : hd.suffix || "");
  }
  function statChip(n, label, cls) { const s = h("div", "p-stat " + cls); s.append(h("div", "n", String(n)), h("div", "l", label)); return s; }
  function chip(id, label) { const c = h("button", "chip"); c.type = "button"; c.textContent = label; c.addEventListener("click", () => select(id, true)); return c; }
  function renderPanel(highlightMetric) {
    panel.replaceChildren();
    const n = selected;
    if (!n) { panel.hidden = true; return; }
    panel.hidden = false;
    const close = h("button", "panel-close", "✕"); close.type = "button"; close.setAttribute("aria-label", "Close"); close.addEventListener("click", () => select(null, true));
    panel.appendChild(close);
    panel.appendChild(h("div", "p-kicker", n.type === "overall" ? "Every measure on the Scorecard" : `Category · ${n.metrics.length} measure${n.metrics.length === 1 ? "" : "s"}`));
    panel.appendChild(h("h2", "p-title", n.type === "overall" ? "Overall" : n.title));
    const plain = h("p", "p-plain"); panel.appendChild(plain);
    typewrite(plain, n.type === "overall"
      ? "Every measure the Scorecard tracks, rolled into one figure. Click a sphere on the ring to open a category."
      : n.blurb);
    const row = h("div", "p-stat-row");
    row.append(statChip(n.off, "Off track", "fail"), statChip(n.watch, "Watch", "warn"), statChip(n.on, "On track", "pass"));
    panel.appendChild(row);
    panel.appendChild(h("div", "p-h", n.type === "overall" ? "Jump to a category" : "Measures in this category"));
    if (n.type === "overall") {
      const ul = h("div", "p-chips");
      sections.forEach((s) => ul.appendChild(chip(s.id, s.title)));
      panel.appendChild(ul);
    } else {
      const box = h("div", "p-live");
      n.metrics.forEach((m) => {
        const a = h("a", "live " + m.status); a.href = "index.html#" + m.id;
        if (m.id === highlightMetric) a.style.borderColor = "var(--hud)";
        a.appendChild(h("b", null, headline(m)));
        const t = h("span"); t.appendChild(h("i", null, m.title)); t.appendChild(document.createTextNode(" · " + m.headline.caption)); a.appendChild(t);
        box.appendChild(a);
      });
      panel.appendChild(box);
    }
    const cta = h("div", "p-cta");
    const a1 = h("a", "btn-hud", "Open on the Scorecard ↗");
    a1.href = n.type === "overall" ? "index.html" : "index.html#sec-" + n.id;
    cta.appendChild(a1);
    if (n.type !== "overall") { const back = h("button", "btn-hud", "◂ Overall"); back.type = "button"; back.addEventListener("click", () => select("overall", true)); cta.appendChild(back); }
    panel.appendChild(cta);
    panel.scrollTop = 0;
  }

  /* ---------------------------------------------------------------- guided tour */
  const tourSteps = [{ id: "overall", say: `The Scorecard tracks ${S.metrics_total} measures of government performance. Only ${S.metrics_on_track} of ${S.metrics_rated} rated measures are on track.` }]
    .concat(sections.map((s) => ({ id: s.id, say: `${s.title}: ${s.off} of ${s.rated} measures off track. ${s.blurb}` })))
    .concat([{ id: "overall", say: "That's every category. Click any sphere to explore it, or open a measure to see its source." }]);
  const tour = { active: false, i: 0, timer: null, stepping: false,
    start() { this.active = true; this.i = 0; document.body.classList.add("touring"); this.show(); },
    show() {
      const s = tourSteps[this.i]; this.stepping = true; select(s.id, false); this.stepping = false;
      $("#tour-say").textContent = ""; typewrite($("#tour-say"), s.say);
      $("#tour-count").textContent = `${this.i + 1} / ${tourSteps.length}`;
      clearTimeout(this.timer);
      if (!reduced) this.timer = setTimeout(() => this.next(), 8000);
    },
    next() { if (this.i < tourSteps.length - 1) { this.i++; this.show(); } else this.stop(); },
    prev() { if (this.i > 0) { this.i--; this.show(); } },
    stop() { this.active = false; clearTimeout(this.timer); document.body.classList.remove("touring"); },
  };
  $("#btn-tour").addEventListener("click", () => tour.start());
  $("#tour-next").addEventListener("click", () => tour.next());
  $("#tour-prev").addEventListener("click", () => tour.prev());
  $("#tour-exit").addEventListener("click", () => { tour.stop(); select(null, true); });
  $("#btn-reset").addEventListener("click", () => { tour.stop(); select(null, true); });
  $("#btn-text").addEventListener("click", () => { const t = $("#text-version"); t.hidden = !t.hidden; if (!t.hidden) t.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { tour.stop(); select(null, true); } });

  /* ---------------------------------------------------------------- ticker */
  (function () {
    const el = $("#ticker"); if (!el) return;
    const items = D.metrics.filter((m) => m.status !== "info").map((m) => `${m.title}: ${headline(m)} · ${m.headline.caption} (${m.headline.period})`);
    let i = 0; const show = () => { el.textContent = items[i % items.length]; i++; };
    show(); if (!reduced) setInterval(() => { el.classList.add("fade"); setTimeout(() => { show(); el.classList.remove("fade"); }, 350); }, 5000);
  })();

  /* ---------------------------------------------------------------- boot overlay */
  (function () {
    const boot = $("#boot"), lines = [...boot.querySelectorAll(".boot-line")];
    const done = () => { boot.classList.add("out"); setTimeout(() => (boot.hidden = true), 700); };
    if (reduced) { lines.forEach((l) => l.classList.add("on")); setTimeout(done, 300); return; }
    lines.forEach((l, i) => setTimeout(() => l.classList.add("on"), 250 + i * 300));
    setTimeout(done, 250 + lines.length * 300 + 450);
    boot.addEventListener("click", done);
  })();

  /* ---------------------------------------------------------------- render loop */
  const v3 = new THREE.Vector3();
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; tick += dt;
    const idle = now - lastInteract > 5000 && !dragging && !selected;
    if (idle && !reduced) goal.theta += dt * 0.06;
    cam.theta += (goal.theta - cam.theta) * (dragging ? 1 : 0.07);
    cam.phi += (goal.phi - cam.phi) * 0.07;
    cam.r += (goal.r - cam.r) * 0.07;
    cam.target.lerp(goal.target, 0.07);
    camera.position.set(cam.target.x + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta), cam.target.y + cam.r * Math.cos(cam.phi), cam.target.z + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta));
    camera.lookAt(cam.target);
    viewShift += (viewShiftGoal - viewShift) * 0.1;
    {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (viewShift > 0.01) {
        if (isMobile) { const Sh = Math.round(H * 0.5 * viewShift); camera.setViewOffset(W, H + Sh, 0, Sh, W, H); }
        else { const Sh = Math.round(Math.min(440, W * 0.36) * viewShift); camera.setViewOffset(W + Sh, H, Sh, 0, W, H); }
      } else camera.clearViewOffset();
    }
    if (!reduced) {
      rings.forEach((r) => (r.rotation.z += r.userData.spin * dt));
      sweepT = (sweepT + dt / 7) % 1; const sr = 0.4 + sweepT * (RING_R + 1); sweep.scale.set(sr, sr, 1); sweep.material.opacity = 0.45 * (1 - sweepT);
      const arr = pgeo.attributes.position.array;
      for (let i = 0; i < P; i++) arr[i * 3 + 1] += pvel[i] * dt * 0.3;
      pgeo.attributes.position.needsUpdate = true;
      meshes.overall.wire.rotation.y += dt * 0.14; meshes.overall.wire.rotation.x += dt * 0.05;
      meshes.overall.core.rotation.y += dt * 0.32;    // the flag globe spins, faster than its containment shell
      meshes.overall.sparkle.material.rotation += dt * 0.5;
    }
    const pulse = 0.5 + 0.5 * Math.sin(tick * 3);
    meshes.overall.halo.material.opacity = 0.2 + 0.07 * pulse;
    meshes.overall.shine.material.opacity = 0.38 + 0.16 * (0.5 + 0.5 * Math.sin(tick * 4.1));
    meshes.overall.sparkle.material.opacity = 0.28 + 0.24 * Math.abs(Math.sin(tick * 2.3));
    // moon orbits
    sections.forEach((s) => {
      const mm = meshes[s.id];
      mm.moons.forEach((mo) => {
        if (!reduced) mo.angle += dt * mo.speed;
        const r = s.moonR;
        const x = s.pos.x + r * Math.cos(mo.angle);
        const z = s.pos.z + r * Math.sin(mo.angle) * Math.cos(mo.tilt);
        const y = s.pos.y + r * Math.sin(mo.angle) * Math.sin(mo.tilt);
        mo.mesh.position.set(x, y, z); mo.halo.position.set(x, y, z);
        const isSel = hoverId === mo.id;
        mo.halo.material.opacity = isSel ? 0.42 : related && related.has(mo.id) && selected && selected.type !== "overall" ? 0.22 : 0.1;
        mo.mesh.material.opacity = related && !related.has(mo.id) ? 0.15 : 0.95;
      });
    });
    // spokes + category dim state — plus a small stream of orbs travelling inward from each planet to the sun
    spokes.forEach((sp) => {
      const dim = related && !(selected && selected.type === "overall") && !(selected && selected.id === sp.id);
      sp.line.material.opacity = selected && selected.type === "overall" ? 0.4 : dim ? 0.05 : 0.16;
      const pulseMax = dim ? 0.06 : 0.85;
      sp.pulses.forEach((p) => {
        if (!reduced) p.phase = (p.phase + dt * 0.09) % 1;
        const t = p.phase;
        p.mesh.position.set(sp.pos.x * (1 - t), sp.pos.y * (1 - t), sp.pos.z * (1 - t));
        p.mesh.material.opacity = pulseMax * Math.sin(t * Math.PI);
      });
    });
    sections.forEach((s) => {
      const mm = meshes[s.id]; const isSel = selected && selected.id === s.id; const dim = related && !related.has(s.id) && !isSel;
      mm.core.material.opacity = dim ? 0.015 : isSel ? 0.12 + 0.03 * pulse : 0.08;
      mm.inner.material.opacity = dim ? 0.1 : isSel ? 0.86 : 0.72;
      mm.halo.material.opacity = isSel ? 0.36 + 0.09 * pulse : dim ? 0.02 : 0.2;
    });
    renderer.render(scene, camera);
    // labels — categories/overall sit at a fixed offset above a static position; each measure's label
    // follows its moon, which is orbiting, so its position is read fresh from the mesh every frame.
    const W = stage.clientWidth, H = stage.clientHeight;
    Object.keys(labelEls).forEach((id) => {
      const el = labelEls[id];
      const mo = moonById[id];
      let px, py, pz;
      if (mo) { px = mo.mesh.position.x; py = mo.mesh.position.y + 0.15; pz = mo.mesh.position.z; }
      else { const node = nodesById[id]; px = node.pos.x; py = node.pos.y + node.radius + 0.14; pz = node.pos.z; }
      v3.set(px, py, pz).project(camera);
      const vis = v3.z < 1;
      const x = (v3.x + 1) / 2 * W, y = (1 - v3.y) / 2 * H;
      const depth = camera.position.distanceTo(new THREE.Vector3(px, py, pz));
      const scale = Math.max(mo ? 0.6 : 0.75, Math.min(1.05, 1.25 - depth / 22));
      el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      el.style.visibility = vis ? "visible" : "hidden";
      el.style.opacity = Math.max(mo ? 0.3 : 0.4, Math.min(1, 1.3 - depth / 26)).toFixed(2);
    });
    if (selected) { reticle.hidden = false; v3.set(selected.pos.x, selected.pos.y, selected.pos.z).project(camera);
      reticle.style.transform = `translate(-50%, -50%) translate(${((v3.x + 1) / 2 * W).toFixed(1)}px, ${((1 - v3.y) / 2 * H).toFixed(1)}px)`; }
    else reticle.hidden = true;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  const hash = location.hash.slice(1);
  if (hash && nodesById[hash]) setTimeout(() => select(hash, false), 1600);
  window.CategoryModel = { select, sections, overall };
})();
