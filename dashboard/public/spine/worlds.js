// Shared helpers for the gateway and world pages.

export async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

export async function getWorlds() {
  const doc = await getJSON("/api/worlds");
  return Array.isArray(doc.worlds) ? doc.worlds : [];
}

/** Apply a world's palette (glow, accent, background) to the page. */
export function applyPalette(world, el = document.documentElement) {
  const [glow, accent, bg] = world.intro.palette;
  el.style.setProperty("--glow", glow);
  el.style.setProperty("--accent", accent);
  el.style.setProperty("--bg", bg);
}

export const STATUS_LABEL = { active: "Active", developing: "Developing", future: "Future" };

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
