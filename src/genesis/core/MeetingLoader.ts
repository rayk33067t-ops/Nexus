import fs from "fs";
import path from "path";

export function loadMeeting() {

  const file = path.join(
    process.cwd(),
    "src/genesis/config/meeting.json"
  );

  try {

    if (!fs.existsSync(file)) {
      return {
        status: "missing",
        attendees: [],
        mission: {}
      };
    }


    const data = JSON.parse(
      fs.readFileSync(file, "utf-8")
    );


    return {
      status: "loaded",
      title: data.meeting?.title || "",
      opening: data.meeting?.opening || "",
      attendees: data.attendees || [],
      mission: data.mission || {},
      closing: data.closing || ""
    };


  } catch (error) {

    return {
      status: "error",
      attendees: [],
      mission: {}
    };

  }
}
