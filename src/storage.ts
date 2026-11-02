// The storage layer: everything that talks to SQLite lives here.
// Other modules (scanner, CLI) call these functions. They never touch
// `better-sqlite3` directly.

import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

// Re-export the database type.
export type DB = Database.Database

// ─────────────────────────────────────────────────────────────────────
// Schema
//
// All statements use IF NOT EXISTS so this can safely run every time
// we open the DB. A new DB gets created; an existing one is a no-op.
// ─────────────────────────────────────────────────────────────────────
const schema = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
  name,
  tokenize = 'trigram'
);
`

// ─────────────────────────────────────────────────────────────────────
// openDb
//
// Opens (or creates) the SQLite file at `path`, ensures the schema
// exists, and returns the connection.
// ─────────────────────────────────────────────────────────────────────
export function openDb(path: string): DB {
  // Create parent directory if missing. E.g. `.archeologist/` before
  // creating `.archeologist/db.sqlite`.
  mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path)

  // WAL mode: write-ahead logging. Allows readers while one writer runs.
  // Persistent, so it's set once per DB file.
  db.pragma("journal_mode = WAL")

  // Foreign keys are OFF by default in SQLite (historical reason).
  // Without this, ON DELETE CASCADE silently does nothing.
  // Per-connection pragma — must run every open.
  db.pragma("foreign_keys = ON")

  // Run the schema. IF NOT EXISTS everywhere means safe every time.
  db.exec(schema)

  return db
}

// ─────────────────────────────────────────────────────────────────────
// insertFile
//
// Inserts a file row, or updates it if the path already exists.
// Returns the row's id (inserted OR existing).
// ─────────────────────────────────────────────────────────────────────
export function insertFile(db: DB, path: string, language: string): number {
  db.prepare(`
    INSERT INTO files (path, language) VALUES (?, ?)
    ON CONFLICT(path) DO UPDATE SET language = excluded.language
  `).run(path, language)

  const row = db.prepare("SELECT id FROM files WHERE path = ?").get(path) as
    | { id: number }
    | undefined

  if (!row) {
    throw new Error(`insertFile: row vanished for path ${path}`)
  }
  return row.id
}

// ─────────────────────────────────────────────────────────────────────
// insertSymbol
//
// Inserts a symbol and mirrors its name into the FTS index.
// Returns the new symbol's id.
// ─────────────────────────────────────────────────────────────────────
export function insertSymbol(
  db: DB,
  fileId: number,
  name: string,
  kind: string,
  line: number
): number {
  const result = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, line) VALUES (?, ?, ?, ?)
  `).run(fileId, name, kind, line)

  const symbolId = Number(result.lastInsertRowid)

  // Mirror into FTS. Set `rowid` to equal `symbols.id` for the JOIN later.
  db.prepare(`
    INSERT INTO symbol_fts (rowid, name) VALUES (?, ?)
  `).run(symbolId, name)

  return symbolId
}