// Orchestrates a full scan: walk the directory, parse each file, store
// symbols in SQLite. This is the glue between scanner, parser, and storage.
// Each of those modules is simple; the integration is where the real work is.

import { readFileSync } from "node:fs"
import { extractSymbols } from "./symbols.js"
import { findSourceFiles, languageFor } from "./scanner.js"
import { loadParsers } from "./parser.js"
import {
  openDb,
  clearDb,
  insertFile,
  insertSymbol,
} from "./storage.js"

export interface ScanResult {
  filesIndexed: number
  filesSkipped: number
  symbolsIndexed: number
  durationMs: number
}

/**
 * Scan `root` and write all symbols to the DB at `dbPath`.
 * Clears the existing DB first (full rebuild, not incremental).
 */
export async function scanDirectory(
  root: string,
  dbPath: string
): Promise<ScanResult> {
  const startedAt = Date.now()

  const parsers = await loadParsers()
  const files = findSourceFiles(root)
  const db = openDb(dbPath)

  clearDb(db)

  let filesIndexed = 0
  let filesSkipped = 0
  let symbolsIndexed = 0

  // Wrap all inserts in a single transaction. Without this, SQLite commits
  // each INSERT to disk separately — ~100x slower for big scans. With it,
  // one disk write at the end. Standard practice for bulk inserts.
  const runScan = db.transaction(() => {
    for (const filePath of files) {
      try {
        const language = languageFor(filePath)
        if (!language || !(language in parsers)) {
            filesSkipped++
            continue
        }
        const parser = parsers[language as keyof typeof parsers]

        const source = readFileSync(filePath, "utf8")
        const tree = parser.parse(source)
        if (!tree) {
            filesSkipped++
            continue
        }

        const symbols = extractSymbols(tree)
        const fileId = insertFile(db, filePath, language)

        for (const sym of symbols) {
            insertSymbol(db, fileId, sym.name, sym.kind, sym.line)
            symbolsIndexed++
        }
        filesIndexed++
        } catch (err) {
        filesSkipped++
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`  skipped ${filePath}: ${msg}`)
      }
    }
  })

  runScan()
  db.close()

    return { filesIndexed, filesSkipped, symbolsIndexed, durationMs: Date.now() - startedAt }
}