import * as readline from "readline";
import { runCommand } from "./commandRegistry";
import { loadMemory } from "./memory";

const memory = loadMemory();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n=== GENESIS COMMAND SYSTEM ACTIVE ===");
console.log("Type 'exit' to quit.\n");

function run(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;

  // 🧱 HARD GATE: block shell commands entering system
  if (
    trimmed.startsWith("nano ") ||
    trimmed.startsWith("cd ") ||
    trimmed.startsWith("ls") ||
    trimmed.startsWith("pwd")
  ) {
    console.log("\n=== SYSTEM OUTPUT ===");
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: "shell command detected - blocked at runtime gate",
        },
        null,
        2
      )
    );
    console.log("\n--- ready ---\n");
    return;
  }

  const result = runCommand(trimmed, {
    memory: Object.freeze(memory),
  });

  console.log("\n=== SYSTEM OUTPUT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("\n--- ready ---\n");
}

rl.on("line", (input) => {
  const trimmed = input.trim();

  if (trimmed === "exit") {
    process.exit(0);
  }

  run(trimmed);
});
