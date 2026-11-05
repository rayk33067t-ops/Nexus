import { randomUUID } from "crypto";
export function createDecision(db: any, memory_id: string, rationale: string, decided_by: string, conflicts_with?: string[]) {
  const id = randomUUID(); const decided_at = Math.floor(Date.now()/1000);
  db.prepare(`INSERT INTO decisions (id, memory_id, conflicts_with, status, rationale, decided_by, decided_at) VALUES (?,?,?,?,?,?,?)`).run(id, memory_id, JSON.stringify(conflicts_with||[]), "accepted", rationale, decided_by, decided_at);
  return {id, decided_at};
}
