// Tests for the storage layer. Each test runs against an isolated
// SQLite file in a temp directory, so tests never touch the real
// .archeologist/db.sqlite and can run in parallel without colliding.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  openDb,
  insertFile,
  insertSymbol,
  searchSymbols,
  clearDb,
  type DB,
} from "./storage.js"

// Shared across all tests. Set up in beforeAll, torn down in afterAll.
let tmpDir: string
let db: DB

beforeAll(() => {
  // mkdtempSync creates a unique directory under the OS temp folder,
  // e.g. /tmp/varch-test-AbCdEf. Unique per run means two `npm test`
  // invocations at the same time don't collide.
  tmpDir = mkdtempSync(join(tmpdir(), "varch-test-"))
  db = openDb(join(tmpDir, "test.sqlite"))
})

afterAll(() => {
  // Close the DB before deleting the file. On Windows (and WSL), deleting
  // an open SQLite file can fail with EBUSY.
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("storage", () => {
  it("inserts a file and returns a stable id", () => {
    // Two inserts with the same path must return the same id.
    // This proves ON CONFLICT(path) DO UPDATE works — re-scanning
    // doesn't create duplicate file rows.
    const id1 = insertFile(db, "/fake/a.js", "javascript")
    const id2 = insertFile(db, "/fake/a.js", "javascript")
    expect(id2).toBe(id1)
  })

  it("updates the language when the same path is re-inserted", () => {
    // Edge case: someone renames .js to .ts. Path stays the same
    // (in our model), language changes. The row's id must not change
    // but the language column should.
    const id = insertFile(db, "/fake/rename.js", "javascript")
    insertFile(db, "/fake/rename.js", "typescript")

    const row = db
      .prepare("SELECT language FROM files WHERE id = ?")
      .get(id) as { language: string }
    expect(row.language).toBe("typescript")
  })

  it("inserts a symbol and finds it via FTS search", () => {
    // Full pipeline: file → symbol → FTS mirror → search.
    // We're testing the JOIN between symbol_fts and symbols.
    const fileId = insertFile(db, "/fake/search1.ts", "typescript")
    insertSymbol(db, fileId, "findMeExactly", "function", 10)

    const results = searchSymbols(db, "findMeExactly")
    expect(results.length).toBe(1)
    expect(results[0]!.name).toBe("findMeExactly")
    expect(results[0]!.kind).toBe("function")
    expect(results[0]!.line).toBe(10)
    expect(results[0]!.path).toBe("/fake/search1.ts")
  })

  it("finds partial matches via trigram tokenizer", () => {
    // "User" is a substring of "handleUserSignup". The trigram tokenizer
    // chunks identifiers into 3-char windows, so this should match even
    // though "User" isn't at the start.
    const fileId = insertFile(db, "/fake/search2.ts", "typescript")
    insertSymbol(db, fileId, "handleUserSignup", "function", 5)

    const results = searchSymbols(db, "User")
    const names = results.map((r) => r.name)
    expect(names).toContain("handleUserSignup")
  })

  it("falls back to LIKE for queries shorter than 3 chars", () => {
    // FTS5 trigram requires 3+ characters. A 2-char query must still
    // return results via the LIKE fallback path in searchSymbols.
    const fileId = insertFile(db, "/fake/search3.ts", "typescript")
    insertSymbol(db, fileId, "db", "variable", 1)

    const results = searchSymbols(db, "db")
    expect(results.length).toBe(1)
    expect(results[0]!.name).toBe("db")
  })

  it("returns empty array when nothing matches", () => {
    // Sanity check: search shouldn't throw or return garbage when there's
    // no match. It should return an empty array.
    const results = searchSymbols(db, "zzzzzzzzzz")
    expect(results.length).toBe(0)
  })

  it("clearDb wipes files, symbols, and FTS index", () => {
    // The critical invariant: after clearDb, nothing remains.
    // This is what makes `scan` idempotent — you can run it repeatedly
    // without accumulating stale rows.
    const fileId = insertFile(db, "/fake/tobecleared.ts", "typescript")
    insertSymbol(db, fileId, "doomedSymbol", "function", 1)

    // Sanity: it exists before the wipe.
    expect(searchSymbols(db, "doomedSymbol").length).toBe(1)

    clearDb(db)

    // Gone from FTS + symbols + files.
    expect(searchSymbols(db, "doomedSymbol").length).toBe(0)
    const files = db.prepare("SELECT COUNT(*) as n FROM files").get() as {
      n: number
    }
    expect(files.n).toBe(0)
  })
})