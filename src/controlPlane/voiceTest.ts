import fs from "fs";
import os from "os";
import path from "path";
import { assertProductionPaths } from "../genesis/authority/store";
assertProductionPaths("control-plane");

import { loadControlPlaneConfig } from "./config";
import { loadAgentSigner } from "../genesis/authority/credentials";
import { askVoice, loadVoiceConfig } from "../genesis/providers/voiceGateway";

async function main(): Promise<void> {
  const config = loadControlPlaneConfig();
  const voice = loadVoiceConfig(config.agents);
  const signer = loadAgentSigner("genesis");
  const line = await askVoice(
    signer,
    { voice: "nexus-amy", text: "Hello Kevin. This is Genesis, speaking through the NEXUS Control Plane.", language: "en-US" },
    { config: voice }
  );
  const out = path.join(os.homedir(), "storage", "downloads", "genesis-voice-test.wav");
  fs.writeFileSync(out, line.audio);
  console.log(`Spoken: ${line.chars} characters, ${line.audio.length} bytes -> ${out}`);
}

main().catch((err: unknown) => {
  const e = err as { code?: string; message?: string; requestId?: string };
  console.error(`${e.code ?? "ERROR"}: ${e.message ?? String(err)}${e.requestId ? `  (request ${e.requestId})` : ""}`);
  process.exitCode = 1;
});
