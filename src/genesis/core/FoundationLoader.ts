import fs from "fs";
import path from "path";
export function loadFoundation() {
  const cand = [
    path.join(process.cwd(), "src/genesis/config/founder-principles.json"),
    path.join(process.cwd(), "src/genesis/config/agents.json"),
    path.join(__dirname, "../config/founder-principles.json"),
    path.join(__dirname, "../config/agents.json"),
  ];
  for (const f of cand) {
    if (fs.existsSync(f)) {
      try {
        const d = JSON.parse(fs.readFileSync(f, "utf-8"));
        return { status: "loaded", file: f, charter: d.name || "NEXUS", principles: d.principles || [], identity: d.core_identity || null };
      } catch { continue; }
    }
  }
  return { status: "missing", message: "Charter not found" };
}
