/**
 * Founder CLI for the NEXUS Key Vault.
 *
 *   npm run vault -- list              the drawers' labels (names, fingerprints, status)
 *   npm run vault -- seal <agent>      seal the agent's current key into its drawer
 *   npm run vault -- check <agent>     prove the drawer opens and holds the right key
 *   npm run vault -- restore <agent>   put the key back on this device (never overwrites)
 *   npm run vault -- page <file.html>  write a page of the labels and logbook (no keys)
 *   npm run vault -- log [n]           the last n logbook entries, and whether the chain is intact
 *   npm run vault -- where             where the vault file is, for copying off the phone
 *
 * Every command that opens or changes a drawer asks for the Founder
 * passphrase, and the vault operation checks it again itself.
 */

import { assertProductionPaths } from "../authority/store";
assertProductionPaths("vault");

import fs from "fs";
import { ask, closeReader } from "../cliPrompt";
import { VAULT_FILE, checkDrawer, listDrawers, logbook, restoreAgent, sealAgent, vaultPage } from "./keyVault";

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "list": {
      const ds = listDrawers();
      if (!ds.length) console.log("The vault is empty.");
      for (const d of ds) console.log(`${d.agent.padEnd(12)} ${d.credential.padEnd(8)} sealed ${d.sealedAt}  ${d.fingerprint}`);
      break;
    }
    case "seal":
    case "check":
    case "restore": {
      if (!arg) throw new Error(`Usage: npm run vault -- ${cmd} <agent>`);
      const pass = await ask("Founder passphrase: ");
      if (cmd === "seal") {
        const d = sealAgent(arg, pass);
        console.log(`Sealed ${d.agent}'s key (fingerprint ${d.fingerprint.slice(0, 16)}…).`);
      } else if (cmd === "check") {
        console.log(checkDrawer(arg, pass) ? `${arg}'s drawer opens and holds the right key.` : `${arg}'s drawer opened, but the key doesn't match its label.`);
      } else {
        const d = restoreAgent(arg, pass);
        console.log(`Restored ${d.agent}'s key to this device (fingerprint ${d.fingerprint.slice(0, 16)}…).`);
      }
      break;
    }
    case "page": {
      if (!arg || !arg.endsWith(".html")) throw new Error("Usage: npm run vault -- page <file.html>");
      fs.writeFileSync(arg, vaultPage(), { flag: "wx" });
      console.log(`Wrote ${arg} (labels and logbook only; no keys).`);
      break;
    }
    case "log": {
      const b = logbook();
      const n = Number(arg ?? 20);
      for (const e of b.entries.slice(-(Number.isFinite(n) && n > 0 ? n : 20))) console.log(`${e.at}  ${JSON.stringify(e.event)}`);
      console.log(b.ok ? "Logbook chain intact." : `LOGBOOK DAMAGED: ${b.reason}`);
      break;
    }
    case "where":
      console.log(VAULT_FILE);
      console.log("This file is safe to copy off the phone as a backup: without your passphrase it is a locked box.");
      break;
    default:
      console.log("Commands: list | seal <agent> | check <agent> | restore <agent> | page <file.html> | log [n] | where");
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(closeReader);
