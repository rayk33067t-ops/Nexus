export class GenesisRegistry {
  private systems = new Map<string, unknown>();

  register(name: string, system: unknown) {
    this.systems.set(name, system);
  }

  get(name: string) {
    return this.systems.get(name);
  }

  has(name: string) {
    return this.systems.has(name);
  }

  list() {
    return Array.from(this.systems.keys());
  }
}

export const registry = new GenesisRegistry();
