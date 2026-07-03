export class GenesisCore {
  private cycle = 0;
  private memory: string[] = [];

  execute(input: string) {
    this.cycle++;

    const cleanInput = input.trim();
    this.memory.push(cleanInput);

    const memoryPressure = this.memory.length;
    const cyclePressure = this.cycle;

    const entropy = memoryPressure * 0.6 + cyclePressure * 0.4;

    let evolutionSignal: "STABLE" | "EXPAND" | "DIVERGE" | "RESTRUCTURE" =
      "STABLE";

    if (entropy > 8) evolutionSignal = "EXPAND";
    if (entropy > 15) evolutionSignal = "DIVERGE";
    if (entropy > 25) evolutionSignal = "RESTRUCTURE";

    const lastInputs = this.memory.slice(-3).join(" → ");

    const reflection =
      entropy < 8
        ? "Orb stabilizing core loop"
        : entropy < 15
        ? "Orb expanding internal structure"
        : entropy < 25
        ? "Orb diverging behavior paths"
        : "Orb restructuring system logic";

    return {
      status: "ok",
      cycle: this.cycle,
      input: cleanInput,
      evolutionSignal,
      entropy,
      reflection,
      memorySize: this.memory.length,
      memoryTrace: lastInputs
    };
  }
}
