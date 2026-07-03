import { EvolutionSignal, OrbCycleResult } from "./OrbTypes";
import { loadState, pushMemory, saveState } from "./OrbMemory";

export function runOrb(input: string): OrbCycleResult {
  const entropy = Math.random();

  const currentState = loadState();
  const state = pushMemory(currentState, input);

  const memorySize = state.memory.length;
  const cycle = state.cycle;

  saveState(state);

  let evolutionSignal: EvolutionSignal = "STABLE";

  if (entropy > 0.7) evolutionSignal = "EXPAND";
  if (entropy < 0.3) evolutionSignal = "COMPRESS";
  if (memorySize % 5 === 0) evolutionSignal = "RESTRUCTURE";

  return {
    cycle,
    input,
    evolutionSignal,
    memorySize,
    entropy,
    reflection: `Orb cycle ${cycle} processed with memory influence`,
    generatedFiles: [
      {
        path: "src/server.ts",
        content: `console.log("server running");`
      }
    ]
  };
}
