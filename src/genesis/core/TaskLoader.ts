import fs from "fs";
import path from "path";

export function loadTasks() {

  const file = path.join(
    process.cwd(),
    "src/genesis/config/tasks.json"
  );

  try {

    if (!fs.existsSync(file)) {
      return {
        status: "missing",
        tasks: []
      };
    }

    const data = JSON.parse(
      fs.readFileSync(file, "utf-8")
    );

    return {
      status: "loaded",
      day: data.day,
      mission: data.mission,
      tasks: data.tasks || []
    };

  } catch {

    return {
      status: "error",
      tasks: []
    };

  }
}
