import fs from "fs";
import path from "path";

export function loadAgents() {
  const file = path.join(
    process.cwd(),
    "src/genesis/config/agents.json"
  );

  try {
    if (!fs.existsSync(file)) {
      return {
        status: "missing",
        agents: []
      };
    }

    const data = JSON.parse(
      fs.readFileSync(file, "utf-8")
    );

    return {
      status: "loaded",
      agents: data.agents || []
    };

  } catch (error) {
    return {
      status: "error",
      agents: []
    };
  }
}
