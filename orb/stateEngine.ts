export type OrbState = "Dormant"|"Aware"|"Focused";
export function getOrbState(c: number, ago: number | null): OrbState { if (c===0) return "Dormant"; if (ago!==null && ago<60) return "Focused"; return "Aware"; }
