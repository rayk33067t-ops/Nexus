// Shared test helpers. Each test file sets NEXUS_STATE_DIR (and friends)
// before requiring this, so these modules load against that test's state.

export const PASS = "correct horse battery";

const passphrase = () => require("../src/genesis/warden/passphrase");
const wardenFounder = () => require("../src/genesis/warden/founder");
const credentials = () => require("../src/genesis/authority/credentials");

/** Make sure a Founder passphrase exists (the first one needs no old one). */
export function founder(): void {
  if (!passphrase().hasPassphrase()) passphrase().setPassphrase(PASS);
}

/** Issue an agent a credential with the Founder passphrase; return its signer. */
export function issue(agent: string, days?: number) {
  founder();
  wardenFounder().issueCredential(agent, PASS, days);
  return credentials().loadAgentSigner(agent);
}

/**
 * Get a real one-time grant for a build, the same way ScaffoldEngine does:
 * a signed request through coreGuard. The rules file in force must allow it.
 */
export function grantFor(signer: any, basePath: string, snap: any) {
  const { coreGuard } = require("../src/genesis/guards/coreGuard");
  const { planDigest } = require("../src/genesis/scaffold");
  const body = { action: "fs.write", target: `project:${snap.project}`, digest: planDigest(basePath, snap) };
  let d = coreGuard(signer.sign(body));
  if (d.pending) {
    // e.g. NEXUS is in lockdown: the Founder approves this exact plan, as they would by hand
    require("../src/genesis/authority/founder").approve(d.requestId, PASS);
    d = coreGuard(signer.sign(body));
  }
  if (!d.allowed || !d.grant) throw new Error(`test setup: the guard refused the build: ${d.reason}`);
  return d.grant;
}
