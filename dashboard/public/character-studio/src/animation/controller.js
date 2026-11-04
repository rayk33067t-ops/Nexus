/**
 * Animation controller — one instance per character.
 *
 * Fully procedural: every frame the pose is computed from the controller's
 * live state (position, velocity, heading, gesture timers, look target,
 * mouth value). Nothing is a pre-recorded clip pretending to be a command.
 *
 * Truthfulness rule: events describe what the controller measured, never
 * what it hoped. "arrived" is emitted only after the measured distance to the
 * target is under ARRIVE_EPS; "stopped" reports the real resting position.
 */
import * as THREE from "../../vendor/three.module.min.js";

export const ARRIVE_EPS = 0.06;     // metres
export const TURN_EPS = 0.03;       // radians
const TAU = Math.PI * 2;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const smooth = (x) => x * x * (3 - 2 * x);

export const GESTURES = Object.freeze(["signature", "wave", "nod"]);
export const EXPRESSIONS = Object.freeze({
  neutral:   { smile: 0.15, brow: 0.0, furrow: 0.0, lid: 0.0 },
  smile:     { smile: 0.9, brow: 0.15, furrow: 0.0, lid: 0.1 },
  focused:   { smile: 0.0, brow: -0.2, furrow: 0.6, lid: 0.18 },
  concerned: { smile: -0.4, brow: 0.35, furrow: 0.5, lid: 0.05 },
  warm:      { smile: 0.6, brow: 0.3, furrow: 0.0, lid: 0.12 },
});

export class AnimationController {
  /**
   * @param rig      result of buildCharacter()
   * @param profile  PROFILES entry
   * @param opts     { boundsRadius, getObstacles: () => [{id, position}], rng }
   */
  constructor(rig, profile, opts = {}) {
    this.rig = rig;
    this.profile = profile;
    this.anim = profile.animation;
    this.id = profile.id;
    this.boundsRadius = opts.boundsRadius ?? 6;
    this.getObstacles = opts.getObstacles ?? (() => []);
    this.rng = opts.rng ?? Math.random;
    this.listeners = new Set();

    this.time = 0;
    this.heading = rig.root.rotation.y;
    this.targetHeading = null;
    this.velocity = new THREE.Vector3();
    this.drive = null;                // {x, z} unit-ish vector while a stick/key is held
    this.target = null;               // THREE.Vector3 moveTo target
    this.walkWeight = 0;
    this.phase = 0;
    this.moving = false;
    this.course = null;

    this.gesture = null;              // {name, t, dur}
    this.lookMode = "idle";           // idle | around | point
    this.lookPoint = null;
    this.lookAroundT = 0;
    this.headYaw = 0; this.headPitch = 0;
    this.glance = { yaw: 0, pitch: 0, next: 1 + this.rng() * 3 };

    this.blinkT = 0; this.nextBlink = 1.5 + this.rng() * 3;
    this.blinkCount = 0;
    this.mouth = 0;                   // 0..1 set by the voice controller
    this.mouthSmoothed = 0;
    this.expressionName = "neutral";
    this.expr = { ...EXPRESSIONS.neutral };
    this.lastEvents = [];
  }

  // ---------- events ----------
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, detail = {}) {
    const ev = { type, character: this.id, t: +this.time.toFixed(3), detail };
    this.lastEvents.push(ev);
    if (this.lastEvents.length > 200) this.lastEvents.shift();
    for (const fn of this.listeners) fn(ev);
    return ev;
  }

  get position() { return this.rig.root.position; }

  // ---------- commands ----------
  moveTo(x, z, source = "control") {
    const p = new THREE.Vector3(x, 0, z);
    const max = this.boundsRadius;
    if (p.length() > max) { p.setLength(max); this.emit("target-clamped", { requested: [x, z], clampedTo: [+p.x.toFixed(2), +p.z.toFixed(2)] }); }
    this.target = p;
    this.drive = null;
    this.targetHeading = null;
    this.emit("command", { command: "moveTo", x: +p.x.toFixed(2), z: +p.z.toFixed(2), source });
    return p;
  }

  /** Continuous steering: direction in world XZ (length ≤ 1), or null to release. */
  setDrive(dir, source = "control") {
    if (dir && Math.hypot(dir.x, dir.z) > 0.05) {
      if (!this.drive) this.emit("command", { command: "drive", source });
      this.drive = { x: dir.x, z: dir.z };
      this.target = null;
      this.targetHeading = null;
    } else if (this.drive) {
      this.drive = null;
      this.emit("command", { command: "release", source });
    }
  }

  stop(source = "control") {
    this.emit("command", { command: "stop", source });
    const had = !!(this.target || this.drive || this.course);
    this.target = null; this.drive = null; this.targetHeading = null;
    if (this.course) { this.emit("course-aborted", { reached: this.course.reached, of: this.course.points.length }); this.course = null; }
    if (!this.moving) {
      this.emit("stopped", { position: this.posArr(), ...(had ? {} : { note: "was already still" }) });
      this._pendingStopReport = false;
    } else {
      this._pendingStopReport = true;   // reported when the measured speed reaches zero
    }
  }

  turnBy(delta, source = "control") {
    this.target = null; this.drive = null;
    this.targetHeading = wrapAngle((this.targetHeading ?? this.heading) + delta);
    this.emit("command", { command: "turn", degrees: +(delta * 180 / Math.PI).toFixed(1), source });
  }
  turnTo(angle, source = "control") {
    this.target = null; this.drive = null;
    this.targetHeading = wrapAngle(angle);
    this.emit("command", { command: "turnTo", degrees: +(angle * 180 / Math.PI).toFixed(1), source });
  }

  playGesture(name, source = "control") {
    if (!GESTURES.includes(name)) throw new Error(`Unknown gesture "${name}"`);
    const dur = name === "nod" ? 1.4 : name === "wave" ? 2.6 : 3.0 / this.anim.tempo;
    const kind = name === "signature" ? this.anim.gesture : name;
    this.gesture = { name, kind, t: 0, dur };
    this.emit("command", { command: "gesture", gesture: name, kind, source });
    this.emit("gesture-start", { gesture: kind });
  }

  lookAround(source = "control") {
    this.lookMode = "around"; this.lookAroundT = 0;
    this.emit("command", { command: "lookAround", source });
  }
  /** World-space point to look at (e.g. the camera), or null to return to idle. */
  lookAt(point, source = "control") {
    if (point) { this.lookMode = "point"; this.lookPoint = point; }
    else if (this.lookMode === "point") this.lookMode = "idle";
    this.emit("command", { command: point ? "lookAt" : "lookRelease", source });
  }

  setExpression(name) {
    if (!EXPRESSIONS[name]) throw new Error(`Unknown expression "${name}"`);
    this.expressionName = name;
    this.emit("expression", { expression: name });
  }

  /** Mouth openness 0..1 from the voice system. */
  setMouth(v) { this.mouth = clamp(v, 0, 1); }

  blink() { this.blinkT = 0.0001; }

  /** Walk a sequence of waypoints; reports each measured arrival. */
  runCourse(points, source = "control") {
    this.course = { points: points.map(([x, z]) => new THREE.Vector3(x, 0, z)), i: 0, reached: 0, maxErr: 0, start: this.time };
    this.emit("course-start", { waypoints: points.length, source });
    this.target = this.course.points[0].clone();
    this.drive = null;
  }

  posArr() { return [+this.position.x.toFixed(3), +this.position.z.toFixed(3)]; }

  // ---------- simulation ----------
  update(dt) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const a = this.anim;
    const pos = this.position;
    const maxSpeed = a.walkSpeed;

    // Desired velocity from drive or target.
    let desired = null;
    if (this.drive) {
      desired = new THREE.Vector3(this.drive.x, 0, this.drive.z);
      if (desired.length() > 1) desired.normalize();
      desired.multiplyScalar(maxSpeed);
    } else if (this.target) {
      const to = this.target.clone().sub(pos); to.y = 0;
      const d = to.length();
      if (d < ARRIVE_EPS && this.velocity.length() < 0.25) {
        this.target = null;
        const err = +d.toFixed(3);
        if (this.course) {
          const c = this.course;
          c.reached++; c.maxErr = Math.max(c.maxErr, err);
          this.emit("waypoint-reached", { index: c.i + 1, of: c.points.length, position: this.posArr(), error: err });
          c.i++;
          if (c.i < c.points.length) this.target = c.points[c.i].clone();
          else {
            this.emit("course-complete", { reached: c.reached, of: c.points.length, maxError: +c.maxErr.toFixed(3), seconds: +(this.time - c.start).toFixed(2) });
            this.course = null;
          }
        } else {
          this.emit("arrived", { position: this.posArr(), error: err });
        }
      } else {
        // Slow down on approach.
        const sp = Math.min(maxSpeed, d * 2.2);
        desired = to.normalize().multiplyScalar(sp);
      }
    }

    // Turn toward travel direction; only advance when roughly facing it.
    if (desired && desired.length() > 0.01) {
      const want = Math.atan2(desired.x, desired.z);
      const diff = wrapAngle(want - this.heading);
      this.heading = wrapAngle(this.heading + clamp(diff, -1, 1) * Math.min(1, dt * 6.5));
      const facing = Math.max(0, Math.cos(diff));
      desired.multiplyScalar(facing * facing);
    } else if (this.targetHeading !== null) {
      const diff = wrapAngle(this.targetHeading - this.heading);
      if (Math.abs(diff) < TURN_EPS) {
        this.heading = this.targetHeading;
        this.targetHeading = null;
        this.emit("turned", { headingDegrees: +(this.heading * 180 / Math.PI).toFixed(1) });
      } else {
        this.heading = wrapAngle(this.heading + Math.sign(diff) * Math.min(Math.abs(diff), dt * 2.6));
      }
    }

    // Accelerate velocity toward desired.
    const goal = desired ?? new THREE.Vector3();
    const rate = desired ? 7 : 13;                       // brake harder than we accelerate
    this.velocity.x = damp(this.velocity.x, goal.x, rate, dt);
    this.velocity.z = damp(this.velocity.z, goal.z, rate, dt);
    if (!desired && this.velocity.length() < 0.03) this.velocity.set(0, 0, 0);

    // Collision with other characters and the stage edge.
    const next = pos.clone().addScaledVector(this.velocity, dt);
    let blockedBy = null;
    for (const o of this.getObstacles()) {
      if (o.id === this.id) continue;
      const d = Math.hypot(next.x - o.position.x, next.z - o.position.z);
      const now = Math.hypot(pos.x - o.position.x, pos.z - o.position.z);
      if (d < 0.55 && d < now) { blockedBy = o.id; break; }
    }
    if (blockedBy) {
      this.velocity.set(0, 0, 0);
      if (this.target || this.drive || this.course) {
        this.emit("blocked", { by: blockedBy, position: this.posArr() });
        this.target = null; this.course = null;
      }
    } else {
      if (next.length() > this.boundsRadius) next.setLength(this.boundsRadius);
      pos.copy(next);
    }

    const speed = this.velocity.length();
    const wasMoving = this.moving;
    this.moving = speed > 0.05;
    if (this.moving && !wasMoving) this.emit("walk-start", { position: this.posArr() });
    if (!this.moving && wasMoving) {
      this.emit("walk-stop", { position: this.posArr() });
      if (this._pendingStopReport) { this.emit("stopped", { position: this.posArr() }); this._pendingStopReport = false; }
    }

    this.rig.root.rotation.y = this.heading;

    // Gait.
    const turningInPlace = this.targetHeading !== null && !this.moving;
    const wantWalk = clamp(speed / maxSpeed, 0, 1) + (turningInPlace ? 0.35 : 0);
    this.walkWeight = damp(this.walkWeight, clamp(wantWalk, 0, 1), 8, dt);
    const strideLen = a.stride;
    this.phase += (Math.max(speed, turningInPlace ? 0.45 : 0) / strideLen) * Math.PI * dt;

    this.updateGesture(dt);
    this.updateLook(dt);
    this.updateFace(dt);
    this.applyPose();
  }

  updateGesture(dt) {
    const g = this.gesture;
    if (!g) return;
    g.t += dt;
    if (g.t >= g.dur) { this.emit("gesture-end", { gesture: g.kind }); this.gesture = null; }
  }

  updateLook(dt) {
    const a = this.anim;
    let yaw = 0, pitch = 0;
    if (this.lookMode === "around") {
      this.lookAroundT += dt * a.tempo;
      const T = 5.2;
      const u = this.lookAroundT / T;
      if (u >= 1) { this.lookMode = "idle"; this.emit("look-around-end", {}); }
      else {
        // left → right → slightly up-left → centre
        const keys = [[0, 0, 0], [0.18, -0.75, 0.05], [0.45, 0.7, -0.05], [0.72, -0.3, 0.12], [1, 0, 0]];
        let i = 0; while (i < keys.length - 2 && u > keys[i + 1][0]) i++;
        const [u0, y0, p0] = keys[i], [u1, y1, p1] = keys[i + 1];
        const f = smooth(clamp((u - u0) / (u1 - u0), 0, 1));
        yaw = lerp(y0, y1, f); pitch = lerp(p0, p1, f);
      }
    } else if (this.lookMode === "point" && this.lookPoint) {
      const local = this.rig.root.worldToLocal(this.lookPoint.clone());
      const eyeY = this.rig.dims.eyeHeight;
      yaw = Math.atan2(local.x, local.z);
      pitch = -Math.atan2(local.y - eyeY, Math.hypot(local.x, local.z));
      yaw = clamp(yaw, -1.1, 1.1); pitch = clamp(pitch, -0.5, 0.5);
    } else {
      // Idle glances, frequency per character.
      this.glance.next -= dt;
      if (this.glance.next <= 0) {
        const f = a.lookFrequency;
        this.glance.yaw = (this.rng() - 0.5) * 0.9 * f * 2;
        this.glance.pitch = (this.rng() - 0.5) * 0.2;
        this.glance.next = (1.5 + this.rng() * 3.5) / (0.5 + f);
      }
      yaw = this.glance.yaw * (1 - this.walkWeight * 0.7);
      pitch = this.glance.pitch;
    }
    this.headYaw = damp(this.headYaw, yaw, 5 * a.tempo, dt);
    this.headPitch = damp(this.headPitch, pitch, 5 * a.tempo, dt);
  }

  updateFace(dt) {
    // Blinks: random interval, ~0.16 s.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT === 0) { this.blinkT = 0.0001; }
    if (this.blinkT > 0) {
      this.blinkT += dt;
      if (this.blinkT > 0.16) { this.blinkT = 0; this.blinkCount++; this.nextBlink = 2 + this.rng() * 4; }
    }
    const e = EXPRESSIONS[this.expressionName];
    for (const k of Object.keys(this.expr)) this.expr[k] = damp(this.expr[k], e[k], 6, dt);
    this.mouthSmoothed = damp(this.mouthSmoothed, this.mouth, 18, dt);
  }

  // ---------- pose ----------
  applyPose() {
    const J = this.rig.joints, a = this.anim, t = this.time, w = this.walkWeight;
    const ph = this.phase;
    const breathe = Math.sin(t * 1.6 * a.tempo);
    const sway = Math.sin(t * 0.7 * a.tempo) * a.idleSway * (1 - w);

    // Hips & spine.
    J.hips.position.y = this.rig.dims.legLen + Math.abs(Math.sin(ph)) * 0.022 * w - 0.012 * w;
    J.hips.position.x = sway * 0.02;
    J.hips.rotation.set(0, Math.sin(ph) * 0.12 * w, sway * 0.03 + Math.sin(ph) * 0.035 * w);
    J.spine.rotation.set(0.04 * w + breathe * 0.01, -Math.sin(ph) * 0.1 * w, -sway * 0.025);
    J.chest.rotation.set(breathe * 0.015, -Math.sin(ph) * 0.06 * w, 0);

    // Legs.
    for (const [side, s] of [["L", 1], ["R", -1]]) {
      const p = ph + (s > 0 ? 0 : Math.PI);
      const swing = Math.sin(p) * 0.48 * w;
      const lift = Math.max(0, Math.cos(p)) * 0.95 * w;   // knee bends during forward swing
      J["hip" + side].rotation.set(-swing - lift * 0.25, 0, s * 0.02 - sway * 0.02);
      J["knee" + side].rotation.set(lift + 0.03, 0, 0);
      J["ankle" + side].rotation.set(-0.15 * lift + swing * 0.35, 0, 0);
    }

    // Arms (base pose + walk swing), then gesture override.
    const armOut = 0.09;
    for (const [side, s] of [["L", 1], ["R", -1]]) {
      const p = ph + (s > 0 ? Math.PI : 0);
      J["shoulder" + side].rotation.set(-Math.sin(p) * 0.38 * w + breathe * 0.01, 0, s * (armOut + Math.max(0, breathe) * 0.008));
      J["elbow" + side].rotation.set(-0.12 - Math.max(0, -Math.sin(p)) * 0.35 * w, 0, 0);
      J["wrist" + side].rotation.set(0, 0, 0);
    }
    this.curlFingers(0.25, 0.25);

    // Head: neck takes 40%, head 60%.
    const tilt = a.headTilt * Math.sin(t * 0.4) * (1 - w);
    J.neck.rotation.set(this.headPitch * 0.4, this.headYaw * 0.4, tilt * 0.4);
    J.head.rotation.set(this.headPitch * 0.6 + breathe * 0.01, this.headYaw * 0.6, tilt);

    if (this.gesture) this.applyGesture();
    this.applyFace();
  }

  curlFingers(L, R) {
    for (const [side, v] of [["L", L], ["R", R]]) {
      this.rig.fingers[side].forEach((f, i) => { if (i < 4) f.rotation.x = -v * (1.1 + i * 0.05); });
    }
  }

  applyGesture() {
    const J = this.rig.joints, g = this.gesture;
    const u = g.t / g.dur;
    const env = smooth(clamp(u / 0.2, 0, 1)) * smooth(clamp((1 - u) / 0.22, 0, 1));
    const mix = (j, x, y, z) => {
      j.rotation.x = lerp(j.rotation.x, x, env);
      j.rotation.y = lerp(j.rotation.y, y, env);
      j.rotation.z = lerp(j.rotation.z, z, env);
    };
    const beat = Math.sin(g.t * 5);
    switch (g.kind) {
      case "explain": // Genesis: open palm forward, rhythmic beats, slight nod
        mix(J.shoulderR, -0.95 + beat * 0.06, 0.25, -0.18);
        mix(J.elbowR, -1.1 + beat * 0.08, 0, 0);
        mix(J.wristR, 0, -1.2, 0.2);
        mix(J.shoulderL, -0.35, 0, 0.18);
        mix(J.elbowL, -0.6, 0, 0);
        J.head.rotation.x += Math.sin(g.t * 3) * 0.05 * env;
        this.curlFingers(0.25, lerp(0.25, 0.02, env));
        break;
      case "assess": // Savannah: arms fold, chin level, steady gaze
        mix(J.shoulderL, -0.62, -0.55, 0.2);
        mix(J.elbowL, -1.95, 0, 0);
        mix(J.shoulderR, -0.5, 0.55, -0.2);
        mix(J.elbowR, -2.05, 0, 0);
        mix(J.wristL, 0, 0, -0.3); mix(J.wristR, 0, 0, 0.3);
        J.head.rotation.x += -0.06 * env;
        break;
      case "heart": // Aria: right hand to heart, warm head tilt
        mix(J.shoulderR, -0.55, 0.65, 0.12);
        mix(J.elbowR, -2.05, 0, 0);
        mix(J.wristR, 0.3, 0.2, 0.5);
        J.head.rotation.z += 0.16 * env;
        J.neck.rotation.z += 0.06 * env;
        this.curlFingers(0.25, lerp(0.25, 0.05, env));
        break;
      case "wave":
        mix(J.shoulderR, -0.2, 0, -2.5);
        mix(J.elbowR, -0.3, 0, 0);
        J.elbowR.rotation.z += Math.sin(g.t * 9) * 0.35 * env;
        this.curlFingers(0.25, lerp(0.25, 0.0, env));
        break;
      case "nod":
        J.head.rotation.x += Math.sin(g.t * 7) * 0.18 * env;
        break;
    }
  }

  applyFace() {
    const F = this.rig.face, e = this.expr, r = this.rig.dims.headR;
    // Eyes follow head target a little further than the head turned.
    const eyeYaw = clamp(this.headYaw * 0.35, -0.4, 0.4), eyePitch = clamp(this.headPitch * 0.3, -0.25, 0.25);
    F.eyes.forEach((eye) => eye.rotation.set(eyePitch, eyeYaw, 0));
    // Lids: open angle -0.8 rad (relaxed), closed +0.55 rad.
    const blink = this.blinkT > 0 ? Math.sin(Math.PI * clamp(this.blinkT / 0.16, 0, 1)) : 0;
    const closed = clamp(blink + e.lid, 0, 1);
    F.lids.forEach((lid) => { lid.rotation.x = lerp(-0.8, 0.55, closed) + eyePitch * 0.5; });
    // Brows.
    F.brows.forEach((b) => {
      b.position.y = b.userData.baseY + e.brow * r * 0.08;
      b.rotation.z = b.userData.baseRz + b.userData.side * e.furrow * 0.22;
    });
    // Mouth: jaw opens with speech; corners lift with smile.
    const open = this.mouthSmoothed;
    F.jaw.rotation.x = open * 0.32;
    F.lowerLip.scale.set(1, 1 + open * 0.3, 1);
    F.corners.forEach((c) => { c.position.y = c.userData.baseY + e.smile * r * 0.05 - open * r * 0.02; });
    F.upperLip.scale.set(1, 1 - Math.max(0, e.smile) * 0.08, 1);
  }
}
