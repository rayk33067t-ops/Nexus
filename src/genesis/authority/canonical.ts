import crypto from "crypto";

/**
 * Deterministic JSON: object keys sorted, no whitespace, undefined dropped.
 * The same value always produces the same string, so its digest can bind
 * an approval to one exact plan.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonicalJSON: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJSON(v === undefined ? null : v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalJSON: unsupported type ${typeof value}`);
}

export function digestOf(value: unknown): string {
  return "sha256:" + crypto.createHash("sha256").update(canonicalJSON(value), "utf-8").digest("hex");
}
