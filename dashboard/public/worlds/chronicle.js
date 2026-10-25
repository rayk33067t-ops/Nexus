// The Chronicle world: NEXUS's history, read from src/genesis/config/chronicle.json.

import { getJSON, el } from "/spine/worlds.js";

export async function render(root) {
  let data;
  try {
    data = await getJSON("/api/chronicle");
  } catch {
    root.append(el("p", { class: "error" }, "The Chronicle could not be read."));
    return;
  }

  root.append(
    el("div", { class: "missions" },
      el("div", { class: "mission" }, el("p", { class: "eyebrow" }, "Current mission"), el("p", {}, data.currentMission || "None set")),
      el("div", { class: "mission" }, el("p", { class: "eyebrow" }, "Next mission"), el("p", {}, data.nextMission || "None set")))
  );

  const events = Array.isArray(data.timeline) ? [...data.timeline].sort((a, b) => (a.day ?? 0) - (b.day ?? 0)) : [];
  root.append(el("p", { class: "eyebrow" }, `${data.era || "Timeline"} · ${events.length} ${events.length === 1 ? "entry" : "entries"}`));

  const list = el("ol", { class: "timeline" });
  events.forEach((e, i) => {
    list.append(
      el("li", { style: `--i:${i}` },
        el("div", { class: "day" }, el("span", {}, "DAY"), el("b", {}, String(e.day ?? "?"))),
        el("div", {}, el("h3", {}, e.title || "Untitled"), el("p", {}, e.description || "")))
    );
  });
  root.append(list);
}
