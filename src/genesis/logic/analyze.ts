import * as readline from "readline";
import { loadMemory, saveMemory } from "./storage/memory";
import { analyzePatterns } from "./logic/analyze";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("[Genesis] Runtime active. Type commands...");

function handleCommand(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;

  const memory = loadMemory();

  memory.push({
    input: trimmed,
    timestamp: Date.now(),
    type: "user",
  });

  saveMemory(memory);

  const patterns = analyzePatterns(memory);

  if (patterns[trimmed] === 3) {
    console.log(`[Genesis] Pattern detected: "${trimmed}" used 3 times.`);
  }

  if (trimmed === "hello") {
    console.log("👋 Hello, Kevin!");
  } else if (trimmed === "orb") {
    console.log("[Genesis] Orb command recognized.");
  } else if (trimmed === "nano") {
    console.log("[Genesis] Nano command recognized.");
  } else if (trimmed === "history") {
    console.log("🧠 Event Memory:");
    memory.forEach((m: any, i: number) => {
      console.log(`${i + 1}. ${m.input}`);
    });
  } else {
    console.log(`[Genesis] Unknown command: ${trimmed}`);
  }
}

rl.prompt();

rl.on("line", (input: string) => {
  handleCommand(input);
  rl.prompt();
});
