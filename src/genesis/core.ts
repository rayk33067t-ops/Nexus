import * as fs from "fs";

type State = {
  cycle: number;
  memory: string[];
};

export class GenesisCore {
  private stateFile = "orb_state.json";
  private state: State = {
    cycle: 0,
    memory: []
  };

  constructor() {
    this.loadState();
  }

  private loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, "utf-8");
        const parsed = JSON.parse(raw);
        this.state = parsed.state ?? this.state;
      }
    } catch {
      // ignore corrupt state
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({ state: this.state }, null, 2)
      );
    } catch {
      // ignore write errors
    }
  }

  execute(input: string, loops: number = 1) {
    const results = [];

    for (let i = 0; i < loops; i++) {
      this.state.cycle++;

      const cleanInput = input.trim();
      this.state.memory.push(cleanInput);

      const memoryPressure = this.state.memory.length;
      const cyclePressure = this.state.cycle;

      const entropy = memoryPressure * 0.6 + cyclePressure * 0.4;

      let evolutionSignal: "STABLE" | "EXPAND" | "DIVERGE" | "RESTRUCTURE" =
        "STABLE";

      if (entropy > 8) evolutionSignal = "EXPAND";
      if (entropy > 15) evolutionSignal = "DIVERGE";
      if (entropy > 25) evolutionSignal = "RESTRUCTURE";

      const lastInputs = this.state.memory.slice(-3).join(" → ");

      const reflection =
        entropy < 8
          ? "Orb stabilizing persistent loop"
          : entropy < 15
          ? "Orb expanding memory layer"
          : entropy < 25
          ? "Orb diverging system paths"
          : "Orb restructuring core logic";

      const output = {
        cycle: this.state.cycle,
        input: cleanInput,
        evolutionSignal,
        entropy,
        reflection,
        memorySize: this.state.memory.length,
        memoryTrace: lastInputs
      };

      results.push(output);
    }

    this.saveState();

    return results.length === 1 ? results[0] : results;
  }
}
