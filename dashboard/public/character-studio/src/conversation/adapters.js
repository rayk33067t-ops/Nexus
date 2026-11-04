/**
 * Conversation interfaces — the seam between a character's avatar/voice and
 * its intelligence runtime.
 *
 * Phase 1 truth: NO intelligence runtime is reachable from the browser, so
 * every adapter reports NOT CONNECTED and returns no reply. The studio never
 * invents an answer and never makes a character speak words its intelligence
 * did not produce.
 *
 * Boundaries enforced here:
 *  - Adapters have no tools, no file access, no network calls and no
 *    authority. requestAction() always refuses: actions belong to Genesis's
 *    runtime under Key Authority, Savannah's review and the Warden — none of
 *    which the studio may call or imitate.
 *  - Genesis's adapter does not go through Orb.
 *  - Aria having a character here does not make her an operational agent.
 *
 * A future runtime plugs in by implementing `transport.ask(text)`; the
 * adapter only reports CONNECTED when a transport is attached AND its
 * handshake succeeded.
 */

export const NOT_CONNECTED = "NOT CONNECTED";
export const CONNECTED = "CONNECTED";

export class IntelligenceAdapter {
  constructor({ id, runtime, reason, boundary }) {
    this.id = id;
    this.runtime = runtime;
    this.reason = reason;
    this.boundary = boundary;
    this.transport = null;
    this.handshake = null;
  }

  status() {
    if (this.transport && this.handshake?.ok === true) {
      return { state: CONNECTED, runtime: this.runtime, detail: this.handshake.detail ?? "" };
    }
    return { state: NOT_CONNECTED, runtime: this.runtime, detail: this.reason };
  }

  /** Attach a transport (future phase). Connection is claimed only after a successful handshake. */
  async attach(transport) {
    this.transport = transport;
    try {
      const h = await transport.handshake();
      this.handshake = { ok: h?.ok === true && h?.runtime === this.runtime, detail: h?.detail };
    } catch (err) {
      this.handshake = { ok: false, detail: String(err?.message || err) };
    }
    return this.status();
  }

  /** Ask the intelligence. Returns { connected, reply|null, note }. */
  async ask(text) {
    const s = this.status();
    if (s.state !== CONNECTED) {
      return { connected: false, reply: null, note: `${NOT_CONNECTED}: ${this.reason} No reply was generated.` };
    }
    const r = await this.transport.ask(String(text));
    if (typeof r?.reply !== "string" || r.reply.length === 0) return { connected: true, reply: null, note: "Runtime returned no reply." };
    return { connected: true, reply: r.reply, note: "" };
  }

  /** Actions are never performed from the studio. */
  requestAction(action) {
    return { allowed: false, action: String(action ?? ""), reason: this.boundary };
  }
}

export function createAdapters() {
  return {
    genesis: new IntelligenceAdapter({
      id: "genesis",
      runtime: "genesis",
      reason: "No Genesis runtime endpoint exists for the browser (the dashboard server is read-only). Note: GenesisBrain.ts currently routes EVOLVE mode through Orb; independence from Orb is pending the Founder's decision and is not changed here.",
      boundary: "The studio has no authority. Genesis's real actions go through her runtime and Key Authority, never through her avatar.",
    }),
    savannah: new IntelligenceAdapter({
      id: "savannah",
      runtime: "savannah",
      reason: "SavannahBrain runs in Node (src/genesis/core/SavannahBrain.ts) and the dashboard exposes no review endpoint, so the studio cannot submit plans to her.",
      boundary: "Savannah reviews plans and can only make NEXUS stricter. The studio cannot trigger reviews, challenges or lockdowns.",
    }),
    aria: new IntelligenceAdapter({
      id: "aria",
      runtime: "aria",
      reason: "No Aria intelligence runtime exists yet, and Aria is not registered as a NEXUS agent (Warden KNOWN_AGENTS lists genesis and savannah).",
      boundary: "Aria's character does not authorize her as an operational NEXUS agent. That requires the Founder.",
    }),
  };
}
