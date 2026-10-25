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
 *   npm run warden -- log [n]           show the last n events and check the chain
 *   npm run warden -- reset-log         archive a damaged log after reviewing it
 */

import readline from "readline";

import { verifyLog, readLog } from "./log";
import { HEAD_FILE, LOG_FILE } from "./state";
import { WardenReport, check } from "./Warden";
import { clearLockdown, hasPassphrase, pin, release, resetLog, setPassphrase, trust } from "./founder";

// One reader for the whole run. Lines are queued as they arrive, so typed
// and piped answers both reach the prompt that asked for them.
let rl: readline.Interface | null = null;
let muted = false;
const lines: string[] = [];
const waiting: ((line: string) => void)[] = [];

function reader(): readline.Interface {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  r._writeToOutput = (s: string) => { if (!muted) r.output.write(s); };
  rl.on("line", (line) => { const w = waiting.shift(); if (w) w(line); else lines.push(line); });
  rl.on("close", () => { while (waiting.length) waiting.shift()!(""); });
  return rl;
}

function ask(question: string): Promise<string> {
  reader();
  process.stdout.write(question);
  muted = true;
  return new Promise((resolve) => {
    const done = (line: string) => { muted = false; process.stdout.write("\n"); resolve(line); };
    const queued = lines.shift();
    if (queued !== undefined) done(queued); else waiting.push(done);
  });
}

function closeReader(): void {
  rl?.close();
  rl = null;
}

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
  const [cmd, arg] = argv;
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
      console.log("Usage: npm run warden -- <status | check | watch [s] | init | pin | release <agent> | trust <agent> | lockdown:clear | log [n] | reset-log>");
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => { closeReader(); process.exitCode = code; },
  (err) => { closeReader(); console.error(err?.message ?? String(err)); process.exitCode = 1; }
);
