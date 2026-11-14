import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Model Gateway client: model calls go through Key Authority and a budget.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-model-"));
const RULES = path.join(ROOT, "rules.json");
const STATE = path.join(ROOT, "state");
process.env.NEXUS_RULES_PATH = RULES;
process.env.NEXUS_STATE_DIR = STATE;

const MG = require("../src/genesis/providers/modelGateway");
const creds = require("../src/genesis/authority/credentials");
const kaFounder = require("../src/genesis/authority/founder");
const { issue, PASS } = require("./support");

const rule = (id: string, actor: string, action: string, target: string, effect: string) => ({ id, actor, action, target, effect });
const rules = (list: object[]) => fs.writeFileSync(RULES, JSON.stringify({ version: 1, rules: list }));

const CFG = MG.parseConfig({
  url: "https://gateway.example/v1/nexus/model",
  defaultModel: "nexus-primary",
  allowedModels: ["nexus-primary", "nexus-fast"],
  dailyTokenCap: 50_000,
  maxOutputTokens: 2048,
  timeoutMs: 2000,
});

type Call = { url: string; body: { request: Record<string, unknown>; plan: Record<string, unknown> } };

function fakeGateway(reply: { status?: number; body?: unknown; hang?: boolean; throws?: boolean } = {}) {
  const calls: Call[] = [];
  const transport = (url: string, init: { body: string; signal: AbortSignal }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply.throws) return Promise.reject(new Error("network down"));
    if (reply.hang) {
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const body = reply.body ?? { ok: true, text: "hello from the model", model: "nexus-primary", usage: { input_tokens: 12, output_tokens: 34 } };
    return Promise.resolve({ status: reply.status ?? 200, json: async () => body });
  };
  return { calls, transport };
}

function ledgerToday(): any {
  const day = new Date().toISOString().slice(0, 10);
  const f = path.join(STATE, "usage", `${day}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : null;
}

let genesis: any;
beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  rules([rule("models", "genesis", "key.use", "model:*", "allow")]);
  genesis = issue("genesis");
});

test("an allowed call reaches the Control Plane signed, bound to the exact plan, and is metered", async () => {
  const gw = fakeGateway();
  const answer = await MG.askModel(genesis, { prompt: "Say hello.", system: "Be brief." }, { config: CFG, transport: gw.transport });
  assert.equal(answer.text, "hello from the model");
  assert.equal(gw.calls.length, 1);

  const { request, plan } = gw.calls[0].body;
  assert.equal(request.action, "model.call");
  assert.equal(request.target, "model:nexus-primary");
  assert.equal(request.digest, MG.planDigest(plan));
  assert.equal(request.publicKey, genesis.publicKey);
  // The Control Plane can verify who signed it, from the signature alone.
  const { signature, ...unsigned } = request as any;
  const key = crypto.createPublicKey({ key: Buffer.from(String(request.publicKey), "base64"), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, Buffer.from(creds.signedPayload(unsigned), "utf-8"), key, Buffer.from(String(signature), "base64")));

  const l = ledgerToday();
  assert.equal(l.tokens, 46);
  assert.equal(l.calls[0].status, "done");
  const raw = JSON.stringify(l);
  assert.ok(!raw.includes("Say hello") && !raw.includes("hello from the model"), "the ledger never stores prompts or answers");
});

test("agents ask for NEXUS models, never for an AI company", () => {
  const plan = MG.makePlan(CFG, { prompt: "hi" });
  assert.equal(plan.model, "nexus-primary");
  assert.ok(!("provider" in plan));
  assert.equal(MG.modelTarget(plan.model), "model:nexus-primary");
});

test("with no rule for model calls, the call is refused and nothing is sent or spent", async () => {
  rules([]);
  const gw = fakeGateway();
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: gw.transport }), (e: any) => e.code === "DENIED");
  assert.equal(gw.calls.length, 0);
  assert.equal(ledgerToday(), null);
});

test("a rule can allow one NEXUS model and not another", async () => {
  rules([rule("fast-only", "genesis", "key.use", "model:nexus-fast", "allow")]);
  const gw = fakeGateway();
  await MG.askModel(genesis, { prompt: "hi", model: "nexus-fast" }, { config: CFG, transport: gw.transport });
  await assert.rejects(MG.askModel(genesis, { prompt: "hi", model: "nexus-primary" }, { config: CFG, transport: gw.transport }), (e: any) => e.code === "DENIED");
  assert.equal(gw.calls.length, 1);
});

test("an 'ask' rule waits for the Founder; once approved, that exact call goes through once", async () => {
  rules([rule("models-always-ask", "*", "key.use", "**", "ask")]);
  const gw = fakeGateway();
  let requestId = "";
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: gw.transport }), (e: any) => {
    requestId = e.requestId;
    return e.code === "APPROVAL_REQUIRED" && typeof e.requestId === "string";
  });
  assert.equal(gw.calls.length, 0);

  kaFounder.approve(requestId, PASS);
  const answer = await MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: gw.transport });
  assert.equal(answer.text, "hello from the model");
  // The approval was single-use: the same call asks again.
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: gw.transport }), (e: any) => e.code === "APPROVAL_REQUIRED");
  assert.equal(gw.calls.length, 1);
});

test("an approval covers only the exact plan it was given for", async () => {
  rules([rule("models-always-ask", "*", "key.use", "**", "ask")]);
  const gw = fakeGateway();
  let requestId = "";
  await assert.rejects(MG.askModel(genesis, { prompt: "small question" }, { config: CFG, transport: gw.transport }), (e: any) => {
    requestId = e.requestId;
    return true;
  });
  kaFounder.approve(requestId, PASS);
  await assert.rejects(
    MG.askModel(genesis, { prompt: "small question", maxTokens: 2048 }, { config: CFG, transport: gw.transport }),
    (e: any) => e.code === "APPROVAL_REQUIRED"
  );
  assert.equal(gw.calls.length, 0);
});

test("a key Key Authority never issued is refused", async () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const rogue = creds.signerFromPem(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const gw = fakeGateway();
  await assert.rejects(MG.askModel(rogue, { prompt: "hi" }, { config: CFG, transport: gw.transport }), (e: any) => e.code === "DENIED");
  assert.equal(gw.calls.length, 0);
});

test("the daily budget stops a call before anything is sent", async () => {
  const tight = MG.parseConfig({ ...CFG, allowedModels: [...CFG.allowedModels], dailyTokenCap: 1500 });
  const gw = fakeGateway();
  await MG.askModel(genesis, { prompt: "hi", maxTokens: 1000 }, { config: tight, transport: gw.transport });
  await assert.rejects(
    MG.askModel(genesis, { prompt: "hi again", maxTokens: 1500 }, { config: tight, transport: gw.transport }),
    (e: any) => e.code === "BUDGET_EXCEEDED"
  );
  assert.equal(gw.calls.length, 1);
});

test("an unreadable ledger stops spending (fails closed)", async () => {
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(STATE, "usage"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "usage", `${day}.json`), "{ not json");
  const gw = fakeGateway();
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: gw.transport }), (e: any) => e.code === "LEDGER_UNREADABLE");
  assert.equal(gw.calls.length, 0);
});

test("a gateway failure is reported, and the reservation stays counted", async () => {
  const gw = fakeGateway({ status: 502, body: { ok: false, error: "backend error" } });
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: gw.transport }), (e: any) => e.code === "GATEWAY_ERROR");
  const l = ledgerToday();
  assert.equal(l.calls[0].status, "failed");
  assert.ok(l.tokens > 0, "a failed call may still have cost money, so its reservation is not given back");
});

test("an unreachable gateway and a timeout are reported without retrying", async () => {
  const down = fakeGateway({ throws: true });
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: CFG, transport: down.transport }), (e: any) => e.code === "GATEWAY_UNREACHABLE");
  assert.equal(down.calls.length, 1);
  const quick = MG.parseConfig({ ...CFG, allowedModels: [...CFG.allowedModels], timeoutMs: 50 });
  const hung = fakeGateway({ hang: true });
  await assert.rejects(MG.askModel(genesis, { prompt: "hi" }, { config: quick, transport: hung.transport }), (e: any) => e.code === "TIMEOUT");
  assert.equal(hung.calls.length, 1);
});

test("bad configuration and bad requests are refused before anything happens", () => {
  const bad = (over: object) => () => MG.parseConfig({ ...CFG, allowedModels: [...CFG.allowedModels], ...over });
  assert.throws(bad({ url: "http://gateway.example/x" }), (e: any) => e.code === "CONFIG_INVALID");
  assert.throws(bad({ url: "https://user:pw@gateway.example/x" }), (e: any) => e.code === "CONFIG_INVALID");
  assert.throws(bad({ defaultModel: "not-listed" }), (e: any) => e.code === "CONFIG_INVALID");
  assert.throws(bad({ dailyTokenCap: 0 }), (e: any) => e.code === "CONFIG_INVALID");
  assert.throws(() => MG.loadConfig(path.join(ROOT, "missing.json")), (e: any) => e.code === "CONFIG_MISSING");
  assert.throws(() => MG.makePlan(CFG, { prompt: "" }), (e: any) => e.code === "INVALID_REQUEST");
  assert.throws(() => MG.makePlan(CFG, { prompt: "hi", model: "claude-sonnet" }), (e: any) => e.code === "INVALID_REQUEST");
  assert.throws(() => MG.makePlan(CFG, { prompt: "hi", maxTokens: 999999 }), (e: any) => e.code === "INVALID_REQUEST");
  // Plain http is allowed only to this device.
  assert.doesNotThrow(bad({ url: "http://127.0.0.1:4100/v1/nexus/model" }));
});

test("the shipped config is valid and points at the Control Plane on this device", () => {
  const cfg = MG.loadConfig(path.join(__dirname, "..", "config", "model-gateway.json"));
  assert.ok(cfg.url.startsWith("http://127.0.0.1:"));
  assert.ok(cfg.allowedModels.includes(cfg.defaultModel));
  assert.ok(cfg.allowedModels.every((m: string) => m.startsWith("nexus-")));
});

test("no provider key is read or referenced anywhere in the agents' source", () => {
  const src = path.join(__dirname, "..", "src", "genesis");
  const files: string[] = [];
  (function walk(d: string): void {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (/\.(ts|js)$/.test(n)) files.push(f);
    }
  })(src);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf-8");
    assert.ok(!/ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|NEXUS_KEY_|x-api-key|authorization/i.test(text), `${f} must not touch provider keys`);
  }
});
