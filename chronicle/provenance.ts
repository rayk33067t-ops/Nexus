import { createHash } from "crypto";
export function verifyProvenance(content: string, source_type: string, classification: string, created_at: number, hash: string): boolean {
  const computed = createHash("sha256").update(`${content}|${source_type}|${classification}|${created_at}`).digest("hex");
  return computed === hash;
}
export function verifyChain(db: any): {valid: boolean; tampered: string[]} {
  const rows = db.prepare("SELECT id, content, source_type, classification, created_at, provenance_hash FROM memories").all();
  const tampered: string[] = [];
  for (const r of rows) { if (!verifyProvenance(r.content, r.source_type, r.classification, r.created_at, r.provenance_hash)) tampered.push(r.id); }
  return {valid: tampered.length===0, tampered};
}
