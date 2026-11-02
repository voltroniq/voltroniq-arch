// Extracts function CALLS from a syntax tree.
// Unlike symbols.ts (which finds DEFINITIONS), this finds USAGES:
// "which function is being called, and from where?"

// The tricky part: a call's "caller" is the enclosing function. So we
// carry a `currentCaller` through the recursion — updated whenever we
// descend into a function/method/arrow-function definition.

import type { Tree, Node } from "web-tree-sitter"

export interface Call {
  // Name of the enclosing function, or null if the call is at module top level.
  caller: string | null
  // Name of the called function or method (bare name, not the object).
  callee: string
  // 1-indexed line number where the call appears.
  line: number
}

/**
 * Walk the tree and return every call site found.
 * Only function-like calls are reported (`foo()`, `a.b()`); property
 * accesses without calls (`a.b` alone) are ignored.
 */
export function extractCalls(tree: Tree): Call[] {
  const out: Call[] = []
  walk(tree.rootNode, out, null)
  return out
}

function walk(node: Node, out: Call[], currentCaller: string | null): void {
  // Step 1: does this node START a new function scope? If so, remember its name so children know who they belong to.
  const definedHere = getDefinedName(node)
  const newCaller = definedHere ?? currentCaller

  // Step 2: if this node is a call, record it under the current caller.
  if (node.type === "call_expression") {
    const callee = getCalleeName(node)
    if (callee) {
      out.push({
        caller: newCaller,
        callee,
        line: node.startPosition.row + 1,
      })
    }
  }

  // Step 3: recurse. Children inherit the new caller context.
  for (const child of node.namedChildren) {
    walk(child, out, newCaller)
  }
}

/**
 * Return the name this node defines, if it defines a function scope.
 * Handles three forms:
 *   - function_declaration:  `function foo() {}`  → "foo"
 *   - method_definition:     `foo() {}` (in class) → "foo"
 *   - variable_declarator with arrow value: `const foo = () => {}` → "foo"
 * Returns null for anything else (including plain `variable_declarator`s
 * whose value is not an arrow function).
 */
function getDefinedName(node: Node): string | null {
  if (node.type === "function_declaration" || node.type === "method_definition") {
    return node.childForFieldName("name")?.text ?? null
  }
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value")
    if (value?.type === "arrow_function") {
      return node.childForFieldName("name")?.text ?? null
    }
  }
  return null
}

/**
 * Extract the callee name from a call_expression.
 *   - `foo()`      → "foo"        (identifier)
 *   - `a.b()`      → "b"          (member_expression, use property)
 *   - `a.b.c()`    → "c"          (chained member_expression, still property)
 *   - `obj[key]()` → null         (subscript — dynamic, can't resolve statically)
 * Returns null for anything we can't name statically.
 */
function getCalleeName(node: Node): string | null {
  const fn = node.childForFieldName("function")
  if (!fn) return null
  if (fn.type === "identifier") return fn.text
  if (fn.type === "member_expression") {
    return fn.childForFieldName("property")?.text ?? null
  }
  return null
}