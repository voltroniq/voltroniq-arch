import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openDb, type DB } from "./storage.js"
import { scanInto } from "./scan.js"

let tmpDir: string
let db: DB

beforeEach(() => {
  // 1. Fresh directory and DB for EVERY test (isolation)
  tmpDir = mkdtempSync(join(tmpdir(), "varch-scip-test-"))
  writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
  db = openDb(join(tmpDir, ".archeologist/db.sqlite"))
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("SCIP Edge Resolution", () => {
  
  it("correctly upgrades distinct same-name method calls on separate lines", async () => {
    writeFileSync(join(tmpDir, "test1.ts"), `
class A { save() {} }
class B { save() {} }
export function run1() {
  const a = new A()
  const b = new B()
  a.save()  // Line 7
  b.save()  // Line 8
}
`)
    
    await scanInto(db, tmpDir)
    
    // Join to target symbols to check exact line mapping
    const edges = db.prepare(`
      SELECT e.line as call_line, s.line as target_line, e.confidence
      FROM edges e
      JOIN symbols s ON s.id = e.target_symbol_id
      WHERE e.target_symbol_name = 'save' AND e.target_symbol_id IS NOT NULL
      ORDER BY e.line ASC
    `).all() as any[]

    expect(edges.length).toBe(2)
    
    // Both must be exact
    expect(edges[0].confidence).toBe("exact")
    expect(edges[1].confidence).toBe("exact")

    // The call on line 7 must point to the definition on line 2 (Class A)
    expect(edges[0].call_line).toBe(7)
    expect(edges[0].target_line).toBe(2)

    // The call on line 8 must point to the definition on line 3 (Class B)
    expect(edges[1].call_line).toBe(8)
    expect(edges[1].target_line).toBe(3)
  }, 60000)

  it("fails safely when two same-name calls are on the same line", async () => {
    writeFileSync(join(tmpDir, "test2.ts"), `
class A { 
  save() {} 
  other() {}
}
class B { save() {} }
export function run2() {
  const a = new A()
  const b = new B()
  a.save(); b.save()  // Ambiguous! Line 10
  a.other()           // Control! Line 11
}
`)
    
    await scanInto(db, tmpDir)
    
    // NO JOIN. Query the raw edges table so NULL targets aren't dropped.
    const edges = db.prepare(`
      SELECT target_symbol_name AS name, line, confidence
      FROM edges
      WHERE target_symbol_name IN ('save', 'other')
      ORDER BY line
    `).all() as any[]

    // We should have 3 edges (two 'save', one 'other')
    expect(edges.length).toBe(3)

    // Line 10 has two 'save' calls. Neither can be exact.
    const line10Edges = edges.filter(e => e.line === 10)
    expect(line10Edges.length).toBe(2)
    expect(line10Edges[0].confidence).not.toBe("exact")
    expect(line10Edges[1].confidence).not.toBe("exact")

    // Line 11 has the control 'other' call. It MUST be exact to prove SCIP ran.
    const line11Edge = edges.find(e => e.line === 11)
    expect(line11Edge?.confidence).toBe("exact")
  }, 60000)

  it("handles function overloads without discarding all SCIP results", async () => {
    writeFileSync(join(tmpDir, "test3.ts"), `
function greet(name: string): string;
function greet(age: number): string;
function greet(x: any): string { return "hello"; }
export function run3() {
  greet("a");
  greet(1);
}
`)
    
    await scanInto(db, tmpDir)
    
    // We just want to prove the scan doesn't crash and drop all SCIP results.
    const edges = db.prepare(`
      SELECT confidence FROM edges WHERE target_symbol_name = 'greet'
    `).all() as any[]

    expect(edges.length).toBeGreaterThan(0)
  }, 60000)
})