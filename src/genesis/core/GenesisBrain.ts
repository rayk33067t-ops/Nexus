import { runOrb } from "../orb/OrbCycle";

export interface GenesisState {
  mode: "IDLE" | "BUILD" | "EVOLVE";
  lastInput: string;
  cycleCount: number;
}

export function runGenesis(input: string, state: GenesisState) {
  state.lastInput = input;
  state.cycleCount += 1;

  // decide system mode
  if (input.includes("initialize")) {
    state.mode = "EVOLVE";
  }

  if (input.includes("build")) {
    state.mode = "BUILD";
  }

  // route to Orb only when evolving
  if (state.mode === "EVOLVE") {
    const orbOutput = runOrb(input);

    return {
      system: "GENESIS",
      state,
      orb: orbOutput
    };
  }

  return {
    system: "GENESIS",
    state,
    message: "Idle or build mode active"
  };
}
