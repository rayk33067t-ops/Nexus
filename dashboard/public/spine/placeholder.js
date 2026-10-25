// Built-in cinematic for worlds that don't have a Spline scene yet:
// a warp through streaking stars into a glowing core, in the world's colours.

export function playPlaceholder(canvas, world, durationMs, signal) {
  const ctx = canvas.getContext("2d");
  const [glow, accent, bg] = world.intro.palette;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0, h = 0;
  const resize = () => {
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  // Seeded by world id so each world's flight is always the same.
  let seed = [...world.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const stars = Array.from({ length: 420 }, () => ({ x: rand() * 2 - 1, y: rand() * 2 - 1, z: rand(), c: rand() < 0.5 ? glow : accent }));

  const start = performance.now();
  return new Promise((resolve) => {
    const frame = (now) => {
      if (signal.aborted) { window.removeEventListener("resize", resize); return resolve(); }
      const t = Math.min(1, (now - start) / durationMs);
      const cx = w / 2, cy = h / 2, scale = Math.max(w, h) * 0.6;

      // speed ramps up, then eases as the core forms
      const speed = 0.002 + 0.03 * Math.sin(Math.min(1, t * 1.6) * Math.PI) ** 2;

      ctx.fillStyle = bg; ctx.globalAlpha = 0.35; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1;
      for (const s of stars) {
        const pz = s.z;
        s.z -= speed;
        if (s.z <= 0.02) { s.x = rand() * 2 - 1; s.y = rand() * 2 - 1; s.z = 1; continue; }
        const x1 = cx + (s.x / pz) * scale * 0.5, y1 = cy + (s.y / pz) * scale * 0.5;
        const x2 = cx + (s.x / s.z) * scale * 0.5, y2 = cy + (s.y / s.z) * scale * 0.5;
        ctx.strokeStyle = s.c; ctx.globalAlpha = Math.min(1, (1 - s.z) * 1.4);
        ctx.lineWidth = Math.max(0.6, (1 - s.z) * 2.4);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // the core: grows from the second third onwards, with two orbiting rings
      const core = Math.max(0, (t - 0.3) / 0.7);
      if (core > 0) {
        const r = Math.min(w, h) * (0.04 + 0.16 * easeOut(core));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3);
        g.addColorStop(0, "#ffffff"); g.addColorStop(0.15, glow); g.addColorStop(0.5, hexA(accent, 0.25)); g.addColorStop(1, hexA(bg, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 3, 0, Math.PI * 2); ctx.fill();
        for (let k = 0; k < 2; k++) {
          ctx.save(); ctx.translate(cx, cy); ctx.rotate((now / 1000) * (k ? -0.6 : 0.9) + k);
          ctx.strokeStyle = k ? accent : glow; ctx.globalAlpha = 0.7 * easeOut(core); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.ellipse(0, 0, r * (1.8 + k * 0.6), r * (0.5 + k * 0.2), 0, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      // closing flash
      if (t > 0.9) { ctx.fillStyle = hexA("#ffffff", ((t - 0.9) / 0.1) * 0.5); ctx.fillRect(0, 0, w, h); }

      if (t < 1) requestAnimationFrame(frame);
      else { window.removeEventListener("resize", resize); resolve(); }
    };
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    requestAnimationFrame(frame);
  });
}

function easeOut(x) { return 1 - (1 - x) ** 3; }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
