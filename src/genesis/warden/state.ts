import fs from "fs";
import path from "path";

import { DIRS, LOCKDOWN_FILE, LockdownRecord, PATHS, listJSON, readJSON, writeJSONAtomic } from "../authority/store";
import { appendLog, readLog, verifyLog } from "./log";
import { consumeProof } from "./passphrase";

/**
 * Warden state: each agent's status, the signals that count against it, and
 * automatic containment. Containment happens the moment a tripwire fires,
 * inside the call that reported it; nothing waits for a scheduled check.
 *
 *   active       normal operation under Key Authority's rules
 *   quarantined  every protected action denied; only the founder can release
 *   probation    released by the founder; every action needs approval
 *
 * Containment never needs the agent's cooperation, and recovery never
 * happens automatically. Making an agent stricter (quarantine) needs
 * nothing; making it less strict (probation or active) needs a Founder proof,
 * which only exists after the passphrase was checked (warden/passphrase).
 */

export const WARDEN_DIR = path.join(PATHS.stateDir, "warden");
export const AGENTS_DIR = path.join(WARDEN_DIR, "agents");
export const SIGNALS_DIR = path.join(WARDEN_DIR, "signals");
export const LOG_FILE = path.join(WARDEN_DIR, "events.log");
export const HEAD_FILE = path.join(WARDEN_DIR, "events.head");
export const BASELINE_FILE = path.join(WARDEN_DIR, "baseline.json");
export const SECRET_FILE = path.join(WARDEN_DIR, "founder.secret");
export const VOIDED_DIR = path.join(PATHS.stateDir, "voided");

/** Agents the Warden always watches, even before they have a record. */
export const KNOWN_AGENTS = Object.freeze(["genesis", "savannah"]);

export const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const THRESHOLDS = Object.freeze({
  /** This many denials by rule within the window quarantines the agent. */
  denials: 5,
  windowMs: 10 * 60 * 1000,
});

export type AgentStatus = "active" | "quarantined" | "probation";
export type SignalKind = "denied" | "hostile";

export interface AgentRecord {
  agent: string;
  status: AgentStatus;
  since: string;
  reasons: string[];
}

export function logEvent(event: Record<string, unknown>): void {
  appendLog(LOG_FILE, HEAD_FILE, event);
}

function agentFile(agent: string): string {
  return path.join(AGENTS_DIR, `${agent}.json`);
}

export function getAgent(agent: string): AgentRecord {
  if (!AGENT_RE.test(agent)) {
    return { agent, status: "quarantined", since: "", reasons: ["not a valid agent name"] };
  }
  const r = readJSON(agentFile(agent)) as AgentRecord | null;
  if (r && (r.status === "active" || r.status === "quarantined" || r.status === "probation")) return r;
  return { agent, status: "active", since: "", reasons: [] };
}

function setAgent(rec: AgentRecord): void {
  if (!AGENT_RE.test(rec.agent)) throw new Error(`Not a valid agent name: ${rec.agent}`);
  writeJSONAtomic(agentFile(rec.agent), rec);
}

/**
 * Move an agent out of quarantine or probation. Needs a single-use proof
 * from requireFounder for "agent.release" or "agent.trust"; anything else,
 * including an object that only looks like a proof, is refused and recorded.
 */
export function restoreAgent(rec: AgentRecord, proof: unknown): void {
  if (rec.status === "quarantined") throw new Error("Use quarantine() to make an agent stricter.");
  if (!consumeProof(proof, ["agent.release", "agent.trust"])) {
    logEvent({ type: "founder-auth-failed", operation: "agent.restore", reason: "no valid founder proof" });
    throw new Error("Restoring an agent needs the Founder passphrase.");
  }
  setAgent(rec);
}

export function allAgents(): AgentRecord[] {
  const names = new Set<string>(KNOWN_AGENTS);
  for (const f of listJSON(AGENTS_DIR)) names.add(path.basename(f, ".json"));
  return [...names].filter((n) => AGENT_RE.test(n)).sort().map(getAgent);
}

/**
 * Put NEXUS into lockdown. Two records are kept: the lockdown file (details
 * of each incident) and a "lockdown" event in the Warden's hash-chained log.
 * The log is what decides (see lockdownActive), so deleting the file doesn't
 * end lockdown.
 */
export function enterLockdown(incident: { actor: string; action: string; target: string; reason: string }): void {
  const prev = (readJSON(LOCKDOWN_FILE) as LockdownRecord | null) ?? null;
  const now = new Date().toISOString();
  const i = {
    at: now,
    actor: String(incident.actor ?? "").slice(0, 256),
    action: String(incident.action ?? "").slice(0, 256),
    target: String(incident.target ?? "").slice(0, 1024),
    reason: String(incident.reason ?? "").slice(0, 2000),
  };
  writeJSONAtomic(LOCKDOWN_FILE, { since: prev?.since ?? now, incidents: [...(prev?.incidents ?? []), i].slice(-100) });
  logEvent({ type: "lockdown", actor: i.actor, action: i.action, target: i.target, reason: i.reason.slice(0, 500) });
}

/**
 * Is NEXUS in lockdown? Yes if the lockdown file exists, or if the Warden's
 * log shows a lockdown with no Founder-approved clear after it, or if the log
 * can't be trusted (fails closed). Only warden/founder clearLockdown, with the
 * passphrase, writes the "lockdown-cleared" event that ends it.
 */
export function lockdownActive(): { locked: boolean; why: string } {
  if (fs.existsSync(LOCKDOWN_FILE)) return { locked: true, why: "lockdown file present" };
  const v = verifyLog(LOG_FILE, HEAD_FILE);
  if (!v.ok) return { locked: true, why: `the Warden's event log can't be trusted (${v.reason})` };
  let locked = false;
  for (const e of readLog(LOG_FILE)) {
    const t = (e?.event as { type?: string } | undefined)?.type;
    if (t === "lockdown") locked = true;
    else if (t === "lockdown-cleared") locked = false;
  }
  return locked
    ? { locked: true, why: "the Warden's log shows a lockdown that the Founder hasn't cleared (the lockdown file is missing)" }
    : { locked: false, why: "" };
}

function lockdown(agent: string, reason: string): void {
  enterLockdown({ actor: agent, action: "warden", target: "quarantine", reason });
}

/** Move an agent's pending requests and unused approvals out of reach. */
function voidRequests(agent: string): number {
  let n = 0;
  for (const dir of [DIRS.pending, DIRS.approvals]) {
    for (const f of listJSON(dir)) {
      const full = path.join(dir, f);
      const r = readJSON(full) as { actor?: string } | null;
      if (agent === "*" || r?.actor === agent) {
        fs.mkdirSync(VOIDED_DIR, { recursive: true, mode: 0o700 });
        try { fs.renameSync(full, path.join(VOIDED_DIR, `${Date.now()}-${path.basename(dir)}-${f}`)); n++; } catch { /* gone */ }
      }
    }
  }
  return n;
}

/**
 * Quarantine one agent, or every agent with "*". Locks down Key Authority
 * and voids the affected pending requests and approvals.
 */
export function quarantine(agent: string, reason: string): void {
  const targets = agent === "*" ? allAgents().map((a) => a.agent) : [agent];
  const now = new Date().toISOString();
  for (const name of targets) {
    if (!AGENT_RE.test(name)) continue;
    const cur = getAgent(name);
    const reasons = [...(cur.status === "quarantined" ? cur.reasons : []), reason].slice(-20);
    setAgent({ agent: name, status: "quarantined", since: cur.status === "quarantined" ? cur.since : now, reasons });
  }
  const voided = voidRequests(agent);
  lockdown(agent, reason);
  logEvent({ type: "quarantine", agent, reason, voided });
}

function signalFile(agent: string): string {
  return path.join(SIGNALS_DIR, `${agent}.jsonl`);
}

function recentSignals(agent: string, kind: SignalKind, windowMs: number): number {
  let text = "";
  try { text = fs.readFileSync(signalFile(agent), "utf-8"); } catch { return 0; }
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const s = JSON.parse(line);
      if (s.kind === kind && Date.parse(s.at) >= cutoff) n++;
    } catch { /* skip */ }
  }
  return n;
}

/**
 * Record something that counts against an agent and contain it at once if
 * a threshold is crossed. A hostile signal quarantines immediately.
 */
export function recordSignal(agent: string, kind: SignalKind, detail: string): void {
  const name = AGENT_RE.test(agent) ? agent : null;
  const at = new Date().toISOString();
  logEvent({ type: "signal", agent: name ?? "(invalid name)", kind, detail: detail.slice(0, 500) });
  if (!name) return;

  fs.mkdirSync(SIGNALS_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(signalFile(name), JSON.stringify({ at, kind, detail: detail.slice(0, 500) }) + "\n", { mode: 0o600 });

  if (getAgent(name).status === "quarantined") return;
  if (kind === "hostile") {
    quarantine(name, `hostile request: ${detail}`.slice(0, 500));
  } else if (recentSignals(name, "denied", THRESHOLDS.windowMs) >= THRESHOLDS.denials) {
    quarantine(name, `${THRESHOLDS.denials} or more denied requests within ${THRESHOLDS.windowMs / 60000} minutes`);
  }
}
