// Loads the JavaScript and TypeScript grammars and returns one Parser per
// language. A Parser can only have one grammar loaded at a time, so we
// keep one per language and route files to the right one at scan time.

import { fileURLToPath } from "node:url"
import { Language, Parser } from "web-tree-sitter"

// Adjust these paths if `find` showed a different location.
const JS_WASM = fileURLToPath(
  import.meta.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm")
)
const TS_WASM = fileURLToPath(
  import.meta.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm")
)

export type ParserMap = {
  javascript: Parser
  typescript: Parser
}

export async function loadParsers(): Promise<ParserMap> {
  await Parser.init()

  // Load both grammars. Parallel is slightly faster than sequential,
  // and there's no ordering dependency between them.
  const [jsLang, tsLang] = await Promise.all([
    Language.load(JS_WASM),
    Language.load(TS_WASM),
  ])

  const jsParser = new Parser()
  jsParser.setLanguage(jsLang)

  const tsParser = new Parser()
  tsParser.setLanguage(tsLang)

  return { javascript: jsParser, typescript: tsParser }
}