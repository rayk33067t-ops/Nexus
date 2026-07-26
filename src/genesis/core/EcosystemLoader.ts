import fs from "fs";
import path from "path";

export function loadEcosystem() {
  const file = path.join(
    process.cwd(),
    "src/genesis/config/ecosystem-map.json"
  );

  if (!fs.existsSync(file)) {
    return {
      status: "missing",
      message: "Ecosystem map not found"
    };
  }

  const data = JSON.parse(fs.readFileSync(file, "utf-8"));

  return {
    status: "loaded",
    name: data.name,
    active: data.activeSystems,
    developing: data.developingSystems,
    future: data.futureSystems,
    identity: data.identity
  };
}
