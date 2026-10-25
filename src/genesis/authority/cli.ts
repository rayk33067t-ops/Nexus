/**
 * Founder CLI for Key Authority.
 *
 *   npm run authority -- pending           list requests waiting for approval
 *   npm run authority -- show <id>         show one request in full
 *   npm run authority -- approve <id>      approve it once, for 15 minutes
 *   npm run authority -- reject <id>       discard it
 *   npm run authority -- rules             check the rules file and list rules
 *   npm run authority -- lockdown          show lockdown status and incidents
 *   (end lockdown with: npm run warden -- lockdown:clear)
 */

import { PATHS } from "./store";
import { loadRules } from "./KeyAuthority";
import { approve, getPending, listPending, lockdownStatus, reject } from "./founder";

function show(p: { id: string; actor: string; action: string; target: string; digest: string; summary: string; reasons: string[]; requestedAt: string }) {
  console.log(`Request ${p.id}  (${p.requestedAt})`);
  console.log(`  ${p.actor} wants ${p.action} on ${p.target}`);
  console.log(`  Plan digest: ${p.digest}`);
  if (p.reasons?.length) console.log(`  Why approval is needed: ${p.reasons.join("; ")}`);
  if (p.summary) console.log(p.summary.split("\n").map((l) => "  " + l).join("\n"));
}

function main(argv: string[]): number {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "pending": {
      const list = listPending();
      if (!list.length) { console.log("No requests are waiting for approval."); return 0; }
      for (const p of list) { show(p); console.log(); }
      console.log(`Approve one with: npm run authority -- approve <id>`);
      return 0;
    }
    case "show":
      show(getPending(arg ?? ""));
      return 0;
    case "approve": {
      const a = approve(arg ?? "");
      console.log(`Approved ${a.id}: ${a.actor} may ${a.action} on ${a.target} once, until ${new Date(a.expiresAt).toLocaleTimeString()}.`);
      console.log("Only this exact plan is covered. Run the build again to use the approval.");
      return 0;
    }
    case "reject": {
      const p = reject(arg ?? "");
      console.log(`Rejected ${p.id}: ${p.actor} ${p.action} on ${p.target}.`);
      return 0;
    }
    case "rules": {
      const r = loadRules();
      console.log(`Rules file: ${PATHS.rulesPath}`);
      if (!r.ok) { console.log(`Not usable: ${r.reason}. Every protected action is denied.`); return 1; }
      if (!r.rules.length) console.log("No rules. Every protected action is denied.");
      for (const x of r.rules) console.log(`  ${x.effect.padEnd(5)}  ${x.actor} ${x.action} ${x.target}   [${x.id}]`);
      return 0;
    }
    case "lockdown": {
      const l = lockdownStatus();
      if (!l) { console.log("Not in lockdown."); return 0; }
      console.log(`IN LOCKDOWN since ${l.since}. Every action needs your approval.`);
      for (const i of l.incidents) console.log(`  ${i.at}  ${i.actor} ${i.action} ${i.target}\n    ${i.reason}`);
      console.log("Clear it with: npm run warden -- lockdown:clear");
      return 0;
    }
    case "lockdown:clear":
      console.log("Lockdown is now ended through the Warden, which asks for your passphrase:");
      console.log("  npm run warden -- lockdown:clear");
      return 1;
    default:
      console.log("Usage: npm run authority -- <pending | show <id> | approve <id> | reject <id> | rules | lockdown>");
      return cmd ? 1 : 0;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err: any) {
  console.error(err?.message ?? String(err));
  process.exitCode = 1;
}
