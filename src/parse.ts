import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Language, Parser } from "web-tree-sitter"

const WASM_PATH = fileURLToPath(
    import.meta.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm")
)

async function main() {
    // initializing the WASM runtime
    await Parser.init()

    // loading JS grammar
    const Javascript = await Language.load(WASM_PATH)

    // creating the parser and attaching the grammer
    const parser = new Parser()
    parser.setLanguage(Javascript)

    // reading the input
    const source = readFileSync("input.js", "utf-8")

    // parsing to syntax tree
    const tree = parser.parse(source)

    // if tree is null
    if (!tree) {
        throw new Error("Parser returned null")
    }

    // print the tree
    console.log(tree.rootNode.toString())
}

main().catch((err) => {
    console.error("Parse failed", err)
    process.exit(1)
})