// Walks a directory tree and returns all source files we know how to parse.
// This module doesn't parse anything — it only finds files. Parsing lives in
// symbols.ts; storage lives in storage.ts. Each module does one thing.

import { readdirSync } from "node:fs"
import { join, extname } from "node:path"

// Directories to skip entirely. If we walk into these, we waste time and
// pollute the index with third-party code. Add more as needed.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "coverage",
  ".archeologist",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
])

// Which file extensions we know how to handle → what language name to store.
// Adding a new language later means adding one line here + one grammar file.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mjs": "javascript",
  ".cjs": "javascript",
}

/**
 * Recursively walk `root` and return every source file path (absolute or
 * relative — whatever the caller passed in, joined with subdirectory names).
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