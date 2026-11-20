import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";

// Behavioral dashboard safety: start the real server and use it like a
// browser would, then check that nothing ran and nothing changed.
//
// It needs the dashboard's own packages (cd dashboard && npm ci). When they
// aren't installed the test is SKIPPED with a BLOCKED reason, never passed.

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "dashboard", "server.js");
const EXPRESS = path.join(ROOT, "dashboard", "node_modules", "express", "package.json");
const TRIPWIRE = path.join(__dirname, "fixtures", "no-child-process.js");
const START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, rawPath: string, body?: string, host = "127.0.0.1"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method, path: rawPath, timeout: REQUEST_TIMEOUT_MS, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`${method} ${rawPath} timed out`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Fingerprint every file in the repository that the dashboard could change. */
function fingerprint(): Map<string, string> {
  const out = new Map<string, string>();
  const skip = new Set(["node_modules", ".git"]);
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(path.relative(ROOT, p), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(ROOT);
  return out;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const diff: string[] = [];
  for (const [f, h] of after) if (before.get(f) !== h) diff.push((before.has(f) ? "changed " : "added ") + f);
  for (const f of before.keys()) if (!after.has(f)) diff.push("removed " + f);
  return diff;
}

async function waitUntilUp(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the dashboard exited with code ${child.exitCode}: ${stderr()}`);
    try { await request(port, "GET", "/"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`the dashboard did not start within ${START_TIMEOUT_MS} ms: ${stderr()}`);
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(force); resolve(); });
    child.kill("SIGTERM");
  });
}

test("the dashboard serves pages and data, runs no commands, and changes nothing", { timeout: 60_000 }, async (t) => {
  if (!fs.existsSync(EXPRESS)) {
    t.skip("BLOCKED: the dashboard's packages are not installed (run: cd dashboard && npm ci). Not run, so not passed.");
    return;
  }

  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dash-"));
  const tripwireLog = path.join(tmp, "child-process-calls.jsonl");
  const canary = path.join(tmp, "PWNED");
  const before = fingerprint();

  let errText = "";
  const child = spawn(process.execPath, ["--require", TRIPWIRE, SERVER], {
    cwd: path.join(ROOT, "dashboard"),
    env: { ...process.env, PORT: String(port), NEXUS_TRIPWIRE_FILE: tripwireLog },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (d) => (errText += d));
  t.after(() => stop(child)); // runs even when an assertion below fails

  await waitUntilUp(port, child, () => errText);

  // ---- normal viewing ----
  const home = await request(port, "GET", "/");
  assert.equal(home.status, 200);
  assert.match(String(home.headers["content-type"]), /text\/html/);
  assert.match(String(home.headers["content-security-policy"]), /default-src 'self'/);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal((await request(port, "GET", "/world.html?w=chronicle")).status, 200);

  const worlds = await request(port, "GET", "/api/worlds");
  assert.equal(worlds.status, 200);
  assert.ok(JSON.parse(worlds.body).worlds.length >= 1);
  const chronicle = await request(port, "GET", "/api/chronicle");
  assert.equal(chronicle.status, 200);
  assert.ok(Array.isArray(JSON.parse(chronicle.body).timeline));
  const projects = await request(port, "GET", "/api/projects");
  assert.equal(projects.status, 200);
  assert.ok(Array.isArray(JSON.parse(projects.body)));

  // ---- the old command endpoint is gone, even with a shell-injection payload ----
  const injected = await request(port, "POST", "/generate", JSON.stringify({ input: `x"; touch ${canary}; echo "` }));
  assert.equal(injected.status, 410);
  assert.equal(fs.existsSync(canary), false);

  // ---- safe error handling ----
  for (const p of ["/../package.json", "/%2e%2e/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/.git/config", "/.nexus/warden/founder.secret"]) {
    const r = await request(port, "GET", p);
    assert.notEqual(r.status, 200, `${p} answered 200`);
    assert.doesNotMatch(r.body, /"devDependencies"|\[core\]|"hash"/, `${p} leaked a file`);
  }
  assert.equal((await request(port, "GET", "/api/does-not-exist")).status, 404);
  const malformed = await request(port, "GET", "/spine/%E0%A4%A");
  assert.ok([400, 404].includes(malformed.status), `malformed URL answered ${malformed.status}`);
  assert.doesNotMatch(malformed.body, /at .*\.js:\d+/, "an error page exposed a stack trace");

  // ---- still up, still only on this device ----
  assert.equal((await request(port, "GET", "/")).status, 200);
  assert.equal(child.exitCode, null, "the server crashed");
  const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (external) {
    await assert.rejects(request(port, "GET", "/", undefined, external.address), "the dashboard answered on a network address");
  } else {
    t.diagnostic("no non-loopback network interface here; the network-exposure check could not run");
  }

  // ---- nothing ran, nothing changed ----
  const calls = fs.existsSync(tripwireLog) ? fs.readFileSync(tripwireLog, "utf-8").trim() : "";
  assert.equal(calls, "", `the dashboard tried to start another program: ${calls}`);
  assert.deepEqual(changes(before, fingerprint()), [], "viewing the dashboard changed files");
});

test("the tripwire really catches a dashboard that runs a command", { timeout: 30_000 }, async () => {
  // Proves the check above can fail: a tiny server that does run a command trips it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trip-"));
  const log = path.join(tmp, "calls.jsonl");
  const bad = path.join(tmp, "bad-server.js");
  fs.writeFileSync(bad, `try { require("child_process").execSync("echo hi"); } catch {}\n`);
  await new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, ["--require", TRIPWIRE, bad], { env: { ...process.env, NEXUS_TRIPWIRE_FILE: log }, stdio: "ignore" });
    c.on("exit", () => resolve());
    c.on("error", reject);
  });
  assert.match(fs.readFileSync(log, "utf-8"), /"call":"execSync","command":"echo hi"/);
});
