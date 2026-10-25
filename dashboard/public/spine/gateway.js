import { getWorlds, el, STATUS_LABEL } from "./worlds.js";

const root = document.getElementById("worlds");

try {
  const worlds = await getWorlds();
  root.textContent = "";
  for (const status of ["active", "developing", "future"]) {
    const group = worlds.filter((w) => w.status === status);
    if (!group.length) continue;
    const grid = el("div", { class: "grid" });
    for (const w of group) {
      const [c1, c2] = w.intro.palette;
      grid.append(
        el("a", { class: "card", href: `/world.html?w=${encodeURIComponent(w.id)}`, style: `--c1:${c1};--c2:${c2}` },
          el("span", { class: `pill ${w.status}` }, STATUS_LABEL[w.status]),
          el("h3", {}, w.name),
          el("p", {}, w.purpose),
          el("div", { class: "go" }, "Enter →"))
      );
    }
    root.append(el("section", { class: "group" }, el("h2", {}, `${STATUS_LABEL[status]} worlds`), grid));
  }
} catch (err) {
  root.textContent = "";
  root.append(el("p", { class: "error" }, "The world registry could not be loaded. Is the dashboard running? (cd dashboard && node server.js)"));
}
