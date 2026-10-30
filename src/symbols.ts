import type { Tree, Node } from "web-tree-sitter"

export interface Symbol {
    name: string
    kind: "function" | "method" | "class"
    line: number
}

export function extractSymbols(tree: Tree): Symbol[] {
  const out: Symbol[] = []
  walk(tree.rootNode, out)
  return out
}

function walk(node: Node, out: Symbol[]): void {
  if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName("name")
      if (nameNode) {
        out.push({
          name: nameNode.text,
          kind: "function",
          line: nameNode.startPosition.row + 1,
        })
      }
  } else if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName("name")
      if (nameNode) {
        out.push({
          name: nameNode.text,
          kind: "class",
          line: nameNode.startPosition.row + 1,
        })
      }
  } else if (node.type === 'method_definition') {
      const nameNode = node.childForFieldName("name")
      if (nameNode) {
        out.push({
          name: nameNode.text,
          kind: "method",
          line: nameNode.startPosition.row + 1,
        })
      }
  } else if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name")
      const valueNode = node.childForFieldName("value")
      if (nameNode && valueNode?.type === "arrow_function") {
        out.push({
          name: nameNode.text,
          kind: "function",
          line: nameNode.startPosition.row + 1,
        })
    }
  }

  for (const child of node.namedChildren) {
    walk(child, out)
  }
}