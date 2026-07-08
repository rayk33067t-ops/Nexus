rimport * as readline from "readline";
import * as fs from "fs";

const MEMORY_FILE = "src/genesis/memory.json";

function loadMemory(): any[] {
  try {
    return JSON.parse(
      fs.readFileSync(MEMORY_FILE, "utf8")
    );
  } catch {
    return [];
  }
}

function saveMemory(memory: any[]) {
  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(memory, null, 2)function analyzeMemory(memory: any[]) {
  const counts: Record<string, number> = {};

  for (const m of memory) {
    const key = (m.input || "").toLowerCase();

    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("[Genesis] Runtime active. Type commands...");
  );
}
