import { OrbCycle } from "../orb/OrbCycle";
import { OrbMemory } from "../orb/OrbMemory";

export class GenesisCore {
  private orb = new OrbCycle();
  private memory = new OrbMemory();

  execute(input: string) {
    const state = {
      cycle: this.memory.size(),
      memorySize: this.memory.size(),
      entropy: Math.random(),
      input
    };

    const result = this.orb.run(state);

    this.memory.add(state);

    return result;
  }
}
