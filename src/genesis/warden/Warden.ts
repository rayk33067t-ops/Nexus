import path from "path";

import { readJSON } from "../authority/store";
import { Manifest, compareManifests, describeDiff, isClean, manifest } from "./integrity";
import { verifyLog } from "./log";
import { AgentRecord, BASELINE_FILE, HEAD_FILE, LOG_FILE, allAgents, getAgent, logEvent, quarantine } from "./state";

/**
 * The Warden: watches agents through signals no agent can switch off, and
 * contains them automatically. It has no AI and takes no instructions from
 * agents; it acts on code integrity, the event log and recorded signals.
 *
 * NEXUS_ROOT (default: the working directory) is the repo it checks,
 * resolved once at load.
 */

export const ROOT = path.resolve(process.env.NEXUS_ROOT || process.cwd());

export interface Baseline extends Manifest {
  pinnedAt: string;
  logHead: string | null;
}

export interface WardenReport {
  pinned: boolean;
  integrity: { ok: boolean; detail: string };
  log: { ok: boolean; detail: string; entries: number };
  agents: AgentRecord[];
  actions: string[];
}

export function readBaseline(): Baseline | null {
  const b = readJSON(BASELINE_FILE) as Baseline | null;
  return b && typeof b.commit === "string" && b.files && typeof b.files === "object" ? b : null;
}

/** Run every tripwire now, contain anything that fails, and report. */
export function check(): WardenReport {
  const actions: string[] = [];
  const baseline = readBaseline();

  let integrity = { ok: true, detail: "not pinned yet; run `npm run warden -- pin` to record the known-good code" };
  if (baseline) {
    try {
      const diff = compareManifests(baseline, manifest(ROOT));
      if (isClean(diff)) {
        integrity = { ok: true, detail: `matches the pinned code (commit ${baseline.commit.slice(0, 7)})` };
      } else {
        integrity = { ok: false, detail: describeDiff(diff) };
      }
    } catch (err: any) {
      integrity = { ok: false, detail: `could not fingerprint the code (${err?.message ?? err})` };
    }
    if (!integrity.ok) {
      quarantine("*", `code differs from the pinned version: ${integrity.detail}`);
      actions.push("Quarantined every agent: the code no longer matches what you pinned.");
    }
  }

  const lc = verifyLog(LOG_FILE, HEAD_FILE);
  const log = { ok: lc.ok, detail: lc.reason, entries: lc.count };
  if (!lc.ok) {
    quarantine("*", `event log tampered: ${lc.reason}`);
    actions.push("Quarantined every agent: the Warden's event log has been altered.");
  }

  return { pinned: !!baseline, integrity, log, agents: allAgents(), actions };
}

/**
 * Called before an agent starts. Runs every tripwire, then allows the start
 * only if the code is intact and the agent is not quarantined.
 */
export function startupGate(agent: string): { ok: boolean; reason: string; warnings: string[] } {
  const r = check();
  const warnings: string[] = [];
  if (!r.pinned) warnings.push("The Warden has no pinned known-good code yet, so code changes cannot be detected.");
  if (!r.integrity.ok) return { ok: false, reason: `code integrity failed: ${r.integrity.detail}`, warnings };
  if (!r.log.ok) return { ok: false, reason: `event log failed: ${r.log.detail}`, warnings };
  const a = getAgent(agent);
  if (a.status === "quarantined") return { ok: false, reason: `${agent} is quarantined: ${a.reasons.join("; ")}`, warnings };
  if (a.status === "probation") warnings.push(`${agent} is on probation: every protected action needs your approval.`);
  logEvent({ type: "start", agent, status: a.status });
  return { ok: true, reason: "allowed", warnings };
}
