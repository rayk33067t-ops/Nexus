import { GenesisCore } from "./core";

const genesis = new GenesisCore();

const input = process.argv.slice(2).join(" ");

if (!input) {
  console.log("Please provide a task input");
  process.exit(1);
}

const result = genesis.execute(input);

console.log("\n=== FINAL RESULT ===");
console.log(result);
