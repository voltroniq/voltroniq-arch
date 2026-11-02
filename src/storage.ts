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

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The calling symbol. Always resolved (we know the caller by construction).
  source_symbol_id INTEGER NOT NULL,
  -- The called symbol. Nullable: we might know the name but not the definition.
  target_symbol_id INTEGER,
  -- Raw name of the callee. Always present, even when target_symbol_id is null.
  target_symbol_name TEXT NOT NULL,
  -- How confident we are in the resolution:
  --   'exact'     — resolved to a unique symbol via import/scope (future work)
  --   'likely'    — target name matched exactly one symbol in the index
  --   'heuristic' — target name matched multiple symbols (ambiguous)
  --   'unknown'   — target could not be resolved at all
  confidence TEXT NOT NULL CHECK(confidence IN ('exact','likely','heuristic','unknown')),
  FOREIGN KEY(source_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
  FOREIGN KEY(target_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_symbol_id);
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

/**
 * Wipe the entire index. Used at the start of a fresh scan.
 * Order matters: symbol_fts has no FK cascade, so we clear it first.
 * Then `files` cascades to `symbols` automatically.
 */
export function clearDb(db: DB): void {
  db.exec(`
    DELETE FROM edges;
    DELETE FROM symbol_fts;
    DELETE FROM files;
  `)
}

export interface SearchResult {
  id: number
  name: string
  kind: string
  line: number
  path: string
}

/**
 * Search indexed symbols by name. Uses FTS5 trigram for 3+ char queries,
 * falls back to LIKE for shorter queries and on FTS5 query syntax errors.
 */
export function searchSymbols(
  db: DB,
  query: string,
  limit = 20
): SearchResult[] {
  const trimmed = query.trim()
  if (trimmed.length < 3) {
    return searchLike(db, trimmed, limit)
  }

  // Wrap in double quotes so FTS5 treats it as a phrase — otherwise
  // characters like "-", "&", ":" would be interpreted as query operators.
  // Doubling embedded quotes escapes them per FTS5 syntax.
  const ftsQuery = `"${trimmed.replace(/"/g, '""')}"`

  try {
    return db.prepare(`
      SELECT s.id, s.name, s.kind, s.line, f.path
      FROM symbol_fts
      JOIN symbols s ON s.id = symbol_fts.rowid
      JOIN files f ON f.id = s.file_id
      WHERE symbol_fts MATCH ?
      ORDER BY s.name
      LIMIT ?
    `).all(ftsQuery, limit) as SearchResult[]
  } catch {
    // FTS5 syntax errors, corrupted index, etc. — fall back gracefully.
    return searchLike(db, trimmed, limit)
  }
}

function searchLike(db: DB, query: string, limit: number): SearchResult[] {
  return db.prepare(`
    SELECT s.id, s.name, s.kind, s.line, f.path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.name LIKE ?
    ORDER BY s.name
    LIMIT ?
  `).all(`%${query}%`, limit) as SearchResult[]
}