import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isFeatureEnabled,
  parseFeatureConfig,
  rolloutBucket,
  validateFeatureConfig,
} from "../src/genesis/features/FeatureController";

const config = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  killSwitch: false,
  features: {
    demo: {
      enabled: true,
      allowedAgents: ["genesis", "savannah"],
      rolloutPercent: 100,
    },
  },
  ...overrides,
});

test("missing and invalid configuration fail closed", () => {
  assert.equal(isFeatureEnabled(null, "demo", "genesis").enabled, false);
  assert.equal(isFeatureEnabled(undefined, "demo", "genesis").enabled, false);
  assert.equal(parseFeatureConfig("{broken"), null);
  assert.equal(parseFeatureConfig(42), null);
  assert.equal(validateFeatureConfig({ version: 1, killSwitch: false, features: [] }), null);
});

test("global kill switch disables even an enabled feature", () => {
  const result = isFeatureEnabled(config({ killSwitch: true }), "demo", "genesis");
  assert.equal(result.enabled, false);
  assert.match(result.reason, /kill switch/);
});

test("enabled feature permits only listed agents", () => {
  assert.equal(isFeatureEnabled(config(), "demo", "genesis").enabled, true);
  assert.equal(isFeatureEnabled(config(), "demo", "intruder").enabled, false);
});

test("unknown and individually disabled features fail closed", () => {
  assert.equal(isFeatureEnabled(config(), "unknown", "genesis").enabled, false);

  const disabled = config({
    features: {
      demo: {
        enabled: false,
        allowedAgents: ["genesis"],
        rolloutPercent: 100,
      },
    },
  });

  assert.equal(isFeatureEnabled(disabled, "demo", "genesis").enabled, false);
});

test("zero rollout denies and full rollout allows listed agents", () => {
  const zero = config({
    features: {
      demo: { enabled: true, allowedAgents: ["genesis"], rolloutPercent: 0 },
    },
  });
  assert.equal(isFeatureEnabled(zero, "demo", "genesis").enabled, false);
  assert.equal(isFeatureEnabled(config(), "demo", "genesis").enabled, true);
});

test("rollout buckets are deterministic and bounded", () => {
  const first = rolloutBucket("demo", "genesis");
  assert.equal(rolloutBucket("demo", "genesis"), first);
  assert.ok(Number.isInteger(first));
  assert.ok(first >= 0 && first < 100);
  assert.ok(rolloutBucket("demo", "savannah") >= 0);
  assert.ok(rolloutBucket("demo", "savannah") < 100);
});

test("partial rollout decisions match the deterministic bucket", () => {
  const partial = config({
    features: {
      demo: { enabled: true, allowedAgents: ["genesis"], rolloutPercent: 50 },
    },
  });

  const bucket = rolloutBucket("demo", "genesis");
  const result = isFeatureEnabled(partial, "demo", "genesis");
  assert.equal(result.enabled, bucket < 50);
});

test("invalid feature definitions invalidate the entire configuration", () => {
  const invalidCases = [
    { enabled: "yes", allowedAgents: ["genesis"], rolloutPercent: 100 },
    { enabled: true, allowedAgents: ["Genesis"], rolloutPercent: 100 },
    { enabled: true, allowedAgents: ["genesis", "genesis"], rolloutPercent: 100 },
    { enabled: true, allowedAgents: ["genesis"], rolloutPercent: 101 },
    { enabled: true, allowedAgents: ["genesis"], rolloutPercent: -1 },
    { enabled: true, allowedAgents: "genesis", rolloutPercent: 100 },
  ];

  for (const definition of invalidCases) {
    assert.equal(
      validateFeatureConfig({
        version: 1,
        killSwitch: false,
        features: { demo: definition },
      }),
      null,
    );
  }
});

test("decisions and validated configuration are frozen", () => {
  const validated = validateFeatureConfig(config());
  assert.ok(validated);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.features.demo), true);
  assert.equal(Object.isFrozen(validated.features.demo.allowedAgents), true);

  const decision = isFeatureEnabled(validated, "demo", "genesis");
  assert.equal(Object.isFrozen(decision), true);
});

test("feature availability does not claim authorization", () => {
  const result = isFeatureEnabled(config(), "demo", "genesis");
  assert.deepEqual(Object.keys(result).sort(), [
    "agent",
    "enabled",
    "feature",
    "reason",
  ]);
});
