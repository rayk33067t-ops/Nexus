export function controlledForget(db: any, memory_id: string, reversible: boolean, requested_by: string) {
  const mem = db.prepare("SELECT reversible FROM memories WHERE id=?").get(memory_id);
  if (!mem) throw new Error(`NOT_FOUND: ${memory_id}`);
  if (!reversible && mem.reversible===0) throw new Error("ALREADY_IRREVERSIBLE");
  // reversible = soft delete with tombstone, irreversible = purge with audit
  if (reversible) {
    db.prepare("UPDATE memories SET expires_at=? WHERE id=?").run(Math.floor(Date.now()/1000), memory_id);
    return {type: "reversible", memory_id};
  } else {
    db.prepare("DELETE FROM memories WHERE id=?").run(memory_id);
    return {type: "irreversible", memory_id, tombstone: true};
  }
}
