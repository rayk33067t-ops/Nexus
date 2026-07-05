import { loadState, pushMemory, saveState } from "./OrbMemory";
import { applyFounderReasoning } from "../founder/FounderMode";
import { OrbState } from "./OrbTypes";

export function runOrb(input: string): OrbState {
  let state = loadState();

  const processedInput = applyFounderReasoning(input);

  state = pushMemory(state, processedInput);

  const cycle = state.memory.length;
  const entropy = Math.random();

  let evolutionSignal: "STABLE" | "EXPAND" | "RESTRUCTURE" = "STABLE";

  if (entropy > 0.75) evolutionSignal = "EXPAND";
  if (entropy > 0.92) evolutionSignal = "RESTRUCTURE";

  const updatedState: OrbState = {
    ...state,
    cycle,
    entropy,
    evolutionSignal,
    reflection: `Orb cycle ${cycle} processed`,
    lastProcessedInput: processedInput,
  };

  saveState(updatedState);

  return updatedState;
}
