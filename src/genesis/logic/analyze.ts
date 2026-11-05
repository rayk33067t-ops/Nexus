export type MemoryEntry = { input: string; timestamp: number; type: string; };
export function analyzePatterns(memory: MemoryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of memory) {
    if (!m?.input) continue;
    const k = String(m.input).trim();
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}
