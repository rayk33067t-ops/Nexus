import fs from "fs";
import path from "path";
import { OrbState, OrbMemoryEntry } from "./OrbTypes";

const MEMORY_PATH = path.join(process.cwd(), "orb_memory.json");

export function loadState(): OrbState {
  if (!fs.existsSync(MEMORY_PATH)) {
    return {
      cycle: 0,
      memory: [],
      entropy: 0,
      evolutionSignal: "STABLE",
      reflection: "initial state",
      lastProcessedInput: undefined,
    };
  }

  const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
  return JSON.parse(raw);
}

export function saveState(state: OrbState): void {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(state, null, 2));
}

// FIXED: prevents duplicate spam
export function pushMemory(state: OrbState, input: string): OrbState {
  const last = state.memory[state.memory.length - 1];

  if (last?.input === input) {
    return state;
  }

  const entry: OrbMemoryEntry = {
    input,
    timestamp: Date.now(),
  };

  return {
    ...state,
    memory: [...state.memory, entry],
  };
}

export function getMemorySize(state: OrbState): number {
  return state.memory.length;
}
