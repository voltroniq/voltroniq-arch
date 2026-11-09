// Tests for extractCalls. Same structure as symbols.test.ts: one parser
// in beforeAll, a helper that parses strings, assertions per behavior.

import { describe, it, expect, beforeAll } from "vitest"
import { fileURLToPath } from "node:url"
import { Language, Parser } from "web-tree-sitter"
import { extractCalls } from "./calls.js"

let parser: Parser

beforeAll(async () => {
  await Parser.init()
  const wasmPath = fileURLToPath(
    import.meta.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm")
  )
  const JS = await Language.load(wasmPath)
  parser = new Parser()
  parser.setLanguage(JS)
})

function getCalls(source: string) {
  const tree = parser.parse(source)
  if (!tree) throw new Error("parse returned null")
  return extractCalls(tree)
}

describe("extractCalls", () => {
  it("finds a simple function call inside a function", () => {
    const calls = getCalls(`
      function outer() {
        inner();
      }
    `)
    expect(calls.length).toBe(1)
    expect(calls[0]!.caller).toBe("outer")
    expect(calls[0]!.callee).toBe("inner")
  })

  it("records the caller as null for top-level calls", () => {
    const calls = getCalls(`console.log("hi")`)
    expect(calls.length).toBe(1)
    expect(calls[0]!.caller).toBeNull()
    expect(calls[0]!.callee).toBe("log")
  })

  it("finds method calls and extracts the property name", () => {
    const calls = getCalls(`
      function outer() {
        service.process();
      }
    `)
    expect(calls.length).toBe(1)
    expect(calls[0]!.callee).toBe("process")
    expect(calls[0]!.caller).toBe("outer")
  })

  it("attributes calls to the correct enclosing method", () => {
    const calls = getCalls(`
      class Foo {
        bar() { baz(); }
        qux() { zap(); }
      }
    `)
    const byCallee = Object.fromEntries(calls.map(c => [c.callee, c.caller]))
    expect(byCallee["baz"]).toBe("bar")
    expect(byCallee["zap"]).toBe("qux")
  })

  it("attributes calls inside arrow functions to the const they're assigned to", () => {
    const calls = getCalls(`
      const greet = () => { shout(); }
    `)
    expect(calls.length).toBe(1)
    expect(calls[0]!.caller).toBe("greet")
    expect(calls[0]!.callee).toBe("shout")
  })

  it("records multiple calls from the same caller", () => {
    const calls = getCalls(`
      function outer() {
        a();
        b();
        c();
      }
    `)
    expect(calls.length).toBe(3)
    expect(calls.every(c => c.caller === "outer")).toBe(true)
    expect(calls.map(c => c.callee).sort()).toEqual(["a", "b", "c"])
  })

  it("records the line number of each call", () => {
    const calls = getCalls(`function outer() {
  inner();
}`)
    expect(calls[0]!.line).toBe(2)
  })

  it("finds constructor calls via new_expression", () => {
    const calls = getCalls(`
      class Service {}
      function create() {
        return new Service()
      }
    `)
    expect(calls.length).toBe(1)
    expect(calls[0]!.callee).toBe("Service")
  })
})