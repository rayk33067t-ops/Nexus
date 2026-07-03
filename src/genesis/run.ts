import { runOrb } from "./orb/OrbCycle";

const input = process.argv.slice(2).join(" ");

if (!input) {
  console.log("No input provided");
  process.exit(1);
}

const result = runOrb(input);

console.log("\n=== ORB OUTPUT ===\n");
console.log(result);
