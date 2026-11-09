// Extracts function CALLS from a syntax tree.
// Unlike symbols.ts (which finds DEFINITIONS), this finds USAGES:
// "which function is being called, and from where?"
//
// The tricky part: a call's "caller" is the enclosing function. So we
// carry a `currentCaller` through the recursion — updated whenever we
// descend into a function/method/arrow-function definition.

import type { Tree, Node } from "web-tree-sitter"

export interface Call {
  /** Name of the enclosing function, or null if the call is at module top level. */
  caller: string | null
  /** 1-indexed line number where the caller is defined. */
  callerLine: number | null
  /** Name of the called function or method (bare name, not the object). */
  callee: string
  /** 1-indexed line number where the call appears. */
  line: number
}

/**
 * Walk the tree and return every call site found.
 * Only function-like calls are reported (`foo()`, `a.b()`); property
 * accesses without calls (`a.b` alone) are ignored.
 */
export function extractCalls(tree: Tree): Call[] {
  const out: Call[] = []
  walk(tree.rootNode, out, null, null)
  return out
}

function walk(
  node: Node, 
  out: Call[], 
  currentCaller: string | null, 
  currentCallerLine: number | null
): void {
  // Step 1: does this node START a new function scope? If so, remember
  // its name and line so children know who they belong to.
  const defined = getDefinedNameAndLine(node)
  const newCaller = defined ? defined.name : currentCaller
  const newCallerLine = defined ? defined.line : currentCallerLine

  // Step 2: if this node is a call, record it under the current caller.
  if (node.type === "call_expression") {
    const callee = getCalleeName(node)
    if (callee) {
      out.push({
        caller: newCaller,
        callerLine: newCallerLine,
        callee,
        line: node.startPosition.row + 1,
      })
    }
  }

  // Step 3: Handle constructor calls (`new Foo()`).
  // Without this, `varch impact ClassName` would miss all instantiations.
  if (node.type === "new_expression") {
    const constructorNode = node.childForFieldName("constructor")
    if (constructorNode) {
      let calleeName: string | null = null
      
      if (constructorNode.type === "identifier") {
        calleeName = constructorNode.text
      } else if (constructorNode.type === "member_expression") {
        calleeName = constructorNode.childForFieldName("property")?.text ?? null
      }

      if (calleeName) {
        out.push({
          caller: newCaller,
          callerLine: newCallerLine,
          callee: calleeName,
          line: node.startPosition.row + 1,
        })
      }
    }
  }

  // Step 4: recurse. Children inherit the new caller context.
  for (const child of node.namedChildren) {
    walk(child, out, newCaller, newCallerLine)
  }
}

/**
 * Return the name and line this node defines, if it defines a function scope.
 */
function getDefinedNameAndLine(node: Node): { name: string, line: number } | null {
  if (node.type === "function_declaration" || node.type === "method_definition") {
    const nameNode = node.childForFieldName("name")
    if (nameNode) return { name: nameNode.text, line: nameNode.startPosition.row + 1 }
  }
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value")
    if (value?.type === "arrow_function" || value?.type === "function_expression") {
      const nameNode = node.childForFieldName("name")
      if (nameNode) return { name: nameNode.text, line: nameNode.startPosition.row + 1 }
    }
  }
  // Handle `View.prototype.lookup = function() {}`
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left")
    const right = node.childForFieldName("right")
    if (right?.type === "function_expression" || right?.type === "arrow_function") {
      let nameNode = left
      if (left?.type === "member_expression") {
        nameNode = left.childForFieldName("property")
      }
      if (nameNode) return { name: nameNode.text, line: nameNode.startPosition.row + 1 }
    }
  }
  return null
}

function getCalleeName(node: Node): string | null {
  const fn = node.childForFieldName("function")
  if (!fn) return null
  if (fn.type === "identifier") return fn.text
  if (fn.type === "member_expression") {
    return fn.childForFieldName("property")?.text ?? null
  }
  return null
}