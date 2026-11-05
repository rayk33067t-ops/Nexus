-- NEXUS CHRONICLE v0.1 SCHEMA - Founder Kevin Albert
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  source_type TEXT CHECK(source_type IN ('founder_decision','user_interaction','agent_observation','external_research','system_event','simulation','generated_fiction')) NOT NULL,
  classification TEXT CHECK(classification IN ('fact','observation','hypothesis','belief','decision','memory','simulation','fictional_canon','unresolved_question')) NOT NULL,
  content TEXT NOT NULL, tags TEXT, reversible INTEGER DEFAULT 1, expires_at INTEGER, provenance_hash TEXT NOT NULL, previous_id TEXT REFERENCES memories(id), created_by TEXT DEFAULT 'founder'
);
CREATE TABLE IF NOT EXISTS agent_audit (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, action TEXT NOT NULL, input TEXT, output TEXT, timestamp INTEGER NOT NULL, authorized_by TEXT NOT NULL, integrity_hash TEXT NOT NULL
);
CREATE TRIGGER prevent_audit_update BEFORE UPDATE ON agent_audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER prevent_audit_delete BEFORE DELETE ON agent_audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER prevent_memory_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'append-only use forgetting'); END;
CREATE TRIGGER prevent_memory_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'append-only'); END;
