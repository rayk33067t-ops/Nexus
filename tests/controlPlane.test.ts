import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

// The NEXUS Control Plane, end to end over real HTTP on this machine:
// agent → Key Authority → Control Plane → (fake) open-weight backends.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cp-"));
const RULES = path.join(ROOT, "rules.json");
const STATE = path.join(ROOT, "state");
process.env.NEXUS_RULES_PATH = RULES;
process.env.NEXUS_STATE_DIR = STATE;

const MG = require("../src/genesis/providers/modelGateway");
const KA = require("../src/genesis/authority/KeyAuthority");
const { parseControlPlaneConfig, loadControlPlaneConfig } = require("../src/controlPlane/config");
const CP = require("../src/controlPlane/server");
const { issue } = require("./support");

const KEY = "nexus-test-key-0123456789abcdef";
const SECRET_PROMPT = "The secret build plan for world seven.";

const running: { close(): Promise<void> }[] = [];
after(async () => {
  for (const r of running) await r.close();
});

// ---------- fake backends ----------

type Seen = { auth: string | undefined; body: any };
interface Backend { port: number; seen: Seen[]; close(): Promise<void> }

function backend(reply: (n: number) => { status: number; body?: unknown; hang?: boolean }): Promise<Backend> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      const r = reply(seen.length);
      if (r.hang) return; // never answers
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      let closed = false;
      const close = () => new Promise<void>((r) => {
        if (closed) return r();
        closed = true;
        server.closeAllConnections();
        server.close(() => r());
      });
      // Closed at the end even when a test fails half-way, so a failure never hangs the run.
      running.push({ close });
      resolve({ port, seen, close });
    })
  );
}

const okReply = (text = "hello from an open-weight model") => ({
  status: 200,
  body: { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
});

// ---------- a running Control Plane ----------

async function controlPlane(chain: { port: number; key?: boolean }[], over: object = {}, env: Record<string, string> = { NEXUS_KEY_TEST: KEY }) {
  const providers: Record<string, unknown> = {};
  chain.forEach((b, i) => {
    providers[`p${i}`] = { baseUrl: `http://127.0.0.1:${b.port}/v1`, keyEnv: b.key === false ? null : "NEXUS_KEY_TEST" };
  });
  const config = parseControlPlaneConfig({
    host: "127.0.0.1",
    port: 0,
    agents: ["genesis", "savannah"],
    providers,
    models: {
      "nexus-primary": chain.map((_, i) => ({ provider: `p${i}`, model: `upstream-model-${i}` })),
      "nexus-fast": [{ provider: "p0", model: "upstream-small" }],
    },
    perAgentDailyTokenCap: 100_000,
    maxOutputTokens: 2048,
    upstreamTimeoutMs: 2000,
    ...over,
  });
  const { server, port } = await CP.startControlPlane({ config, env });
  const handle = { close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
  running.push(handle);
  const client = MG.parseConfig({
    url: `http://127.0.0.1:${port}${CP.MODEL_PATH}`,
    defaultModel: "nexus-primary",
    allowedModels: ["nexus-primary", "nexus-fast"],
    dailyTokenCap: 100_000,
    maxOutputTokens: 2048,
    timeoutMs: 5000,
  });
  return { port, client, config };
}

async function post(port: number, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${CP.MODEL_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function everythingWritten(): string {
  const out: string[] = [];
  (function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else out.push(fs.readFileSync(f, "utf-8"));
    }
  })(STATE);
  return out.join("\n");
}

let genesis: any;
beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.writeFileSync(RULES, JSON.stringify({ version: 1, rules: [{ id: "models", actor: "*", action: "key.use", target: "model:*", effect: "allow" }] }));
  genesis = issue("genesis");
});

/** A body exactly as the client sends it, signed by `signer`. */
function signedBody(signer: any, plan: any, over: object = {}) {
  const request = signer.sign({ action: "model.call", target: MG.modelTarget(plan.model), digest: MG.planDigest(plan), ...over });
  return { request, plan };
}
const PLAN = { model: "nexus-primary", maxTokens: 100, system: "", prompt: "hi" };

// ---------- the whole path ----------

test("Genesis asks a NEXUS model; the Control Plane answers from an open-weight backend, holding the key itself", async () => {
  const b = await backend(() => okReply());
  const { client } = await controlPlane([{ port: b.port }]);
  const answer = await MG.askModel(genesis, { prompt: SECRET_PROMPT, system: "Be brief." }, { config: client });
  assert.equal(answer.text, "hello from an open-weight model");
  assert.equal(answer.inputTokens, 20);
  assert.equal(answer.outputTokens, 10);

  assert.equal(b.seen.length, 1);
  assert.equal(b.seen[0].auth, `Bearer ${KEY}`, "the backend got the key from the Control Plane");
  assert.equal(b.seen[0].body.model, "upstream-model-0");
  assert.deepEqual(b.seen[0].body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: SECRET_PROMPT }]);

  // Nothing NEXUS wrote down holds the key, the prompt or the answer.
  const written = everythingWritten();
  assert.ok(!written.includes(KEY), "no key in any log or ledger");
  assert.ok(!written.includes(SECRET_PROMPT), "no prompt in any log or ledger");
  assert.ok(!written.includes("hello from an open-weight model"), "no answer in any log or ledger");
  const log = CP.controlPlaneLog();
  assert.ok(log.ok);
  assert.ok(log.entries.some((e: any) => e.event.type === "answered" && e.event.agent === "genesis" && e.event.provider === "p0"));
  await b.close();
});

// ---------- who may ask ----------

test("a plan changed after signing is refused, and the backend never sees it", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  const body = signedBody(genesis, PLAN);
  const r = await post(port, { ...body, plan: { ...PLAN, prompt: "something else entirely" } });
  assert.equal(r.status, 401);
  const r2 = await post(port, { ...body, plan: { ...PLAN, model: "nexus-fast" } });
  assert.equal(r2.status, 401);
  assert.equal(b.seen.length, 0);
  await b.close();
});

test("a replayed request is refused", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  const body = signedBody(genesis, PLAN);
  assert.equal((await post(port, body)).status, 200);
  assert.equal((await post(port, body)).status, 401);
  assert.equal(b.seen.length, 1);
  await b.close();
});

test("unsigned requests, other actions and unknown keys are refused", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  assert.equal((await post(port, { plan: PLAN })).status, 401);
  assert.equal((await post(port, signedBody(genesis, PLAN, { action: "key.use" }))).status, 401);
  const crypto = require("crypto");
  const creds = require("../src/genesis/authority/credentials");
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const rogue = creds.signerFromPem(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  assert.equal((await post(port, signedBody(rogue, PLAN))).status, 401);
  assert.equal(b.seen.length, 0);
  await b.close();
});

test("an agent not on the Control Plane's list is refused", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  const builder = issue("builder");
  const r = await post(port, signedBody(builder, PLAN));
  assert.equal(r.status, 403);
  assert.equal(b.seen.length, 0);
  await b.close();
});

test("in lockdown nothing is answered, and a quarantined agent is refused", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  KA.reportHostile({}, "test: lockdown"); // unattributed: lockdown only
  assert.equal(KA.isLockedDown(), true);
  assert.equal((await post(port, signedBody(genesis, PLAN))).status, 423);

  fs.rmSync(STATE, { recursive: true, force: true });
  const g2 = issue("genesis");
  KA.reportHostile(g2.sign({ action: "fs.write", target: "project:x", digest: "sha256:" + "b".repeat(64) }), "test: hostile");
  assert.equal((await post(port, signedBody(g2, PLAN))).status, 403);
  assert.equal(b.seen.length, 0);
  await b.close();
});

// ---------- which backend answers ----------

test("a busy backend falls back to the next one", async () => {
  const busy = await backend(() => ({ status: 503, body: { error: "overloaded" } }));
  const good = await backend(() => okReply("from the fallback"));
  const { port } = await controlPlane([{ port: busy.port }, { port: good.port }]);
  const r = await post(port, signedBody(genesis, PLAN));
  assert.equal(r.status, 200);
  assert.equal(r.body.text, "from the fallback");
  assert.equal(r.body.servedBy, "p1");
  assert.equal(busy.seen.length, 1);
  assert.equal(good.seen.length, 1);
  await busy.close();
  await good.close();
});

test("an unreachable backend falls back to the next one", async () => {
  const gone = await backend(() => okReply());
  const deadPort = gone.port;
  await gone.close();
  const good = await backend(() => okReply("still answered"));
  const { port } = await controlPlane([{ port: deadPort }, { port: good.port }]);
  const r = await post(port, signedBody(genesis, PLAN));
  assert.equal(r.status, 200);
  assert.equal(r.body.text, "still answered");
  await good.close();
});

test("a timeout never falls back: the first backend may already have run (and cost money)", async () => {
  const slow = await backend(() => ({ status: 200, hang: true }));
  const good = await backend(() => okReply());
  const { port } = await controlPlane([{ port: slow.port }, { port: good.port }], { upstreamTimeoutMs: 100 });
  const r = await post(port, signedBody(genesis, PLAN));
  assert.equal(r.status, 504);
  assert.equal(good.seen.length, 0);
  await slow.close();
  await good.close();
});

test("a backend whose key is not set is skipped; with none set up, the call fails closed", async () => {
  const keyed = await backend(() => okReply("keyed"));
  const local = await backend(() => okReply("local, no key needed"));
  const { port } = await controlPlane([{ port: keyed.port }, { port: local.port, key: false }], {}, {});
  const r = await post(port, signedBody(genesis, PLAN));
  assert.equal(r.status, 200);
  assert.equal(r.body.text, "local, no key needed");
  assert.equal(keyed.seen.length, 0);
  assert.equal(local.seen[0].auth, undefined, "a keyless local backend gets no authorization header");

  const { port: p2 } = await controlPlane([{ port: keyed.port }], {}, {});
  const r2 = await post(p2, signedBody(genesis, PLAN));
  assert.equal(r2.status, 503);
  assert.equal(keyed.seen.length, 0);
  await keyed.close();
  await local.close();
});

test("a backend error is reported without trying the next one", async () => {
  const broken = await backend(() => ({ status: 400, body: { error: "bad request" } }));
  const good = await backend(() => okReply());
  const { port } = await controlPlane([{ port: broken.port }, { port: good.port }]);
  const r = await post(port, signedBody(genesis, PLAN));
  assert.equal(r.status, 502);
  assert.equal(good.seen.length, 0);
  await broken.close();
  await good.close();
});

// ---------- spending ----------

test("each agent's daily token budget stops calls before anything is sent", async () => {
  const b = await backend(() => ({ status: 200, body: { choices: [{ message: { content: "x" } }] } })); // no usage: the reservation stands
  const { port } = await controlPlane([{ port: b.port }], { perAgentDailyTokenCap: 300 });
  assert.equal((await post(port, signedBody(genesis, { ...PLAN, maxTokens: 200 }))).status, 200);
  assert.equal((await post(port, signedBody(genesis, { ...PLAN, maxTokens: 200 }))).status, 429);
  assert.equal(b.seen.length, 1);
  // Another agent has its own budget.
  const savannah = issue("savannah");
  assert.equal((await post(port, signedBody(savannah, { ...PLAN, maxTokens: 200 }))).status, 200);
  await b.close();
});

test("an unreadable usage ledger stops spending (fails closed)", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(CP.CP_USAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CP.CP_USAGE_DIR, `${day}.json`), "{ not json");
  assert.equal((await post(port, signedBody(genesis, PLAN))).status, 503);
  assert.equal(b.seen.length, 0);
  await b.close();
});

// ---------- what can be seen ----------

test("the health page shows which models are ready, never a key", async () => {
  const b = await backend(() => okReply());
  const { port } = await controlPlane([{ port: b.port }]);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(KEY));
  const h = JSON.parse(text);
  assert.equal(h.models["nexus-primary"][0].ready, true);
  assert.equal(h.lockdown, false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/anything-else`)).status, 404);
  await b.close();
});

test("the config keeps the Control Plane on this device and keys out of files", () => {
  const base = {
    agents: ["genesis"],
    providers: { local: { baseUrl: "http://127.0.0.1:8080/v1", keyEnv: null } },
    models: { "nexus-primary": [{ provider: "local", model: "local" }] },
    perAgentDailyTokenCap: 1000, maxOutputTokens: 100, upstreamTimeoutMs: 1000,
  };
  assert.doesNotThrow(() => parseControlPlaneConfig(base));
  assert.throws(() => parseControlPlaneConfig({ ...base, host: "0.0.0.0" }), /this device/);
  assert.throws(() => parseControlPlaneConfig({ ...base, providers: { r: { baseUrl: "http://example.com/v1", keyEnv: "NEXUS_KEY_R" } } }), /https/);
  assert.throws(() => parseControlPlaneConfig({ ...base, providers: { r: { baseUrl: "https://example.com/v1", keyEnv: "sk-abc123" } } }), /keyEnv/);
  assert.throws(() => parseControlPlaneConfig({ ...base, providers: { r: { baseUrl: "https://example.com/v1", keyEnv: null } } }), /needs a keyEnv/);
  assert.throws(() => parseControlPlaneConfig({ ...base, agents: ["founder"] }), /agents/);
  assert.throws(() => parseControlPlaneConfig({ ...base, models: { "nexus-primary": [{ provider: "nope", model: "x" }] } }), /unknown provider/);
});

test("the shipped Control Plane config is valid, open-weight and keyless", () => {
  const file = path.join(__dirname, "..", "config", "control-plane.json");
  const cfg = loadControlPlaneConfig(file);
  assert.equal(cfg.host, "127.0.0.1");
  for (const name of ["nexus-primary", "nexus-coder", "nexus-fast"]) assert.ok(cfg.models[name], name);
  const raw = fs.readFileSync(file, "utf-8");
  assert.ok(!/anthropic|openai\.com|claude|gpt-/i.test(raw), "no closed-model provider in the default config");
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw), "no key in the file");
  // Every name the agents may ask for has a route.
  const client = MG.loadConfig(path.join(__dirname, "..", "config", "model-gateway.json"));
  for (const m of client.allowedModels) assert.ok(cfg.models[m], `${m} has a route in the Control Plane`);
});
