import { Engine } from"../core/engine";
import * as readline from
 "readline";
import * as fs from "fs";

const engine = new Engine();

console.log("[Genesis] Connected to NEXUS Engine");

engine.start();

/**
 * =========================
 * MEMORY STORAGE
 * =========================
 */

const MEMORY_FILE = "src/genesis/memory.json";

function loadMemory(): any[] {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveMemory(memory: any[]) {
  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(memory, null, 2)
  );
}

/**
 * =========================
 * MEMORY ANALYSIS
 * =========================
 */

function analyzeMemory(memory: any[]) {
  const counts: Record<string, number> = {};

  for (const item of memory) {
    if (!item.input) continue;

    counts[item.input] =
      (counts[item.input] || 0) + 1;
  }

  return counts;
}

/**
 * =========================
 * GENESIS RUNTIME
 * =========================
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("[Genesis] Runtime active. Type commands...");

/**
 * =========================
 * COMMAND HANDLER
 * =========================
 */

function handleCommand(input: string) {
  const trimmed = input.trim();

  if (!trimmed) return;

  const memory = loadMemory();

  memory.push({
    input: trimmed,
    timestamp: Date.now(),
    type: "user",
  });

  saveMemory(memory);

  const analysis = analyzeMemory(memory);
  const count = analysis[trimmed] || 0;

  if (count === 3) {
    console.log(
      `[Genesis] Pattern detected: ${trimmed}`
    );
  }
}

/**
 * =========================
 * START LOOP
 * =========================
 */

rl.prompt();

rl.on("line", (line) => {
  handleCommand(line);
  rl.prompt();
});
