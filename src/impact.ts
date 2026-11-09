// Impact analysis: given a symbol name, find everything that depends on it.
// Answers the question "what breaks if I change X?"
//
// Uses BFS from the target symbol, traversing callers-of-callers up to a
// depth limit. Cycle detection via a `visited` set — critical because:
//   - recursive functions call themselves
//   - two functions can call each other
// Without it, BFS loops forever.

import {
  dependents,
  findSymbolsByName,
  type DB,
  type EdgeResult,
} from "./storage.js"

export interface TransitiveCaller extends EdgeResult {
  depth: number
  via: string
}

export interface ImpactResult {
  target: string
  definitionsFound: number
  direct: EdgeResult[]
  transitive: TransitiveCaller[]
  selfRecursive: boolean
  truncated: boolean
  maxDepth: number
}

export function impactAnalysis(
  db: DB,
  target: string,
  maxDepth = 3,
  targetId: number | null = null
): ImpactResult {
  const depth = Math.max(1, maxDepth)
  
  // 1. Find all symbols with this name.
  const targetMatches = findSymbolsByName(db, target)
  const definitionsFound = targetMatches.length

  // 2. Determine the set of IDs that represent our target.
  // If targetId is provided, it's just that one. Otherwise, it's all of them.
  const targetIds = new Set<number>(
    targetId ? [targetId] : targetMatches.map(t => t.id)
  )

  // 3. Find direct callers. Pass the specific targetId to dependents.
  const rawDirect = dependents(db, target, targetId)
  
  // Self-recursion compares IDs, not names (to avoid A.save vs B.save false positives)
  const selfRecursive = rawDirect.some((d) => targetIds.has(d.source_id))
  const direct = rawDirect.filter((d) => !targetIds.has(d.source_id))

  // 4. Seed the visited set with the target's IDs AND the direct callers' IDs.
  // We use ONLY IDs here to prevent the string/number mismatch bug.
  const visited = new Set<number>(targetIds)
  for (const d of direct) visited.add(d.source_id)

  const transitive: TransitiveCaller[] = []
  let frontier = direct.map((d) => ({ name: d.source_name, id: d.source_id }))
  let currentDepth = 1

  // 5. BFS Traversal
  while (frontier.length > 0 && currentDepth < depth) {
    currentDepth++
    const next: { name: string; id: number }[] = []

    for (const caller of frontier) {
      // CRITICAL: Pass caller.id so we only get callers of THIS specific function,
      // not callers of every function that happens to share its name.
      const callersOfCaller = dependents(db, caller.name, caller.id)
      
      for (const c of callersOfCaller) {
        if (visited.has(c.source_id)) continue
        visited.add(c.source_id)

        transitive.push({
          ...c,
          depth: currentDepth,
          via: caller.name,
        })
        next.push({ name: c.source_name, id: c.source_id })
      }
    }
    frontier = next
  }

  return { 
    target, 
    definitionsFound, 
    direct, 
    transitive, 
    selfRecursive, 
    truncated: frontier.length > 0, 
    maxDepth: depth 
  }
}