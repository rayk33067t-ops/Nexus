export type EvolutionSignal = "STABLE" | "EXPAND" | "RESTRUCTURE";

export interface OrbMemoryEntry {
  input: string;
  timestamp: number;
}

export interface OrbState {
  cycle: number;
  memory: OrbMemoryEntry[];
  entropy: number;
  evolutionSignal: EvolutionSignal;
  reflection: string;
  lastProcessedInput?: string;
}
