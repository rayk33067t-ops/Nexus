import * as fs from "fs";
import * as path from "path";
const MEMORY_FILE = path.join(process.cwd(), "src/genesis/memory.json");
export function loadMemory(): any[] {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch { return []; }
}
export function saveMemory(memory: any[]) {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}
