/**
 * NEXUS dashboard: serves the World Spine (the gateway and every world)
 * and read-only data for it.
 *
 * Security:
 *  - Listens on 127.0.0.1 only, so other devices on your network cannot
 *    reach it.
 *  - Runs no commands. The old /generate endpoint passed request text into
 *    a shell command, which let anyone who could reach it run anything on
 *    the phone, bypassing the guard, Key Authority and the Warden. It is
 *    gone; builds go through Genesis and Key Authority instead.
 *  - Read-only: no endpoint writes files.
 *  - A strict Content-Security-Policy limits pages to this server's own
 *    scripts plus the pinned Spline runtime.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
      "connect-src 'self' https://prod.spline.design https://*.spline.design https://cdn.jsdelivr.net",
      "img-src 'self' data: blob: https://*.spline.design",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data: https://*.spline.design",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  next();
});

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8"));
}

app.get("/api/worlds", (req, res) => {
  try {
    res.json(readJSON("config/worlds.json"));
  } catch (err) {
    res.status(500).json({ error: "The world registry could not be read." });
  }
});

app.get("/api/chronicle", (req, res) => {
  try {
    res.json(readJSON("src/genesis/config/chronicle.json"));
  } catch (err) {
    res.status(500).json({ error: "The Chronicle could not be read." });
  }
});

// Generated projects: names and top-level files only.
app.get("/api/projects", (req, res) => {
  const dir = path.join(ROOT, "output", "projects");
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none yet */ }
  res.json(names.map((name) => ({ name, files: fs.readdirSync(path.join(dir, name)) })));
});

app.post("/generate", (req, res) => {
  res.status(410).json({ error: "Removed: it ran commands from request text. Ask Genesis to build instead; Key Authority approves builds." });
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html", dotfiles: "deny" }));

app.listen(PORT, HOST, () => {
  console.log(`NEXUS worlds: open http://localhost:${PORT} in your browser (this phone only)`);
});
