/**
 * Start the NEXUS Control Plane on this device.
 *
 *   npm run control-plane            start it (listens on 127.0.0.1 only)
 *   npm run control-plane -- check   show which models are ready, then exit
 *   npm run control-plane -- log [n] the last n events, and whether the log chain is intact
 *
 * Provider keys come only from this process's environment, for example
 *   export NEXUS_KEY_DEEPSEEK=...   (typed in Termux; never in a file in the repo)
 * A backend whose key is not set is skipped, never guessed.
 */

import { assertProductionPaths } from "../genesis/authority/store";
assertProductionPaths("control-plane");

import { loadControlPlaneConfig } from "./config";
import { controlPlaneLog, health, startControlPlane } from "./server";

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const config = loadControlPlaneConfig();
  if (cmd === "log") {
    const l = controlPlaneLog();
    const n = Number(arg ?? 20);
    for (const e of l.entries.slice(-(Number.isFinite(n) && n > 0 ? n : 20))) console.log(`${e.at}  ${JSON.stringify(e.event)}`);
    console.log(l.ok ? "Event log chain intact." : `EVENT LOG DAMAGED: ${l.reason}`);
    return;
  }
  const h = health(config, process.env);
  for (const [name, chain] of Object.entries(h.models)) {
    console.log(`${name.padEnd(14)} ${chain.map((b) => `${b.provider}/${b.model} ${b.ready ? "ready" : "no key"}`).join("  →  ")}`);
  }
  if (cmd === "check") return;
  const { port } = await startControlPlane({ config });
  console.log(`NEXUS Control Plane listening on http://${config.host}:${port} (this device only).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
