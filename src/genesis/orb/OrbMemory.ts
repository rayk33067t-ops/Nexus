import fs from "fs";

export interface OrbState {
  cycle: number;
  memory: string[];
  entropyHistory: number[];
  summaries: string[];
}

export const initialOrbState: OrbState = {
  cycle: 0,
  memory: [],
  entropyHistory: [],
  summaries: []
};

const STATE_PATH = "orb_state.json";

export function loadState(): OrbState {
  if (!fs.existsSync(STATE_PATH)) {
    return structuredClone(initialOrbState);
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
}

export function saveState(state: OrbState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * NEW: replaces old pushMemory system
 */
export function pushMemory(state: OrbState, entry: string): OrbState {
  return {
    ...state,
    memory: [...state.memory, entry],
    cycle: state.cycle + 1
  };
}
