type Listener = (data?: any) => void;

export class EventBus {
  private events: Record<string, Listener[]> = {};

  on(event: string, listener: Listener) {
    if (!this.events[event]) {
      this.events[event] = [];
    }

    this.events[event].push(listener);
  }

  emit(event: string, data?: any) {
    const listeners = this.events[event] || [];

    for (const listener of listeners) {
      listener(data);
    }
  }
}
