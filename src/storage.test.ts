// Tests for the storage layer. Each test runs against an isolated
// SQLite file in a temp directory, so tests never touch the real
// .archeologist/db.sqlite and can run in parallel without colliding.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  openDb,
  insertFile,
  insertSymbol,
  insertEdge,
  dependents,
  dependencies,
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

  // ─────────────────────────────────────────────────────────────────────
  // Edges: insert + query round-trips.
  // `beforeEach(clearDb)` makes each test independent — no shared state,
  // order doesn't matter, and a failure in one test can't poison another.
  // ─────────────────────────────────────────────────────────────────────
  describe("edges", () => {
    beforeEach(() => {
      clearDb(db)
    })

    it("inserts an edge and finds dependents of the target", () => {
      // Setup: caller "theCaller" calls "theCallee" at line 3.
      const f1 = insertFile(db, "/fake/caller.ts", "typescript")
      const callerId = insertSymbol(db, f1, "theCaller", "function", 1)

      const f2 = insertFile(db, "/fake/callee.ts", "typescript")
      const calleeId = insertSymbol(db, f2, "theCallee", "function", 1)

      insertEdge(db, callerId, "theCallee", calleeId, 3, "exact")

      // dependents("theCallee") should find theCaller.
      const results = dependents(db, "theCallee")
      expect(results.length).toBe(1)
      expect(results[0]!.source_name).toBe("theCaller")
      expect(results[0]!.source_path).toBe("/fake/caller.ts")
      expect(results[0]!.target_name).toBe("theCallee")
      expect(results[0]!.target_id).toBe(calleeId)
      expect(results[0]!.confidence).toBe("exact")
      expect(results[0]!.call_line).toBe(3)
    })

    it("inserts an edge and finds dependencies of the source", () => {
      const f = insertFile(db, "/fake/deps.ts", "typescript")
      const callerId = insertSymbol(db, f, "theDepsCaller", "function", 1)
      insertEdge(db, callerId, "theDepsCallee", null, 5, "heuristic")

      // dependencies("theDepsCaller") should find theDepsCallee.
      const results = dependencies(db, "theDepsCaller")
      expect(results.length).toBe(1)
      expect(results[0]!.target_name).toBe("theDepsCallee")
      expect(results[0]!.target_id).toBeNull()  // unresolved — no id, but name is preserved
      expect(results[0]!.confidence).toBe("heuristic")
      expect(results[0]!.call_line).toBe(5)
    })

    it("preserves unresolved edges (target_id is null, name still there)", () => {
      // Real scenario: caller calls something external, e.g. `console.log`.
      // We don't have console.log in our index. The edge should still exist.
      const f = insertFile(db, "/fake/unresolved.ts", "typescript")
      const callerId = insertSymbol(db, f, "unresolvedCaller", "function", 1)
      insertEdge(db, callerId, "someExternalLib", null, 7, "unknown")

      const results = dependents(db, "someExternalLib")
      expect(results.length).toBe(1)
      expect(results[0]!.target_id).toBeNull()
      expect(results[0]!.confidence).toBe("unknown")
    })

    it("returns multiple dependents of the same target", () => {
      // Two different callers call the same function.
      const f1 = insertFile(db, "/fake/callerA.ts", "typescript")
      const aId = insertSymbol(db, f1, "callerA", "function", 1)
      const f2 = insertFile(db, "/fake/callerB.ts", "typescript")
      const bId = insertSymbol(db, f2, "callerB", "function", 1)

      insertEdge(db, aId, "sharedTarget", null, 2, "likely")
      insertEdge(db, bId, "sharedTarget", null, 4, "likely")

      const results = dependents(db, "sharedTarget")
      expect(results.length).toBe(2)
      const sources = results.map(r => r.source_name).sort()
      expect(sources).toEqual(["callerA", "callerB"])
    })

    it("clearDb wipes edges too", () => {
      // The invariant: after clearDb, no edges remain.
      const f = insertFile(db, "/fake/toClear.ts", "typescript")
      const callerId = insertSymbol(db, f, "clearEdgeCaller", "function", 1)
      insertEdge(db, callerId, "clearEdgeCallee", null, 1, "likely")

      // Sanity: it exists before the wipe.
      expect(dependents(db, "clearEdgeCallee").length).toBe(1)

      clearDb(db)

      // Gone — this is the invariant that makes `scan` idempotent.
      expect(dependents(db, "clearEdgeCallee").length).toBe(0)
    })
  })
})