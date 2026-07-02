export class GenesisCore {
  execute(taskInput: string) {
    return {
      input: taskInput,
      status: "done",
      result: "Genesis running"
    };
  }
}
