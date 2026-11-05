import Database from "better-sqlite3"; import fs from "fs";
export function initChronicle(dbPath="chronicle.db") {
  const db = new Database(dbPath);
  const schema = fs.readFileSync("chronicle/schema.sql","utf-8");
  db.exec(schema);
  return db;
}
