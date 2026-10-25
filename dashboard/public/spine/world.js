import { getWorlds, applyPalette, el, STATUS_LABEL } from "./worlds.js";
import { playIntro } from "./intro.js";

// Worlds that have their own content. Every other world shows its purpose
// and an "under construction" panel after its intro.
const MODULES = {
  chronicle: () => import("/worlds/chronicle.js"),
};

const content = document.getElementById("content");
const id = new URLSearchParams(location.search).get("w") || "";

try {
  const world = (await getWorlds()).find((w) => w.id === id);
  if (!world) throw new Error("unknown world");

  applyPalette(world);
  document.title = `${world.name} · NEXUS`;
  document.getElementById("status").textContent = `${STATUS_LABEL[world.status]} world`;
  document.getElementById("name").textContent = world.name;
  document.getElementById("purpose").textContent = world.purpose;

  const replay = document.getElementById("replay");
  replay.hidden = false;
  replay.addEventListener("click", () => playIntro(world, { force: true }));

  await playIntro(world);

  if (MODULES[world.id]) {
    const mod = await MODULES[world.id]();
    await mod.render(content, world);
  } else {
    content.append(
      el("div", { class: "building" },
        el("p", {}, el("strong", {}, `${world.name} is ${world.status === "future" ? "planned" : "being built"}.`)),
        el("p", {}, "Its cinematic intro is ready. Its world will appear here when Genesis builds it."))
    );
  }
} catch (err) {
  document.getElementById("name").textContent = "World not found";
  content.append(el("p", { class: "error" }, "That world isn't in the registry. Go back to all worlds and choose one."));
}
