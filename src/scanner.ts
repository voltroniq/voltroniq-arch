// src/scanner.ts
//
// Walks a directory tree and returns all source files we know how to parse.
// This module doesn't parse anything — it only finds files. Parsing lives in
// symbols.ts; storage lives in storage.ts. Each module does one thing.

import { readdirSync } from "node:fs"
import { join, extname } from "node:path"
import { SKIP_DIRS, SKIP_EXTENSIONS, LANGUAGE_BY_EXT } from "./constants.js"

/**
 * Recursively walk `root` and return every source file path.
 */
export function findSourceFiles(root: string): string[] {
  const out: string[] = []
  walk(root, out)
  return out
}

function walk(dir: string, out: string[]): void {
  let entries
  try {
    // `withFileTypes: true` gives us Dirent objects with .isFile/.isDirectory.
    // Without it, readdirSync returns just names, and we'd need statSync per entry.
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Permission denied, broken symlink, etc. Skip — one bad folder shouldn't
    // kill the whole scan.
    return
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      // Skip the blacklist, then recurse.
      if (SKIP_DIRS.has(entry.name)) continue
      walk(fullPath, out)
    } else if (entry.isFile()) {
      // Skip test files and minified bundles to reduce noise in the graph.
      if (
        entry.name.includes(".test.") || 
        entry.name.includes(".spec.") || 
        SKIP_EXTENSIONS.some(ext => entry.name.endsWith(ext))
      ) continue

      // Only include files whose extension we recognize.
      if (extname(entry.name) in LANGUAGE_BY_EXT) {
        out.push(fullPath)
      }
    }
    // Symlinks, sockets, etc. — ignored. isSymbolicLink() would catch them;
    // by default we just skip everything that isn't a plain file or dir.
  }
}

/**
 * Map a file extension to a language name. Returns undefined for unknown
 * extensions. `findSourceFiles` already filtered, but callers sometimes
 * have paths and need the language label.
 */
export function languageFor(path: string): string | undefined {
  return LANGUAGE_BY_EXT[extname(path)]
}