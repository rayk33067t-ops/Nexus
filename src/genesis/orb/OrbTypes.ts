export type EvolutionSignal =
  | "STABLE"
  | "EXPAND"
  | "RESTRUCTURE"
  | "COMPRESS";

export interface OrbState {
  cycle: number;
  memorySize: number;
  entropy: number;
  lastInput: string;
}

export interface OrbCycleResult {
  cycle: number;
  input: string;
  evolutionSignal: EvolutionSignal;
  memorySize: number;
  entropy: number;
  reflection: string;
  generatedFiles: Array<{
    path: string;
    content: string;
  }>;
}
