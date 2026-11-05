import { randomUUID } from "crypto";
import { createHash } from "crypto";
export function auditLog(db: any, agent_id: string, action: string, input: any, output: any, authorized_by: string) {
  const id = randomUUID(); const timestamp = Math.floor(Date.now()/1000);
  const integrity_hash = createHash("sha256").update(`${agent_id}|${action}|${timestamp}|${authorized_by}`).digest("hex");
  db.prepare(`INSERT INTO agent_audit (id, agent_id, action, input, output, timestamp, authorized_by, integrity_hash) VALUES (?,?,?,?,?,?,?,?)`).run(id, agent_id, action, JSON.stringify(input||null), JSON.stringify(output||null), timestamp, authorized_by, integrity_hash);
  return {id, integrity_hash};
}
