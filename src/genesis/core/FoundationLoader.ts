import fs from "fs";
import path from "path";

export function loadFoundation() {
  const file = path.join(
    process.cwd(),
    "../../genesis/config/founder-principles.json"
  );

  if (!fs.existsSync(file)) {
    return {
      status: "missing",
      message: "Founder's Charter not found"
    };
  }

  const data = JSON.parse(fs.readFileSync(file, "utf-8"));

  return {
    status: "loaded",
    charter: data.name,
    principles: data.principles,
    identity: data.core_identity
  };
}
