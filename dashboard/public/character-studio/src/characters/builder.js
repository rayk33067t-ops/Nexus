/**
 * Procedural character builder.
 *
 * Builds an articulated figure from primitives: a hierarchy of joint groups
 * (a procedural skeleton) with rigid body segments attached. This is a
 * PROTOTYPE, not a production character:
 *   - rigid segments, no skinned mesh, so joints show seams when bent hard
 *   - stylized, not photoreal; faces are simple shapes
 *   - mouth movement is a jaw/lip open value, not phoneme lip-sync
 *
 * Each character gets its own proportions, hair construction, suit cut and
 * accessories from its profile — not one model recoloured.
 *
 * Returned rig: { root, joints, face, fingers, dims, profileId }
 */
import * as THREE from "../../vendor/three.module.min.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.0, ...opts });
}
function fabric(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.62, metalness: 0.0, sheen: 0.6, sheenRoughness: 0.5,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35), ...opts,
  });
}
function gem(color, glow = 0.35) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.05, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05,
    emissive: color, emissiveIntensity: glow, flatShading: true,
  });
}
function metal(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 1.0 });
}

function mesh(geo, mat, parent, pos, rot, scale) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  if (pos) m.position.copy(pos);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  if (parent) parent.add(m);
  return m;
}
function joint(name, parent, pos) {
  const g = new THREE.Group();
  g.name = name;
  if (pos) g.position.copy(pos);
  parent.add(g);
  return g;
}
/** Lathe from [radius, y] pairs, bottom to top. */
function lathe(points, segments = 28) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}
/** Capsule hanging downward from its joint origin, length L. */
function limbDown(parent, r, L, mat, rBottom) {
  const geo = rBottom === undefined
    ? new THREE.CapsuleGeometry(r, Math.max(0.001, L - 2 * r), 6, 16)
    : lathe([[0, -r], [rBottom * 0.8, -rBottom * 0.4 + 0], [rBottom, 0], [r, L], [r * 0.8, L + r * 0.45], [0, L + r * 0.6]].map(([a, b]) => [a, b]), 18);
  const m = mesh(geo, mat, parent);
  if (rBottom === undefined) m.position.y = -L / 2;
  else { m.rotation.x = Math.PI; m.position.y = 0; }
  return m;
}

export function buildCharacter(profile) {
  const P = profile.palette;
  const B = profile.body;
  const H = profile.heightM.value;
  const k = H / 1.70;               // overall scale vs base figure
  const build = B.build;

  const mats = {
    suit: fabric(P.suit),
    suitDark: fabric(P.suitDark),
    shirt: fabric(P.shirt, { roughness: 0.4 }),
    skin: std(P.skin, { roughness: 0.55 }),
    lips: std(P.lips, { roughness: 0.4 }),
    hair: new THREE.MeshStandardMaterial({ color: P.hair, roughness: 0.42, metalness: 0.15 }),
    hl: new THREE.MeshStandardMaterial({ color: P.hairHighlight, roughness: 0.35, metalness: 0.25, emissive: P.hairHighlight, emissiveIntensity: 0.12 }),
    white: std(0xf4f1ec, { roughness: 0.25 }),
    iris: new THREE.MeshStandardMaterial({ color: P.iris, roughness: 0.2, emissive: P.iris, emissiveIntensity: 0.25 }),
    pupil: std(0x050505, { roughness: 0.1 }),
    brow: std(P.hair === 0xb59a6a ? 0x7a6040 : 0x141012, { roughness: 0.8 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0x0a0a0f, roughness: 0.25, metalness: 0.3 }),
    mouthIn: std(0x2a0a0e, { roughness: 0.9 }),
    accent: gem(P.accent),
    accent2: gem(P.accent2, 0.2),
    metal: metal(P.metal),
  };

  // ---------- dimensions ----------
  const legLen = H * B.legRatio;                  // floor to hip joint
  const thighL = legLen * 0.49, shinL = legLen * 0.45, ankleH = legLen * 0.06;
  const torsoL = H * 0.29 * (2 - B.legRatio / 0.53) * 0.98;
  const neckL = H * 0.03 * B.neck;
  const headR = 0.108 * k * B.head;
  const shoulderHalf = 0.152 * k * B.shoulders;
  const hipHalf = 0.082 * k * B.hips;
  const upperArmL = H * 0.172, foreArmL = H * 0.148;
  const armR = 0.03 * k * build, legR = 0.056 * k * build * B.hips;

  const root = new THREE.Group();
  root.name = profile.id;
  const joints = {};

  // ---------- pelvis & torso ----------
  joints.hips = joint("hips", root, V(0, legLen, 0));
  const pelvis = mesh(lathe([[0.02, -0.075], [hipHalf + legR * 0.8, -0.05], [hipHalf + legR * 0.95, 0.02], [0.128 * k * B.hips, 0.08], [0.1 * k, 0.12]]), mats.suitDark, joints.hips);
  pelvis.scale.z = 0.72;

  joints.spine = joint("spine", joints.hips, V(0, 0.11 * k, 0));
  joints.chest = joint("chest", joints.spine, V(0, torsoL * 0.42, 0));

  // Jacket body: waist up to shoulders, cut varies per character.
  const w = 0.092 * k * build, sh = shoulderHalf;
  const jacketPts = [[w * 1.32, -torsoL * 0.44], [w * 1.12, -torsoL * 0.3], [w * 0.98, -torsoL * 0.16], [w * 1.08, torsoL * 0.02], [w * 1.22, torsoL * 0.18], [sh * 0.86, torsoL * 0.36], [sh * 0.7, torsoL * 0.47], [0.046 * k, torsoL * 0.55]];
  const jacket = mesh(lathe(jacketPts, 36), mats.suit, joints.chest);
  jacket.scale.z = 0.7;
  // Bust shaping under the jacket.
  for (const s of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.05 * k * build, 20, 14), mats.suit, joints.chest, V(s * 0.046 * k, torsoL * 0.15, 0.036 * k), null, [1, 0.9, 0.82]);
  }

  // Hem/skirt of the jacket below the waist, the main silhouette difference.
  const cut = profile.suitCut;
  const hipW = w * 1.32;
  const hemPts = cut === "flared"
    ? [[0.19 * k * B.hips, -0.15], [0.165 * k * B.hips, -0.09], [hipW * 1.05, -0.02], [hipW, 0.0]]       // peplum flare
    : cut === "structured"
      ? [[0.142 * k * B.hips, -0.17], [0.138 * k * B.hips, -0.08], [hipW * 1.02, 0.0]]                    // longer straight hem
      : [[0.136 * k * B.hips, -0.1], [0.133 * k * B.hips, -0.05], [hipW * 1.01, 0.0]];                    // tailored, short
  const hem = mesh(lathe(hemPts, 36), mats.suit.clone(), joints.chest, V(0, -torsoL * 0.44, 0));
  hem.scale.z = 0.72;
  hem.material.side = THREE.DoubleSide;

  // Shirt V and lapels at the front of the chest.
  const frontZ = 0.072 * k * build;
  const vShape = new THREE.Shape();
  vShape.moveTo(-0.045 * k, 0.15 * k); vShape.lineTo(0.045 * k, 0.15 * k); vShape.lineTo(0, -0.05 * k); vShape.closePath();
  mesh(new THREE.ShapeGeometry(vShape), mats.shirt, joints.chest, V(0, torsoL * 0.2, frontZ + 0.013));
  for (const s of [-1, 1]) {
    mesh(new THREE.BoxGeometry(0.03 * k, 0.21 * k, 0.008), mats.suitDark, joints.chest,
      V(s * 0.04 * k, torsoL * 0.2 + 0.05 * k, frontZ + 0.016), [0.1, 0, -s * 0.22]);
  }

  // Character-specific chest details.
  if (profile.id === "genesis") {
    // Emerald NEXUS emblem: faceted gem in a metal hexagon ring, left chest.
    const em = joint("emblem", joints.chest, V(0.07 * k, torsoL * 0.27, frontZ + 0.014));
    mesh(new THREE.TorusGeometry(0.021 * k, 0.004 * k, 6, 6), mats.metal, em, null, [0, 0, Math.PI / 6]);
    mesh(new THREE.OctahedronGeometry(0.016 * k), mats.accent, em, null, [0, Math.PI / 4, 0], [1, 1.25, 0.55]);
    // Jacket buttons, emerald.
    for (let i = 0; i < 2; i++) mesh(new THREE.SphereGeometry(0.008 * k, 10, 8), mats.accent, joints.chest, V(0, -torsoL * 0.08 - i * 0.07 * k, frontZ + 0.006));
  } else if (profile.id === "savannah") {
    // Ruby lapel pin and a ruby collar clasp; tall structured collar.
    mesh(new THREE.OctahedronGeometry(0.013 * k), mats.accent, joints.chest, V(-0.072 * k, torsoL * 0.27, frontZ + 0.016), [0, 0, 0], [1, 1.3, 0.6]);
    const collar = mesh(lathe([[0.062 * k, 0], [0.066 * k, 0.03 * k], [0.07 * k, 0.065 * k]], 24), mats.suitDark, joints.chest, V(0, torsoL * 0.5, -0.004));
    collar.material = mats.suitDark.clone(); collar.material.side = THREE.DoubleSide;
    collar.scale.z = 0.92;
    for (let i = 0; i < 3; i++) mesh(new THREE.SphereGeometry(0.007 * k, 10, 8), mats.accent, joints.chest, V(0.02 * k, -torsoL * 0.05 - i * 0.06 * k, frontZ + 0.006));
    // Citrine-and-gold belt line.
    mesh(new THREE.TorusGeometry(w * 1.02, 0.006 * k, 6, 32), mats.metal, joints.chest, V(0, -torsoL * 0.36, 0), [Math.PI / 2, 0, 0], [1, 0.68, 1]);
  } else {
    // Aria: pink diamond buttons, rose-gold necklace with diamond pendant.
    for (let i = 0; i < 3; i++) mesh(new THREE.OctahedronGeometry(0.01 * k), mats.accent, joints.chest, V(0, -torsoL * 0.06 - i * 0.06 * k, frontZ + 0.008), [0, Math.PI / 4, 0], [1, 1.2, 0.6]);
    const neckY = torsoL * 0.5;
    mesh(new THREE.TorusGeometry(0.06 * k, 0.0035 * k, 6, 32), mats.metal, joints.chest, V(0, neckY - 0.02 * k, 0.012 * k), [Math.PI / 2 + 0.55, 0, 0], [1, 0.8, 1]);
    mesh(new THREE.OctahedronGeometry(0.014 * k), mats.accent, joints.chest, V(0, neckY - 0.072 * k, frontZ + 0.02), [0, Math.PI / 4, 0], [1, 1.35, 0.7]);
  }

  // ---------- neck & head ----------
  joints.neck = joint("neck", joints.chest, V(0, torsoL * 0.53, -0.004));
  mesh(new THREE.CylinderGeometry(0.04 * k, 0.047 * k, neckL + 0.06 * k, 20), mats.skin, joints.neck, V(0, neckL / 2 + 0.005 * k, 0));

  joints.head = joint("head", joints.neck, V(0, neckL + 0.02 * k, 0.006 * k));
  const headC = V(0, headR * 0.95, 0);
  // Cranium + softer, narrower lower face (jaw width from profile).
  const cranium = mesh(new THREE.SphereGeometry(headR, 36, 28), mats.skin, joints.head, headC, null, [0.84, 1.0 * B.faceLength, 0.96]);
  cranium.name = "cranium";
  const jaw = mesh(new THREE.SphereGeometry(headR * 0.78, 28, 18), mats.skin, joints.head, V(0, headR * 0.56, headR * 0.14), null, [0.74 * B.jaw, 0.9 * B.faceLength, 0.84]);
  // Nose: slim bridge and soft tip.
  mesh(new THREE.CylinderGeometry(headR * 0.045, headR * 0.075, headR * 0.34, 10), mats.skin, joints.head, V(0, headR * 0.86, headR * 0.86), [0.32, 0, 0]);
  mesh(new THREE.SphereGeometry(headR * 0.075, 12, 10), mats.skin, joints.head, V(0, headR * 0.71, headR * 0.93), null, [1.15, 0.85, 1]);
  // Ears.
  for (const s of [-1, 1]) mesh(new THREE.SphereGeometry(headR * 0.16, 10, 8), mats.skin, joints.head, V(s * headR * 0.83, headR * 0.9, -headR * 0.02), null, [0.45, 1, 0.7]);

  // Eyes: each eye is a group that rotates to aim; upper lids rotate to blink.
  const face = { brows: [], eyes: [], lids: [] };
  const eyeR = headR * 0.15;
  for (const s of [-1, 1]) {
    const socket = joint(s < 0 ? "eyeSocketR" : "eyeSocketL", joints.head, V(s * headR * 0.31, headR * 1.0, headR * 0.79));
    const eye = joint("eye", socket, null);
    mesh(new THREE.SphereGeometry(eyeR, 24, 16), mats.white, eye);
    mesh(new THREE.SphereGeometry(eyeR * 0.6, 20, 12), mats.iris, eye, V(0, 0, eyeR * 0.74), null, [1, 1, 0.5]);
    mesh(new THREE.SphereGeometry(eyeR * 0.28, 14, 10), mats.pupil, eye, V(0, 0, eyeR * 0.94), null, [1, 1, 0.4]);
    mesh(new THREE.SphereGeometry(eyeR * 0.09, 8, 6), mats.white, eye, V(eyeR * 0.2, eyeR * 0.2, eyeR * 1.04));   // catch-light
    // Lower lid line keeps the eye almond-shaped.
    mesh(new THREE.TorusGeometry(eyeR * 1.02, eyeR * 0.07, 6, 18, Math.PI), mats.skin, socket, null, [0, 0, Math.PI]);
    // Upper lid shell + thick lash line with an outer flick.
    const lid = joint("lid", socket, null);
    mesh(new THREE.SphereGeometry(eyeR * 1.1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), mats.skin, lid);
    const lash = mesh(new THREE.TorusGeometry(eyeR * 1.08, eyeR * 0.15, 6, 20, Math.PI), mats.pupil, lid, null, [Math.PI / 2, 0, 0]);
    lash.rotation.set(Math.PI / 2, 0, 0);
    mesh(new THREE.ConeGeometry(eyeR * 0.14, eyeR * 0.6, 6), mats.pupil, lid, V(s * eyeR * 1.15, 0, eyeR * 0.05), [0, 0, -s * 1.1]);
    face.eyes.push(eye); face.lids.push(lid);
    // Arched brow.
    const brow = mesh(new THREE.TorusGeometry(eyeR * 1.7, eyeR * 0.13, 5, 16, Math.PI * 0.55), mats.brow, joints.head,
      V(s * headR * 0.32, headR * 1.12, headR * 0.86), [0, s * 0.25, Math.PI * 0.22]);
    brow.scale.set(1, 0.7, 1);
    brow.userData.baseY = brow.position.y; brow.userData.side = s; brow.userData.baseRz = brow.rotation.z;
    face.brows.push(brow);
  }

  // Mouth: interior, fuller upper lip on the head, lower lip on a jaw joint.
  const mouthY = headR * 0.5;
  mesh(new THREE.SphereGeometry(headR * 0.14, 16, 10), mats.mouthIn, joints.head, V(0, mouthY - headR * 0.02, headR * 0.8), null, [1.1, 0.45, 0.4]);
  const upperLip = mesh(new THREE.CapsuleGeometry(headR * 0.034, headR * 0.15, 4, 12), mats.lips, joints.head, V(0, mouthY + headR * 0.03, headR * 0.84), [0, 0, Math.PI / 2], [1, 1, 0.7]);
  const jawJ = joint("jaw", joints.head, V(0, mouthY, headR * 0.3));
  const lowerLip = mesh(new THREE.CapsuleGeometry(headR * 0.042, headR * 0.13, 4, 12), mats.lips, jawJ, V(0, -headR * 0.04, headR * 0.53), [0, 0, Math.PI / 2], [1, 1, 0.7]);
  const corners = [-1, 1].map((s) => mesh(new THREE.SphereGeometry(headR * 0.028, 8, 6), mats.lips, joints.head, V(s * headR * 0.15, mouthY + headR * 0.005, headR * 0.81)));
  corners.forEach((c, i) => { c.userData.baseY = c.position.y; c.userData.side = i ? 1 : -1; });
  Object.assign(face, { jaw: jawJ, upperLip, lowerLip, corners, chin: jaw });

  // ---------- hair ----------
  buildHair(profile.hairStyle, joints.head, headR, headC, mats, k, B.faceLength);

  // ---------- earrings ----------
  for (const s of [-1, 1]) {
    const at = V(s * headR * 0.86, headR * 0.72, 0);
    if (profile.id === "genesis") mesh(new THREE.OctahedronGeometry(headR * 0.08), mats.accent, joints.head, at, [0, 0.6, 0], [1, 1.3, 1]);
    else if (profile.id === "savannah") mesh(new THREE.SphereGeometry(headR * 0.06, 10, 8), mats.accent, joints.head, at);
    else {
      mesh(new THREE.TorusGeometry(headR * 0.13, headR * 0.018, 8, 24), mats.metal, joints.head, V(at.x, at.y - headR * 0.12, at.z), [0, Math.PI / 2, 0]);
      mesh(new THREE.OctahedronGeometry(headR * 0.05), mats.accent, joints.head, V(at.x, at.y - headR * 0.26, at.z), null, [1, 1.3, 1]);
    }
  }

  // ---------- arms ----------
  const fingers = { L: [], R: [] };
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    const shoulder = joints["shoulder" + side] = joint("shoulder" + side, joints.chest, V(s * (sh - armR * 0.6), torsoL * 0.42, -0.005));
    // Shoulder cap (pads differ by suit cut).
    const pad = cut === "structured" ? 1.25 : cut === "flared" ? 0.95 : 1.1;
    mesh(new THREE.SphereGeometry(armR * 1.18 * pad, 16, 12), mats.suit, shoulder, V(0, -armR * 0.15, 0), null, [1.05, 0.8, 1.0]);
    limbDown(shoulder, armR * 1.05, upperArmL, mats.suit);
    const elbow = joints["elbow" + side] = joint("elbow" + side, shoulder, V(0, -upperArmL, 0));
    limbDown(elbow, armR * 0.92, foreArmL, mats.suit);
    // Cuff + accessory on the wrist.
    const wrist = joints["wrist" + side] = joint("wrist" + side, elbow, V(0, -foreArmL, 0));
    mesh(new THREE.CylinderGeometry(armR * 0.95, armR * 0.95, 0.025 * k, 14), mats.shirt, wrist, V(0, 0.018 * k, 0));
    if (side === "L") {
      const accMat = profile.id === "genesis" ? mats.accent : mats.metal;
      mesh(new THREE.TorusGeometry(armR * 0.82, 0.005 * k, 6, 20), accMat, wrist, V(0, -0.004, 0), [Math.PI / 2, 0, 0]);
    }
    // Hand: palm plus four fingers and a thumb, each finger curlable.
    const hand = joint("hand" + side, wrist, V(0, -0.012 * k, 0));
    mesh(new THREE.BoxGeometry(0.068 * k * build, 0.078 * k, 0.026 * k), mats.skin, hand, V(0, -0.04 * k, 0), null);
    for (let f = 0; f < 4; f++) {
      const fx = (-0.024 + f * 0.016) * k * build * -s;
      const fj = joint("finger", hand, V(fx, -0.078 * k, 0));
      const len = (f === 1 || f === 2 ? 0.068 : 0.058) * k;
      limbDown(fj, 0.0075 * k, len, mats.skin);
      fingers[side].push(fj);
    }
    const th = joint("thumb", hand, V(-s * 0.032 * k, -0.03 * k, 0.014 * k));
    th.rotation.z = -s * 0.5;
    limbDown(th, 0.009 * k, 0.05 * k, mats.skin);
    fingers[side].push(th);
  }

  // ---------- legs ----------
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    const hip = joints["hip" + side] = joint("hip" + side, joints.hips, V(s * hipHalf, 0, 0));
    limbDown(hip, legR, thighL, mats.suitDark);
    const knee = joints["knee" + side] = joint("knee" + side, hip, V(0, -thighL, 0));
    limbDown(knee, legR * 0.78, shinL, mats.suitDark);
    const ankle = joints["ankle" + side] = joint("ankle" + side, knee, V(0, -shinL, 0));
    // Shoe: pointed for Aria, sleek for Genesis, low block for Savannah.
    const toe = profile.id === "aria" ? 1.15 : profile.id === "savannah" ? 0.95 : 1.05;
    mesh(new THREE.SphereGeometry(0.05 * k, 16, 10), mats.shoe, ankle, V(0, -ankleH * 0.55, 0.045 * k), null, [0.75, 0.5, 2.1 * toe]);
    mesh(new THREE.CylinderGeometry(legR * 0.62, legR * 0.7, ankleH, 12), mats.suitDark, ankle, V(0, -ankleH * 0.1, 0));
  }

  root.traverse((o) => { if (o.isMesh) o.userData.characterId = profile.id; });

  // Calibrate: scale the whole figure so the top of the skull (not the hair)
  // is exactly the profile height. Joint values stay in local units.
  root.updateMatrixWorld(true);
  const skullTop = new THREE.Box3().setFromObject(cranium).max.y;
  const scale = H / skullTop;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const eyeLocal = new THREE.Vector3();
  face.eyes[0].getWorldPosition(eyeLocal);              // root at origin, so world == root frame
  const eyeHeightWorld = eyeLocal.y;

  return {
    root, joints, face, fingers, profileId: profile.id,
    dims: { height: H, scale, legLen, thighL, shinL, headR, eyeHeight: eyeHeightWorld / scale, eyeHeightWorld },
    materials: mats,
  };
}

// ---------- hair styles ----------
/**
 * Hair is built from sculpted shells (partial spheres with displaced
 * vertices) plus strand groups, so each style has its own silhouette.
 */
function hairShell(r, { thetaLen = Math.PI * 0.6, open = 0, waves = 0, waveAmp = 0, flare = 0 } = {}) {
  // `open` = half-angle of the face opening, centred on +z.
  const phiStart = Math.PI / 2 + open, phiLen = Math.PI * 2 - 2 * open;
  const geo = new THREE.SphereGeometry(r, 48, 32, phiStart, phiLen, 0, thetaLen);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const theta = Math.acos(THREE.MathUtils.clamp(v.y / r, -1, 1));
    const phi = Math.atan2(v.z, -v.x);
    let k = 1;
    if (waves) k += Math.sin(phi * waves) * waveAmp * (theta / thetaLen);
    if (flare) k += flare * Math.pow(theta / thetaLen, 2);
    v.x *= k; v.z *= k;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function buildHair(style, head, r, c, m, k, faceLen) {
  const hairMat = m.hair.clone(); hairMat.side = THREE.DoubleSide;
  // Tilted cap: hairline above the forehead, reaching the nape behind.
  const cap = (scale) => mesh(new THREE.SphereGeometry(r * 1.07, 40, 24, 0, Math.PI * 2, 0, Math.PI * 0.56), m.hair, head, V(c.x, c.y, c.z - r * 0.03), [-0.78, 0, 0], scale);
  const blob = (x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0, mat = m.hair) => mesh(new THREE.SphereGeometry(r, 28, 18), mat, head, V(x, y, z), [rx, ry, rz], [sx, sy, sz]);
  const strand = (x, y, z, len, rx, ry, rz, mat = m.hl, w = 0.055) => mesh(new THREE.CapsuleGeometry(r * w, len, 4, 8), mat, head, V(x, y, z), [rx, ry, rz]);

  if (style === "sweptUp") {
    // Genesis: sleek sides, a sculpted wave of volume swept up and back off the forehead, low chignon.
    cap([0.92, 1.0 * faceLen, 1.0]);
    const crown = mesh(hairShell(r * 1.0, { thetaLen: Math.PI * 0.42 }), hairMat, head, V(0, c.y + r * 0.42, -r * 0.08), [-0.35, 0, 0], [0.92, 0.95, 1.05]);
    crown.castShadow = true;
    blob(0, c.y + r * 0.86, r * 0.32, 0.72, 0.36, 0.62, -0.6);              // the lifted front wave
    blob(-r * 0.2, c.y + r * 0.92, r * 0.05, 0.6, 0.32, 0.7, -0.4, 0, 0.18);
    blob(0, c.y - r * 0.12, -r * 1.0, 0.44, 0.36, 0.34);                   // chignon
    for (let i = 0; i < 6; i++) {                                          // emerald highlights following the sweep
      const x = (-0.45 + i * 0.18) * r;
      strand(x, c.y + r * 0.98, r * (0.12 - Math.abs(x / r) * 0.2), r * 0.62, -1.25, 0, x / r * 0.5);
    }
    strand(r * 0.45, c.y + r * 0.55, -r * 0.68, r * 0.55, -0.5, 0, 0.55);
    strand(-r * 0.45, c.y + r * 0.55, -r * 0.68, r * 0.55, -0.5, 0, -0.55);
  } else if (style === "shoulderWaves") {
    // Savannah: deep side part, smooth waved curtain to the shoulders, open at the face.
    cap([0.94, 1.0 * faceLen, 1.02]);
    const curtain = mesh(hairShell(r * 1.08, { thetaLen: Math.PI * 0.82, open: 0.95, waves: 9, waveAmp: 0.05, flare: 0.28 }), hairMat, head,
      V(0, c.y - r * 0.6, -r * 0.06), null, [0.98, 1.55, 1.0]);
    curtain.castShadow = true;
    blob(-r * 0.22, c.y + r * 0.98, r * 0.26, 0.66, 0.24, 0.55, -0.55, 0, 0.28);   // side-swept fringe
    blob(r * 0.74, c.y + r * 0.45, r * 0.38, 0.16, 0.46, 0.26, 0.15, 0, 0.2);      // face-framing sweep
    for (let i = 0; i < 4; i++) strand((-0.55 + i * 0.25) * r, c.y + r * 0.88, r * 0.18, r * 0.55, -1.0, 0, 0.4);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {                   // citrine ribbons down the waves
      const a = s * (1.25 + i * 0.32);
      strand(Math.sin(a) * r * 1.06, c.y - r * 0.45, Math.cos(a) * r * 1.0, r * 1.1, 0, 0, s * 0.12);
    }
  } else {
    // Aria: dramatic upward crown, high top knot with a rose-gold cuff, face-framing tendrils.
    cap([0.92, 1.0 * faceLen, 1.0]);
    mesh(hairShell(r * 1.0, { thetaLen: Math.PI * 0.5 }), hairMat, head, V(0, c.y + r * 0.5, -r * 0.04), [-0.15, 0, 0], [0.86, 1.15, 0.98]);
    blob(0, c.y + r * 1.62, -r * 0.14, 0.42, 0.42, 0.42);                    // top knot
    blob(0, c.y + r * 1.2, -r * 0.1, 0.3, 0.3, 0.3);
    mesh(new THREE.TorusGeometry(r * 0.3, r * 0.055, 10, 28), m.metal, head, V(0, c.y + r * 1.32, -r * 0.13), [Math.PI / 2 + 0.15, 0, 0]);
    for (let i = 0; i < 8; i++) {                                            // pink highlights rising into the knot
      const a = (i / 8) * Math.PI * 2;
      strand(Math.cos(a) * r * 0.5, c.y + r * 1.05, -r * 0.1 + Math.sin(a) * r * 0.5, r * 0.62, Math.sin(a) * 0.62, 0, -Math.cos(a) * 0.62);
    }
    for (const s of [-1, 1]) strand(s * r * 0.8, c.y + r * 0.02, r * 0.42, r * 0.8, 0.12, 0, s * 0.15, m.hair, 0.045);
    strand(r * 0.8, c.y + r * 0.0, r * 0.46, r * 0.62, 0.12, 0, 0.15, m.hl, 0.022);
  }
}
