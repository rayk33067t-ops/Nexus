import * as fs from "fs";

const MEMORY_FILE = "src/genesis/memory.json";

export function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function saveMemory(memory: any[]) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}
