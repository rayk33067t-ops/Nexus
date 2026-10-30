/**
 * Founder CLI for the Warden.
 *
 *   npm run warden -- status            agents, code integrity, event log
 *   npm run warden -- check             run every tripwire now (contains on failure)
 *   npm run warden -- watch [seconds]   keep checking (default every 60 s) until Ctrl+C
 *   npm run warden -- init              set or change your founder passphrase
 *   npm run warden -- pin               record the current code as known-good
 *   npm run warden -- release <agent>   quarantined → probation
 *   npm run warden -- trust <agent>     probation → active
 *   npm run warden -- lockdown:clear    end lockdown once no agent is quarantined
 *   npm run warden -- issue <agent> [days]   issue (or replace) an agent's credential, default 90 days
 *   npm run warden -- revoke <agent>    revoke an agent's credential at once
 *   npm run warden -- credentials       list credentials (fingerprints only)
 *   npm run warden -- log [n]           show the last n events and check the chain
 *   npm run warden -- reset-log         archive a damaged log after reviewing it
 *
 * Every command that changes trust asks for the Founder passphrase, and the
 * operation itself checks it too, not just this CLI.
 */

import { assertProductionPaths } from "../authority/store";
assertProductionPaths("warden");

import { verifyLog, readLog } from "./log";
import { HEAD_FILE, LOG_FILE } from "./state";
import { WardenReport, check } from "./Warden";
import { clearLockdown, hasPassphrase, issueCredential, pin, release, resetLog, revokeCredential, setPassphrase, trust } from "./founder";
import { listCredentials } from "../authority/credentials";
import { ask, closeReader } from "../cliPrompt";

function print(r: WardenReport): void {
  console.log(`Code:  ${r.integrity.ok ? "OK" : "FAILED"}, ${r.integrity.detail}`);
  console.log(`Log:   ${r.log.ok ? "OK" : "FAILED"}, ${r.log.detail} (${r.log.entries} events)`);
  console.log("Agents:");
  for (const a of r.agents) {
    const why = a.reasons.length ? `, ${a.reasons[a.reasons.length - 1]}` : "";
    console.log(`  ${a.agent.padEnd(10)} ${a.status.toUpperCase()}${why}`);
  }
  for (const act of r.actions) console.log(`ACTION: ${act}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg, arg2] = argv;
  switch (cmd) {
    case "status":
    case "check":
      print(check());
      return 0;
    case "watch": {
      const secs = Math.max(10, Number(arg) || 60);
      console.log(`Watching every ${secs} s. Press Ctrl+C to stop.`);
      const tick = () => { const r = check(); console.log(`\n[${new Date().toLocaleTimeString()}]`); print(r); };
      tick();
      setInterval(tick, secs * 1000);
      return await new Promise<number>(() => { /* runs until Ctrl+C */ });
    }
    case "init": {
      const old = hasPassphrase() ? await ask("Current passphrase: ") : undefined;
      const a = await ask("New founder passphrase (10+ characters, never stored): ");
      const b = await ask("Repeat it: ");
      if (a !== b) { console.log("They don't match. Nothing changed."); return 1; }
      setPassphrase(a, old);
      console.log("Passphrase set. Keep it somewhere off this phone; NEXUS cannot recover it.");
      return 0;
    }
    case "pin": {
      const b = pin(await ask("Founder passphrase: "));
      console.log(`Pinned ${Object.keys(b.files).length} files at commit ${b.commit.slice(0, 7)} as known-good.`);
      console.log("Only pin code you have reviewed; any later change to it quarantines every agent.");
      return 0;
    }
    case "release":
      release(arg ?? "", await ask("Founder passphrase: "));
      console.log(`${arg} is on probation: every protected action needs your approval until you run trust.`);
      return 0;
    case "trust":
      trust(arg ?? "", await ask("Founder passphrase: "));
      console.log(`${arg} is active again.`);
      return 0;
    case "lockdown:clear":
      console.log(clearLockdown(await ask("Founder passphrase: ")) ? "Lockdown cleared." : "Not in lockdown.");
      return 0;
    case "issue": {
      const days = arg2 === undefined ? undefined : Number(arg2);
      const c = issueCredential(arg ?? "", await ask("Founder passphrase: "), days);
      console.log(`Issued a credential for ${c.agent}, valid until ${c.expiresAt}.`);
      console.log(`Fingerprint: ${c.fingerprint}`);
      console.log(`The private key is in ${c.keyFile} (readable only by this Termux user). Any earlier credential for ${c.agent} no longer works.`);
      return 0;
    }
    case "revoke": {
      const n = revokeCredential(arg ?? "", await ask("Founder passphrase: "));
      console.log(n ? `Revoked ${n} credential(s) for ${arg}. Its requests are refused from now on.` : `${arg} had no active credential.`);
      return 0;
    }
    case "credentials": {
      const list = listCredentials();
      if (!list.length) { console.log("No credentials issued yet. Issue one with: npm run warden -- issue genesis"); return 0; }
      for (const c of list) {
        const state = c.revokedAt ? `revoked ${c.revokedAt}` : Date.parse(c.expiresAt) <= Date.now() ? `expired ${c.expiresAt}` : `active until ${c.expiresAt}`;
        console.log(`  ${c.agent.padEnd(10)} ${c.fingerprint.slice(0, 16)}…  ${state}`);
      }
      return 0;
    }
    case "log": {
      const n = Math.max(1, Number(arg) || 20);
      for (const e of readLog(LOG_FILE).slice(-n)) console.log(`${e.seq}  ${e.at}  ${JSON.stringify(e.event)}`);
      const v = verifyLog(LOG_FILE, HEAD_FILE);
      console.log(`\nChain: ${v.ok ? "intact" : "DAMAGED, " + v.reason}. Head: ${v.lastHash ?? "none"}`);
      console.log("Note the head somewhere off the phone to detect a full rewrite later.");
      return v.ok ? 0 : 1;
    }
    case "reset-log":
      console.log(`Archived the old log to ${resetLog(await ask("Founder passphrase: "))}. A fresh chain has started.`);
      return 0;
    default:
      console.log("Usage: npm run warden -- <status | check | watch [s] | init | pin | release <agent> | trust <agent> | lockdown:clear | issue <agent> [days] | revoke <agent> | credentials | log [n] | reset-log>");
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => { closeReader(); process.exitCode = code; },
  (err) => { closeReader(); console.error(err?.message ?? String(err)); process.exitCode = 1; }
);
