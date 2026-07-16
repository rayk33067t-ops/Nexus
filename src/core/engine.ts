import { EventBus } from "./eventBus";

export class Engine {
  private running = false;
  private bus = new EventBus();

  start() {
    this.running = true;

    console.log("NEXUS Engine Started");

    this.bus.emit("engine.started");

    while (this.running) {
      this.tick();
      break;
    }
  }

  stop() {
    this.running = false;

    console.log("NEXUS Engine Stopped");

    this.bus.emit("engine.stopped");
  }

  tick() {
    console.log("NEXUS Heartbeat");

    this.bus.emit("engine.heartbeat");
  }

  getBus() {
    return this.bus;
  }
}
