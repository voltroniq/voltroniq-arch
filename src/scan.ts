// Orchestrates a full scan: walk the directory, parse each file, store
// symbols in SQLite. This is the glue between scanner, parser, and storage.
// Each of those modules is simple; the integration is where the real work is.

import { readFileSync } from "node:fs"
import { extractSymbols } from "./symbols.js"
import { extractCalls } from "./calls.js"
import { findSourceFiles, languageFor } from "./scanner.js"
import { loadParsers } from "./parser.js"
import {
  openDb,
  clearDb,
  insertFile,
  insertSymbol,
  insertEdge,
  findSymbolsByName,
  type Confidence,
} from "./storage.js"

export interface ScanResult {
  filesIndexed: number
  filesSkipped: number
  symbolsIndexed: number
  edgesIndexed: number
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
  let edgesIndexed = 0

  // fileIdByPath: pass 2 needs the fileId from pass 1, so we don't
  // re-insert or re-query. Path is unique per file, so a Map is ideal.
  const fileIdByPath = new Map<string, number>()

  const runScan = db.transaction(() => {
    // ── Pass 1: insert all files and symbols ──────────────────────────
    // After this loop, every symbol in every file exists in the DB.
    // That's the precondition for pass 2's resolution to work.
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
        fileIdByPath.set(filePath, fileId)

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

    // ── Pass 2: extract calls, resolve to symbols, insert edges ───────
    // All symbols exist now. Resolution sees the full picture — a call to
    // "openDb" in index.ts resolves correctly even though storage.ts was
    // scanned later in pass 1.
    for (const filePath of files) {
      const fileId = fileIdByPath.get(filePath)
      if (!fileId) continue  // file failed in pass 1 — skip

      try {
        const language = languageFor(filePath)
        if (!language || !(language in parsers)) continue
        const parser = parsers[language as keyof typeof parsers]

        const source = readFileSync(filePath, "utf8")
        const tree = parser.parse(source)
        if (!tree) continue

        const calls = extractCalls(tree)
        for (const call of calls) {
          // No caller name = top-level call. We have no symbol to attribute
          // the edge to, so skip. (Could synthesize a `<module>` symbol later.)
          if (!call.caller) continue

          // Caller must be a symbol in THIS file. Same name in another file
          // is a different function. Scope by fileId to avoid confusion.
          const callerMatches = findSymbolsByName(db, call.caller).filter(
            (s) => s.file_id === fileId
          )
          if (callerMatches.length === 0) continue
          const callerId = callerMatches[0]!.id

          // Callee can match 0, 1, or many symbols across the whole repo.
          const calleeMatches = findSymbolsByName(db, call.callee)
          let targetId: number | null = null
          let confidence: Confidence = "unknown"

          if (calleeMatches.length === 1) {
            targetId = calleeMatches[0]!.id
            confidence = "likely"  // unique match — but not import-verified
          } else if (calleeMatches.length > 1) {
            confidence = "heuristic"  // ambiguous — don't guess a target
          }
          // 0 matches → confidence stays "unknown", targetId stays null

          insertEdge(db, callerId, call.callee, targetId, call.line, confidence)
          edgesIndexed++
        }
      } catch (err) {
        // File was indexed in pass 1 — this is just an edge-extraction
        // failure, not a file failure. Warn, don't count as skipped.
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`  edge extraction failed for ${filePath}: ${msg}`)
      }
    }
  })

  runScan()
  db.close()

  return {
    filesIndexed,
    filesSkipped,
    symbolsIndexed,
    edgesIndexed,
    durationMs: Date.now() - startedAt,
  }
}