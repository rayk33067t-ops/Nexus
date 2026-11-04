/**
 * The studio's architecture, lighting and atmosphere.
 * Deep blue + emerald NEXUS palette; per-character accent pads.
 * Quality "low" trims shadows, particles and pixel ratio for phones.
 */
import * as THREE from "../../vendor/three.module.min.js";

export const STAGE_RADIUS = 6.2;      // walkable floor radius (metres)

export function buildEnvironment(scene, renderer, { quality = "high" } = {}) {
  const env = new THREE.Group();
  env.name = "environment";
  scene.add(env);

  scene.background = new THREE.Color(0x020613);
  scene.fog = new THREE.FogExp2(0x030a1c, 0.045);

  // Image-based lighting from a small procedural "light room" so metals,
  // gems and floor pick up real reflections.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x040b1d);
  const panel = (color, intensity, pos, size) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.copy(pos); m.lookAt(0, 0, 0); room.add(m);
  };
  panel(0x9fd9ff, 3.0, new THREE.Vector3(0, 6, 3), [6, 2]);
  panel(0x10b981, 2.2, new THREE.Vector3(-6, 2, 0), [2, 6]);
  panel(0x1d4ed8, 2.0, new THREE.Vector3(6, 2, -2), [2, 6]);
  panel(0xffffff, 1.2, new THREE.Vector3(0, 2, 7), [4, 2]);
  scene.environment = pmrem.fromScene(room, 0.03).texture;
  scene.environmentIntensity = 0.75;

  // ---------- floor ----------
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(16, 96),
    new THREE.MeshStandardMaterial({ color: 0x050d1f, roughness: 0.22, metalness: 0.75 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = "floor";
  env.add(floor);

  // Inlaid emerald rings and radial lines.
  const glow = (color, o = 0.9) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: o, fog: true });
  const ring = (r, w, color, o) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 128), glow(color, o));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.003; env.add(m); return m;
  };
  ring(STAGE_RADIUS, 0.03, 0x10b981, 0.85);
  ring(STAGE_RADIUS + 0.35, 0.012, 0x1d4ed8, 0.6);
  ring(2.2, 0.01, 0x10b981, 0.35);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.012, STAGE_RADIUS - 2.3), glow(0x10b981, 0.18));
    line.rotation.x = -Math.PI / 2; line.rotation.z = -a;
    const mid = (STAGE_RADIUS + 2.2) / 2;
    line.position.set(Math.sin(a) * mid, 0.002, Math.cos(a) * mid);
    env.add(line);
  }

  // ---------- architecture: colonnade of pillars with emerald light strips ----------
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x0a1835, roughness: 0.35, metalness: 0.6 });
  const stripMat = new THREE.MeshBasicMaterial({ color: 0x34d399 });
  const blueStrip = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
  const pillars = 14;
  for (let i = 0; i < pillars; i++) {
    const a = (i / pillars) * Math.PI * 2 + 0.11;
    const r = 10.5;
    const g = new THREE.Group();
    g.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    g.lookAt(0, 0, 0);
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.7, 11, 0.7), pillarMat);
    p.position.y = 5.5; p.castShadow = quality === "high"; p.receiveShadow = true; g.add(p);
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 9.5, 0.02), i % 2 ? stripMat : blueStrip);
    s.position.set(0, 5.4, 0.36); g.add(s);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.25, 1.0), pillarMat);
    cap.position.y = 0.12; g.add(cap);
    env.add(g);
  }
  // Ceiling halo rings — scale and depth overhead.
  const halo = new THREE.Group();
  for (const [r, y, c] of [[10.5, 11, 0x10b981], [7.5, 9.6, 0x1d4ed8], [4.2, 8.4, 0x34d399]]) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 8, 160), new THREE.MeshBasicMaterial({ color: c }));
    t.rotation.x = Math.PI / 2; t.position.y = y; halo.add(t);
  }
  env.add(halo);

  // Holographic NEXUS ring floating above centre.
  const holo = new THREE.Mesh(
    new THREE.TorusGeometry(1.4, 0.012, 8, 120),
    new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.55 })
  );
  holo.position.y = 3.6; holo.rotation.x = Math.PI / 2;
  env.add(holo);

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0xc7d8ff, 0x0a1428, 0.7));
  const key = new THREE.DirectionalLight(0xe8f1ff, 2.2);
  key.position.set(3.5, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(quality === "high" ? 2048 : 1024, quality === "high" ? 2048 : 1024);
  key.shadow.camera.left = -6; key.shadow.camera.right = 6;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -2;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rimE = new THREE.PointLight(0x10b981, 14, 12, 2); rimE.position.set(-4.5, 3.4, -4); scene.add(rimE);
  const rimB = new THREE.PointLight(0x3b82f6, 18, 12, 2); rimB.position.set(4.5, 3.2, -4); scene.add(rimB);
  const fill = new THREE.PointLight(0xfff1e6, 10, 12, 2); fill.position.set(-1.5, 2.0, 4.5); scene.add(fill);

  // ---------- energy particles ----------
  const count = quality === "high" ? 900 : 280;
  const pos = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 9;
    pos[i * 3] = Math.sin(a) * r; pos[i * 3 + 1] = Math.random() * 9; pos[i * 3 + 2] = Math.cos(a) * r;
    speed[i] = 0.08 + Math.random() * 0.25;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    color: 0x6ee7b7, size: 0.035, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  env.add(particles);

  // ---------- character pads ----------
  const pads = {};
  function addPad(id, x, z, color) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.68, 0.04, 64),
      new THREE.MeshStandardMaterial({ color: 0x0a1630, roughness: 0.2, metalness: 0.8 }));
    disc.position.y = 0.02; disc.receiveShadow = true; g.add(disc);
    const r = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.66, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    r.rotation.x = -Math.PI / 2; r.position.y = 0.045; g.add(r);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.66, 3.2, 48, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    beam.position.y = 1.6; g.add(beam);
    const light = new THREE.PointLight(color, 4, 3.2, 2); light.position.y = 0.3; g.add(light);
    g.userData = { ring: r, beam, light, baseOpacity: 0.05 };
    env.add(g);
    pads[id] = g;
    return g;
  }

  function update(t, dt) {
    holo.rotation.z = t * 0.15;
    holo.position.y = 3.6 + Math.sin(t * 0.6) * 0.08;
    halo.rotation.y = t * 0.02;
    const a = pGeo.attributes.position;
    for (let i = 0; i < count; i++) {
      let y = a.array[i * 3 + 1] + speed[i] * dt;
      if (y > 9) y = 0;
      a.array[i * 3 + 1] = y;
    }
    a.needsUpdate = true;
  }

  function highlightPad(id) {
    for (const [pid, g] of Object.entries(pads)) {
      const on = pid === id;
      g.userData.beam.material.opacity = on ? 0.07 : 0.025;
      g.userData.light.intensity = on ? 3 : 1.2;
    }
  }

  return { env, floor, pads, addPad, update, highlightPad, key };
}
