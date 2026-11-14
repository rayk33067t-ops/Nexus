import fs from "fs";
import path from "path";

import { CODE_ROOT } from "../genesis/authority/store";
import { MODEL_NAME_RE } from "../genesis/providers/modelGateway";

/**
 * NEXUS Control Plane configuration. It names NEXUS models ("nexus-primary"
 * and friends) and, for each, an ordered chain of open-weight backends to try.
 * It never holds a key: a provider names the environment variable its key is
 * read from, and that variable lives only in the Control Plane's own process.
 */

export const CONTROL_PLANE_CONFIG = path.join(CODE_ROOT, "config", "control-plane.json");
export const KEY_ENV_RE = /^NEXUS_KEY_[A-Z0-9_]{1,48}$/;
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const UPSTREAM_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface Provider {
  /** OpenAI-compatible base URL; requests go to `${baseUrl}/chat/completions`. */
  readonly baseUrl: string;
  /** Environment variable holding the key, or null for a keyless local server. */
  readonly keyEnv: string | null;
}

export interface Backend {
  readonly provider: string;
  readonly model: string;
}

export interface ControlPlaneConfig {
  readonly host: string;
  readonly port: number;
  /** Agents allowed to call models at all. Key Authority still decides each call on the agent's side. */
  readonly agents: readonly string[];
  readonly providers: Readonly<Record<string, Provider>>;
  /** NEXUS model name → backends to try in order. */
  readonly models: Readonly<Record<string, readonly Backend[]>>;
  /** Input + output tokens each agent may use per UTC day, across all models. */
  readonly perAgentDailyTokenCap: number;
  readonly maxOutputTokens: number;
  readonly upstreamTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Control Plane config: ${message}`);
    this.name = "ConfigError";
  }
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function parseProvider(name: string, raw: unknown): Provider {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") throw new ConfigError(`provider ${name} is not an object`);
  let url: URL;
  try {
    url = new URL(String(p.baseUrl));
  } catch {
    throw new ConfigError(`provider ${name}: baseUrl is not a valid URL`);
  }
  if (url.username || url.password) throw new ConfigError(`provider ${name}: baseUrl must not contain credentials`);
  if (url.search || url.hash) throw new ConfigError(`provider ${name}: baseUrl must not carry a query or fragment`);
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new ConfigError(`provider ${name}: baseUrl must use https (plain http only on this device)`);
  const keyEnv = p.keyEnv === null || p.keyEnv === undefined ? null : p.keyEnv;
  if (keyEnv !== null && (typeof keyEnv !== "string" || !KEY_ENV_RE.test(keyEnv))) {
    throw new ConfigError(`provider ${name}: keyEnv must be null or a NEXUS_KEY_... variable name (never the key itself)`);
  }
  if (keyEnv === null && !local) throw new ConfigError(`provider ${name}: a remote provider needs a keyEnv`);
  return Object.freeze({ baseUrl: url.toString().replace(/\/+$/, ""), keyEnv: keyEnv as string | null });
}

export function parseControlPlaneConfig(raw: unknown): ControlPlaneConfig {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object") throw new ConfigError("not an object");

  const host = c.host === undefined ? "127.0.0.1" : c.host;
  if (typeof host !== "string" || !LOOPBACK.has(host)) {
    throw new ConfigError("host must be this device (127.0.0.1); the Control Plane is not exposed to the network");
  }
  const port = c.port === undefined ? 4100 : c.port;
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) throw new ConfigError("port must be 0..65535");

  if (!Array.isArray(c.agents) || c.agents.length === 0 || !c.agents.every((a) => typeof a === "string" && NAME_RE.test(a) && a !== "founder")) {
    throw new ConfigError("agents must be a non-empty list of agent names");
  }

  const providersIn = c.providers as Record<string, unknown> | undefined;
  if (!providersIn || typeof providersIn !== "object" || Array.isArray(providersIn)) throw new ConfigError("providers must be an object");
  const providers: Record<string, Provider> = {};
  for (const [name, p] of Object.entries(providersIn)) {
    if (!NAME_RE.test(name)) throw new ConfigError(`provider name "${name}" is not allowed`);
    providers[name] = parseProvider(name, p);
  }

  const modelsIn = c.models as Record<string, unknown> | undefined;
  if (!modelsIn || typeof modelsIn !== "object" || Array.isArray(modelsIn) || Object.keys(modelsIn).length === 0) {
    throw new ConfigError("models must name at least one NEXUS model");
  }
  const models: Record<string, readonly Backend[]> = {};
  for (const [name, chain] of Object.entries(modelsIn)) {
    if (!MODEL_NAME_RE.test(name)) throw new ConfigError(`model name "${name}" is not allowed`);
    if (!Array.isArray(chain) || chain.length === 0 || chain.length > 5) throw new ConfigError(`model ${name} needs 1 to 5 backends`);
    models[name] = Object.freeze(
      chain.map((b, i) => {
        const be = b as Record<string, unknown> | null;
        if (!be || typeof be.provider !== "string" || !providers[be.provider]) throw new ConfigError(`model ${name}, backend ${i + 1}: unknown provider`);
        if (typeof be.model !== "string" || !UPSTREAM_MODEL_RE.test(be.model)) throw new ConfigError(`model ${name}, backend ${i + 1}: bad model id`);
        return Object.freeze({ provider: be.provider, model: be.model });
      })
    );
  }

  if (!isPositiveInt(c.perAgentDailyTokenCap)) throw new ConfigError("perAgentDailyTokenCap must be a positive whole number");
  if (!isPositiveInt(c.maxOutputTokens)) throw new ConfigError("maxOutputTokens must be a positive whole number");
  if (!isPositiveInt(c.upstreamTimeoutMs) || (c.upstreamTimeoutMs as number) > 300_000) throw new ConfigError("upstreamTimeoutMs must be 1..300000");

  return Object.freeze({
    host,
    port: port as number,
    agents: Object.freeze((c.agents as string[]).slice()),
    providers: Object.freeze(providers),
    models: Object.freeze(models),
    perAgentDailyTokenCap: c.perAgentDailyTokenCap as number,
    maxOutputTokens: c.maxOutputTokens as number,
    upstreamTimeoutMs: c.upstreamTimeoutMs as number,
  });
}

export function loadControlPlaneConfig(file: string = CONTROL_PLANE_CONFIG): ControlPlaneConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    throw new ConfigError(`no config at ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("not valid JSON");
  }
  return parseControlPlaneConfig(raw);
}
