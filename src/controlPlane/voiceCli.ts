import { assertProductionPaths } from "../genesis/authority/store";
assertProductionPaths("control-plane");

import { loadControlPlaneConfig } from "./config";
import { loadVoiceConfig } from "../genesis/providers/voiceGateway";
import { startControlPlaneWithVoice } from "./voiceServer";

async function main(): Promise<void> {
  const config = loadControlPlaneConfig();
  const voice = loadVoiceConfig(config.agents);
  const { port } = await startControlPlaneWithVoice({ control: { config }, voice });
  console.log(`NEXUS Control Plane + voice listening on http://${config.host}:${port} (this device only).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
