import readline from "readline";

/**
 * Prompts for the Founder CLIs. Answers are not echoed (for passphrases).
 * One reader for the whole run. Lines are queued as they arrive, so typed
 * and piped answers both reach the prompt that asked for them.
 */

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

export function ask(question: string): Promise<string> {
  reader();
  process.stdout.write(question);
  muted = true;
  return new Promise((resolve) => {
    const done = (line: string) => { muted = false; process.stdout.write("\n"); resolve(line); };
    const queued = lines.shift();
    if (queued !== undefined) done(queued); else waiting.push(done);
  });
}

export function closeReader(): void {
  rl?.close();
  rl = null;
}
