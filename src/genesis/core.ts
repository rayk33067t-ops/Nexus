import fs from "fs";

const MEMORY_FILE = "orb_memory.json";

function loadMemory(): any[] {
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveMemory(memory: any[]) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export async function processOrb(input: string) {
  const timestamp = Date.now();
  const entropy = Math.random();

  const memory = loadMemory();

  const safeMemory = Array.isArray(memory) ? memory : [];

  safeMemory.push({ input, timestamp });

  const trimmed = safeMemory.length > 200
    ? safeMemory.slice(-200)
    : safeMemory;

  saveMemory(trimmed);

  return {
    cycle: trimmed.length,
    input,
    memory: trimmed,
    entropy,
    evolutionSignal: "STABLE",
    reflection: "Orb cycle processed",
    lastProcessedInput: input,
  };
}
