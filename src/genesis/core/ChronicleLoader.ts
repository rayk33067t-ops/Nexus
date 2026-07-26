import fs from "fs";
import path from "path";

export function loadChronicle() {
  const file = path.join(
    process.cwd(),
    "src/genesis/config/chronicle.json"
  );

  try {
    if (!fs.existsSync(file)) {
      return {
        status: "missing",
        timeline: [],
        currentMission: "",
        nextMission: ""
      };
    }

    const data = JSON.parse(
      fs.readFileSync(file, "utf-8")
    );

    return {
      status: "loaded",
      timeline: data.timeline || [],
      currentMission: data.currentMission || "",
      nextMission: data.nextMission || ""
    };

  } catch (error) {
    return {
      status: "error",
      timeline: [],
      currentMission: "",
      nextMission: ""
    };
  }
}
