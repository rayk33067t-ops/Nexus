export type CommandContext = {
  raw: string;
  trimmed: string;
};

type CommandHandler = (ctx: CommandContext) => void;

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler) {
    this.commands.set(name.toLowerCase(), handler);
  }

  execute(input: string) {
    const trimmed = input.trim();
    const command = trimmed.toLowerCase();

    const handler = this.commands.get(command);

    if (handler) {
      handler({ raw: input, trimmed });
      return;
    }

    if (command.includes("nano")) {
      console.log("[Genesis] Nano command recognized.");
      return;
    }

    if (command.includes("orb")) {
      console.log("[Genesis] Orb command recognized.");
      return;
    }

    console.log("[Genesis] Unknown command:", trimmed);
  }
}
