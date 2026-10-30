import { describe, it, expect, beforeAll } from "vitest"
import { fileURLToPath } from "node:url"
import { Language, Parser, type Tree } from "web-tree-sitter"
import { extractSymbols } from "./symbols.js"

// These are shared across all tests. beforeAll fills them once
let parser: Parser

beforeAll(async () => {
    await Parser.init()
    const wasmPath = fileURLToPath(
        import.meta.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm")
    )
    const Javascript = await Language.load(wasmPath)
    parser = new Parser()
    parser.setLanguage(Javascript)
})

// Helper: parse a string, return symbols. Cuts boilerplate from each test
function getSymbols(source: string) {
    const tree = parser.parse(source)
    if (!tree) throw new Error("parse returned null")
    return extractSymbols(tree)
}

describe("extractSymbols", () => {
  it("finds a regular function", () => {
    const symbols = getSymbols("function hello() {}")
    expect(symbols.length).toBe(1)
    expect(symbols[0].name).toBe("hello")
    expect(symbols[0].kind).toBe("function")
    expect(symbols[0].line).toBe(1)
  })

  it("finds a class", () => {
    const symbols = getSymbols("class Foo {}")
    expect(symbols.length).toBe(1)
    expect(symbols[0].name).toBe("Foo")
    expect(symbols[0].kind).toBe("class")
    expect(symbols[0].line).toBe(1)
  })

  it("finds a method inside a class", () => {
    const symbols = getSymbols("class Foo { bar() {} }")
    expect(symbols.length).toBe(2)
    expect(symbols[1].name).toBe("bar")
    expect(symbols[1].kind).toBe("method")
    expect(symbols[1].line).toBe(1)
  })

  it("finds an arrow function assigned to a const", () => {
    const symbols = getSymbols("const greet = () => {}")
    expect(symbols.length).toBe(1)
    expect(symbols[0].name).toBe("greet")
    expect(symbols[0].kind).toBe("function")
    expect(symbols[0].line).toBe(1)
  })

  it("ignores function-like text inside strings and comments", () => {
    const source = `
      const msg = "function fake() {}"
      // function alsoFake() {}
    `
    const symbols = getSymbols(source)
    expect(symbols.length).toBe(0)
  })
})