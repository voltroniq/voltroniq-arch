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

/**
 * A caller discovered beyond depth 1, with the path it took to get here.
 * Extends the base EdgeResult (source_name, confidence, call_line, etc.)
 * with `depth` (how many hops from the target) and `via` (the direct
 * caller of the target that led to this one).
 */
export interface TransitiveCaller extends EdgeResult {
  depth: number
  via: string
}

export interface ImpactResult {
  /** The symbol being analyzed. */
  target: string
  /** How many symbols in the index share this name. 0 = typo, 1 = clean, 2+ = ambiguous. */
  definitionsFound: number
  /** Functions that directly call `target`. */
  direct: EdgeResult[]
  /** Functions that call a direct caller, or call a caller of a caller... */
  transitive: TransitiveCaller[]
  /** True if the target calls itself (recursive function). */
  selfRecursive: boolean
  /** True if we stopped at maxDepth with more callers possibly deeper. */
  truncated: boolean
  /** Depth limit that was used. */
  maxDepth: number
}

/**
 * Analyze the impact of changing or deleting `target`.
 *
 * @param db        Open database connection
 * @param target    Symbol name to analyze (name-based, not id-based)
 * @param maxDepth  How many hops to traverse (default 3). Values below 1
 *                  are clamped to 1. Values above 5 are slow but valid.
 */
export function impactAnalysis(
  db: DB,
  target: string,
  maxDepth = 3
): ImpactResult {
  const depth = Math.max(1, maxDepth)

  // Count how many symbols share this name. Used by the CLI to warn about
  // ambiguity before showing possibly-misleading results.
  const definitionsFound = findSymbolsByName(db, target).length

  // Direct callers. Filter out self-edges — "walk calls walk" is real but
  // telling a user "walk depends on walk" is confusing. We track it
  // separately as `selfRecursive`.
  const rawDirect = dependents(db, target)
  const selfRecursive = rawDirect.some((d) => d.source_name === target)
  const direct = rawDirect.filter((d) => d.source_name !== target)

  // BFS setup. `visited` starts with the target AND all direct callers
  // so transitive rounds don't rediscover them. This also prevents the
  // classic "diamond" bug where node C would appear twice if reached
  // via B and via A.
  const visited = new Set<string>([target])
  for (const d of direct) visited.add(d.source_name)

  const transitive: TransitiveCaller[] = []
  let frontier = direct.map((d) => d.source_name)
  let currentDepth = 1

  // BFS loop. Each iteration moves one hop further from the target.
  // Stops when either the frontier empties (fully explored) or we hit
  // the depth limit (truncated).
  while (frontier.length > 0 && currentDepth < depth) {
    currentDepth++
    const next: string[] = []

    for (const caller of frontier) {
      const callersOfCaller = dependents(db, caller)
      for (const c of callersOfCaller) {
        // Skip already-visited nodes — this is cycle detection.
        // Also skips self-recursion (function calling itself) because
        // the target was seeded into `visited`.
        if (visited.has(c.source_name)) continue
        visited.add(c.source_name)

        transitive.push({
          ...c,
          depth: currentDepth,
          via: caller,
        })
        next.push(c.source_name)
      }
    }

    frontier = next
  }

  // If the loop exited due to depth limit (not because frontier emptied),
  // there are more callers we didn't reach. Signal that honestly.
  const truncated = frontier.length > 0

  return {
    target,
    definitionsFound,
    direct,
    transitive,
    selfRecursive,
    truncated,
    maxDepth: depth,
  }
}