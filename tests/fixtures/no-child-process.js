// Preloaded into the dashboard server by tests/dashboard.test.ts.
// Any attempt to start another program (a shell, npx, ts-node, anything) is
// written to the file named by NEXUS_TRIPWIRE_FILE and then refused.
"use strict";
const fs = require("fs");
const cp = require("child_process");

const file = process.env.NEXUS_TRIPWIRE_FILE;
for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  const original = cp[name];
  if (typeof original !== "function") continue;
  cp[name] = function tripwire(...args) {
    try { fs.appendFileSync(file, JSON.stringify({ call: name, command: String(args[0]).slice(0, 200) }) + "\n"); } catch { /* still refuse */ }
    throw new Error(`child_process.${name} is not allowed in the dashboard`);
  };
}
