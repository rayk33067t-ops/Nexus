export class Engine {
  private running = false;

  start() {
    this.running = true;
    console.log("NEXUS Engine Started");

    while (this.running) {
      this.tick();
      break;
    }
  }

  stop() {
    this.running = false;
    console.log("NEXUS Engine Stopped");
  }

  tick() {
    console.log("NEXUS Heartbeat");
  }
}
