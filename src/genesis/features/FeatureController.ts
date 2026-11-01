import crypto from "crypto";

/**
 * NEXUS Feature Controller.
 *
 * Controls feature availability only. It is NOT an authorization system
 * and must never replace Key Authority or coreGuard.
 *
 * Fail-closed rules:
 * - Missing, malformed, or invalid configuration disables all features.
 * - A global kill switch disables every feature.
 * - Unknown features and unauthorized agents are disabled.
 * - Rollout assignment is deterministic for a given feature and agent.
 */

export interface FeatureDefinition {
  readonly enabled: boolean;
  readonly allowedAgents: readonly string[];
  readonly rolloutPercent: number;
}

export interface FeatureConfig {
  readonly version: 1;
  readonly killSwitch: boolean;
  readonly features: Readonly<Record<string, FeatureDefinition>>;
}

export interface FeatureDecision {
  readonly enabled: boolean;
  readonly feature: string;
  readonly agent: string;
  readonly reason: string;
}

const NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const AGENT_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function denied(feature: string, agent: string, reason: string): FeatureDecision {
  return Object.freeze({ enabled: false, feature, agent, reason });
}

export function validateFeatureConfig(raw: unknown): FeatureConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1 || typeof doc.killSwitch !== "boolean") return null;
  if (!doc.features || typeof doc.features !== "object" || Array.isArray(doc.features)) {
    return null;
  }

  const features: Record<string, FeatureDefinition> = Object.create(null);

  for (const [name, value] of Object.entries(doc.features as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || !value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const item = value as Record<string, unknown>;
    if (typeof item.enabled !== "boolean") return null;
    if (!Array.isArray(item.allowedAgents) || item.allowedAgents.length > 256) return null;
    if (!item.allowedAgents.every(
      (agent) => typeof agent === "string" && AGENT_RE.test(agent)
    )) return null;
    if (new Set(item.allowedAgents).size !== item.allowedAgents.length) return null;
    if (
      typeof item.rolloutPercent !== "number" ||
      !Number.isFinite(item.rolloutPercent) ||
      item.rolloutPercent < 0 ||
      item.rolloutPercent > 100
    ) return null;

    features[name] = Object.freeze({
      enabled: item.enabled,
      allowedAgents: Object.freeze([...item.allowedAgents]),
      rolloutPercent: item.rolloutPercent,
    });
  }

  return Object.freeze({
    version: 1,
    killSwitch: doc.killSwitch,
    features: Object.freeze(features),
  });
}

/** Parse JSON safely. Any parse or validation failure returns null. */
export function parseFeatureConfig(text: unknown): FeatureConfig | null {
  if (typeof text !== "string") return null;

  try {
    return validateFeatureConfig(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Stable bucket in the range [0, 100), derived from feature and agent. */
export function rolloutBucket(feature: string, agent: string): number {
  const hash = crypto
    .createHash("sha256")
    .update(`${feature}\0${agent}`, "utf8")
    .digest();

  // First 32 bits; modulo 100 gives a stable rollout bucket.
  return hash.readUInt32BE(0) % 100;
}

/**
 * Check availability only. Callers must still use coreGuard/Key Authority
 * for protected actions; an enabled result grants no authority or capability.
 */
export function isFeatureEnabled(
  config: unknown,
  feature: unknown,
  agent: unknown
): FeatureDecision {
  const featureName = typeof feature === "string" ? feature : "";
  const agentName = typeof agent === "string" ? agent : "";

  if (!NAME_RE.test(featureName)) {
    return denied(featureName, agentName, "invalid feature name");
  }
  if (!AGENT_RE.test(agentName)) {
    return denied(featureName, agentName, "invalid agent name");
  }

  const valid = validateFeatureConfig(config);
  if (!valid) return denied(featureName, agentName, "missing or invalid feature configuration");
  if (valid.killSwitch) return denied(featureName, agentName, "global feature kill switch is active");

  const definition = valid.features[featureName];
  if (!definition) return denied(featureName, agentName, "unknown feature");
  if (!definition.enabled) return denied(featureName, agentName, "feature is disabled");
  if (!definition.allowedAgents.includes(agentName)) {
    return denied(featureName, agentName, "agent is not on the feature allowlist");
  }
  if (definition.rolloutPercent === 0) {
    return denied(featureName, agentName, "rollout percentage is zero");
  }
  if (definition.rolloutPercent < 100 &&
      rolloutBucket(featureName, agentName) >= definition.rolloutPercent) {
    return denied(featureName, agentName, "agent is outside the feature rollout");
  }

  return Object.freeze({
    enabled: true,
    feature: featureName,
    agent: agentName,
    reason: "feature enabled for this agent",
  });
}
