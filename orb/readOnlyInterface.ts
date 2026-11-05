export class ReadOnlyInterface {
  constructor(private db: any) {}
  query(sql: string) {
    if (!sql.trim().toLowerCase().startsWith("select")) throw new Error("READ_ONLY");
    if (/insert|update|delete|drop|alter/i.test(sql)) throw new Error("READ_ONLY write denied");
    return this.db.prepare(sql).all();
  }
  getMemoryCount(): number { return this.db.prepare("SELECT COUNT(*) as c FROM memories").get().c; }
}
