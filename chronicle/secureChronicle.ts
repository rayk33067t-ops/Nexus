import { createMemory } from "./memory";
import { authorize } from "./keyAuthority";
import { auditLog } from "./audit";
export class SecureChronicle {
  constructor(private db: any, private manifest: any) {}
  write(agent_id: string, input: any) {
    const auth = authorize(agent_id, "write_own_memory" as any, this.manifest);
    if (!auth.allowed) { auditLog(this.db, agent_id, "DENIED_WRITE", input, auth.reason, "system"); throw new Error(`DENIED: ${auth.reason}`); }
    if (input.source_type==="founder_decision" && agent_id!=="founder") throw new Error("FOUNDER_ONLY");
    const result = createMemory(this.db, input);
    auditLog(this.db, agent_id, "WRITE", input, result, agent_id);
    return result;
  }
  read(agent_id: string) {
    const auth = authorize(agent_id, "read_chronicle" as any, this.manifest);
    if (!auth.allowed) throw new Error(`DENIED_READ: ${auth.reason}`);
    return this.db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT 100").all();
  }
}
