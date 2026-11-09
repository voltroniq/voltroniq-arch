// Tests for impactAnalysis. Each test builds a small call graph in the
// DB, then verifies that BFS finds exactly the right direct and transitive
// callers. Order-independent because beforeEach wipes state.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  openDb,
  clearDb,
  insertFile,
  insertSymbol,
  insertEdge,
  type DB,
} from "./storage.js"
import { impactAnalysis } from "./impact.js"

let tmpDir: string
let db: DB
let fileId: number

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "varch-impact-"))
  db = openDb(join(tmpDir, "test.sqlite"))
})

afterAll(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// Shared fixture setup: one file, insert symbols as needed, then edges.
// Each test calls `setup()` to reset to a clean state, then builds its graph.
function setup() {
  clearDb(db)
  fileId = insertFile(db, "/fake/graph.ts", "typescript")
}

function sym(name: string): number {
  return insertSymbol(db, fileId, name, "function", 1)
}

describe("impactAnalysis", () => {
  beforeEach(() => setup())

  it("returns 0 definitions for a nonexistent symbol", () => {
    sym("existing") // unrelated
    const r = impactAnalysis(db, "missing")
    expect(r.definitionsFound).toBe(0)
    expect(r.direct).toEqual([])
    expect(r.transitive).toEqual([])
  })

  it("finds direct callers of a leaf function", () => {
    const leaf = sym("leaf")
    const middle = sym("middle")
    insertEdge(db, middle, "leaf", leaf, 5, "likely")

    const r = impactAnalysis(db, "leaf")
    expect(r.definitionsFound).toBe(1)
    expect(r.direct.length).toBe(1)
    expect(r.direct[0]!.source_name).toBe("middle")
    expect(r.transitive).toEqual([])
  })

  it("finds transitive callers up to depth 2", () => {
    // Chain: top → middle → leaf
    const leaf = sym("leaf")
    const middle = sym("middle")
    const top = sym("top")
    insertEdge(db, middle, "leaf", leaf, 5, "likely")
    insertEdge(db, top, "middle", middle, 3, "likely")

    const r = impactAnalysis(db, "leaf", 3)
    expect(r.direct.map((d) => d.source_name)).toEqual(["middle"])
    expect(r.transitive.length).toBe(1)
    expect(r.transitive[0]!.source_name).toBe("top")
    expect(r.transitive[0]!.depth).toBe(2)
    expect(r.transitive[0]!.via).toBe("middle")
  })

  it("respects the depth limit and reports truncation", () => {
    // Chain of 4: d → c → b → a → target. depth 2 should stop after a, b.
    const target = sym("target")
    const a = sym("a")
    const b = sym("b")
    const c = sym("c")
    insertEdge(db, a, "target", target, 1, "likely")
    insertEdge(db, b, "a", a, 1, "likely")
    insertEdge(db, c, "b", b, 1, "likely")

    const r = impactAnalysis(db, "target", 2)
    expect(r.direct.map((d) => d.source_name)).toEqual(["a"])
    expect(r.transitive.map((t) => t.source_name)).toEqual(["b"])
    expect(r.truncated).toBe(true) // c exists at depth 3, but we stopped
  })

  it("does not loop on self-recursive functions", () => {
    const walk = sym("walk")
    insertEdge(db, walk, "walk", walk, 10, "likely") // walk → walk

    const r = impactAnalysis(db, "walk")
    expect(r.selfRecursive).toBe(true)
    expect(r.direct).toEqual([]) // self-edge filtered out of direct
    expect(r.transitive).toEqual([]) // cycle detection prevents infinite loop
  })

  it("does not loop on mutual recursion", () => {
    // a → b → a. Impact("a") should find b as direct, and NOT find a again.
    const a = sym("a")
    const b = sym("b")
    insertEdge(db, a, "b", b, 1, "likely")
    insertEdge(db, b, "a", a, 1, "likely")

    const r = impactAnalysis(db, "a")
    expect(r.direct.map((d) => d.source_name)).toEqual(["b"])
    // transitive should NOT include "a" — the target is seeded in visited
    expect(r.transitive.map((t) => t.source_name)).not.toContain("a")
  })

  it("deduplicates diamond-shaped graphs", () => {
    // Diamond: d is called by b and c, both called by a.
    // Impact("d") → direct=[b, c], transitive should include `a` ONCE
    // (not twice, once via b and once via c).
    const d = sym("d")
    const b = sym("b")
    const c = sym("c")
    const a = sym("a")
    insertEdge(db, b, "d", d, 1, "likely")
    insertEdge(db, c, "d", d, 1, "likely")
    insertEdge(db, a, "b", b, 1, "likely")
    insertEdge(db, a, "c", c, 1, "likely")

    const r = impactAnalysis(db, "d")
    expect(r.direct.length).toBe(2)
    const transitiveNames = r.transitive.map((t) => t.source_name)
    expect(transitiveNames).toEqual(["a"]) // exactly once
  })

  it("counts duplicate definitions of the target name", () => {
    // Two symbols both named "openDb" → definitionsFound should be 2.
    sym("openDb")
    sym("openDb") // duplicate name, different row

    const r = impactAnalysis(db, "openDb")
    expect(r.definitionsFound).toBe(2)
  })

  it("distinguishes exact callers of same-named symbols", () => {
    // Setup: Two files, each with a `save` method and a caller.
    const f1 = insertFile(db, "/fake/a.ts", "typescript")
    const saveA = insertSymbol(db, f1, "save", "method", 1)
    const callerA = insertSymbol(db, f1, "callerA", "function", 5)
    
    const f2 = insertFile(db, "/fake/b.ts", "typescript")
    const saveB = insertSymbol(db, f2, "save", "method", 1)
    const callerB = insertSymbol(db, f2, "callerB", "function", 5)

    // Make exact edges for both
    insertEdge(db, callerA, "save", saveA, 6, "exact")
    insertEdge(db, callerB, "save", saveB, 6, "exact")

    // Impact on saveA specifically should ONLY return callerA
    const r = impactAnalysis(db, "save", 3, saveA)
    expect(r.direct.length).toBe(1)
    expect(r.direct[0]!.source_name).toBe("callerA")
  })
})