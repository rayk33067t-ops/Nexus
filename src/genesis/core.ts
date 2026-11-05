import { loadMemory, saveMemory } from "./storage/memory";
import { analyzePatterns } from "./logic/analyze";
export function handleGenesisInput(input: string) {
  const t = input.trim();
  if (!t) return { action: "noop" };
  const m = loadMemory();
  m.push({ input: t, timestamp: Date.now(), type: "user" });
  const b = m.length > 500 ? m.slice(-500) : m;
  saveMemory(b);
  const p = analyzePatterns(b);
  if (p[t] === 3) return { action: "pattern_detected", input: t, count: 3 };
  return { action: "processed", input: t, patterns: p };
}
