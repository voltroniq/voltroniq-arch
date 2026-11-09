// Orchestrates a full scan: walk the directory, parse each file, store
// symbols and edges in SQLite. This is the glue between scanner, parser,
// and storage. Each of those modules is simple; the integration is where
// the real work is.

import { readFileSync } from "node:fs"
import { runScipIndex } from "./scip.js"
import { extractSymbols } from "./symbols.js"
import { extractCalls } from "./calls.js"
import { findSourceFiles, languageFor } from "./scanner.js"
import { loadParsers } from "./parser.js"
import {
  openDb,
  clearDb,
  insertFile,
  type Confidence,
  type DB,
} from "./storage.js"

export interface ScanResult {
  filesIndexed: number
  filesSkipped: number
  symbolsIndexed: number
  edgesIndexed: number
  durationMs: number
}

/**
 * Scan `root` into an existing DB handle. Does NOT open or close the DB —
 * the caller owns its lifecycle. Used by the daemon, which keeps one
 * connection open for the whole process.
 *
 * Wipes the DB first (full rebuild, not incremental).
 */
export async function scanInto(db: DB, root: string): Promise<ScanResult> {
  const startedAt = Date.now()

  const parsers = await loadParsers()
  const files = findSourceFiles(root)

  console.log(`[varch] Found ${files.length} files to scan.`)
  console.log(`[varch] Wiping old database...`)
  clearDb(db)

  let filesIndexed = 0
  let filesSkipped = 0
  let symbolsIndexed = 0
  let edgesIndexed = 0

  // ── DIAGNOSTICS: Track calls we drop so we know what we're missing ──
  let droppedTopLevel = 0
  let droppedNoSymbol = 0

  // fileIdByPath: pass 2 needs the fileId from pass 1, so we don't
  // re-insert or re-query. Path is unique per file, so a Map is ideal.
  const fileIdByPath = new Map<string, number>()

  // symbolIndex: maps a symbol name to an array of its occurrences (id, file, line).
  // We store the line so that in Pass 2, we can match `ClassA.save` vs `ClassB.save`.
  const symbolIndex = new Map<string, { id: number; file_id: number; line: number }[]>()

  // allCalls: we extract calls in Pass 1 but resolve them in Pass 2, 
  // after every file has been indexed. We store `callerLine` to prevent
  // attributing calls to the wrong function if there are duplicates.
  const allCalls: { 
    callerFileId: number; 
    caller: string; 
    callerLine: number | null; 
    callee: string; 
    line: number 
  }[] = []

  // ── CRITICAL PERFORMANCE FIX ──────────────────────────────────────
  // Compile the SQL statements exactly ONCE. In SQLite, prepare() is
  // like compiling code. Doing it inside a loop over 500,000 rows
  // will freeze the process. We compile once, and just .run() them.
  const insertSymbolStmt = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, line) VALUES (?, ?, ?, ?)
  `)
  const insertFtsStmt = db.prepare(`
    INSERT INTO symbol_fts (rowid, name) VALUES (?, ?)
  `)
  const insertEdgeStmt = db.prepare(`
    INSERT INTO edges (source_symbol_id, target_symbol_id, target_symbol_name, line, confidence)
    VALUES (?, ?, ?, ?, ?)
  `)

  // Wrap the entire scan in a single transaction. This gives us a 100x
  // speedup on SQLite inserts and guarantees atomicity.
  const runScan = db.transaction(() => {
    // ── Pass 1: Extract symbols and calls ─────────────────────────────
    console.log(`[varch] Pass 1: Extracting symbols and calls...`)
    
    let count = 0
    for (const filePath of files) {
      count++
      if (count % 500 === 0) {
        console.log(`[varch]   Processed ${count}/${files.length} files...`)
      }

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

        // Extract BOTH symbols and calls while we have the tree
        const symbols = extractSymbols(tree)
        const calls = extractCalls(tree)

        // CRITICAL: Free the WASM memory immediately. If we don't do this,
        // Node.js will run out of memory on large repos (like Next.js).
        tree.delete()

        const fileId = insertFile(db, filePath, language)
        fileIdByPath.set(filePath, fileId)

        for (const sym of symbols) {
          const result = insertSymbolStmt.run(fileId, sym.name, sym.kind, sym.line)
          const symId = Number(result.lastInsertRowid)
          insertFtsStmt.run(symId, sym.name)
          
          symbolsIndexed++
          
          // Populate the in-memory cache with the line number
          const existing = symbolIndex.get(sym.name) || []
          existing.push({ id: symId, file_id: fileId, line: sym.line })
          symbolIndex.set(sym.name, existing)
        }

        // Store calls for Pass 2
        for (const call of calls) {
          if (!call.caller) {
            // We don't have a synthetic "module" symbol yet, so we skip
            // top-level calls (e.g., `app.use()` in Express).
            droppedTopLevel++
            continue
          }
          allCalls.push({
            callerFileId: fileId,
            caller: call.caller,
            callerLine: call.callerLine,
            callee: call.callee,
            line: call.line
          })
        }

        filesIndexed++
      } catch (err) {
        filesSkipped++
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[varch]   skipped ${filePath}: ${msg}`)
      }
    }

    // ── Pass 2: Resolve edges ─────────────────────────────────────────
    // All symbols exist now. We can resolve calls against the full index.
    console.log(`[varch] Pass 2: Resolving ${allCalls.length} calls into edges...`)

    for (const call of allCalls) {
      // Find the caller. We must match BOTH file_id and line number.
      // If two classes have a `save()` method on different lines, matching
      // by name alone would attribute all calls to the first one.
      const callerMatches = (symbolIndex.get(call.caller) || []).filter(
        (s) => s.file_id === call.callerFileId && s.line === call.callerLine
      )
      
      if (callerMatches.length === 0) {
        droppedNoSymbol++
        continue
      }
      
      const callerId = callerMatches[0]!.id

      // Resolve the callee by name across the whole repo.
      const calleeMatches = symbolIndex.get(call.callee) || []
      let targetId: number | null = null
      let confidence: Confidence = "unknown"

      if (calleeMatches.length === 1) {
        targetId = calleeMatches[0]!.id
        confidence = "likely"
      } else if (calleeMatches.length > 1) {
        confidence = "heuristic"
      }
      
      insertEdgeStmt.run(callerId, targetId, call.callee, call.line, confidence)
      edgesIndexed++
    }
  })

  runScan()

  // ── Pass 3: SCIP Integration (Optional but High-Value) ────────────
  // If the project has a tsconfig, SCIP will upgrade our `likely` edges 
  // to `exact` by using the TypeScript compiler.
  console.log(`[varch] Tree-sitter pass complete. Upgrading with SCIP...`)
  const scipSymbols = await runScipIndex(db, root)
  
  if (scipSymbols > 0) {
    console.log(`[varch] Applied ${scipSymbols} exact SCIP symbol IDs.`)
  }

  // Print dropped call diagnostics to help us improve coverage later.
  console.log(`[varch] Dropped calls: ${droppedTopLevel} top-level, ${droppedNoSymbol} caller-not-indexed`)

  return {
    filesIndexed,
    filesSkipped,
    symbolsIndexed,
    edgesIndexed,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Scan `root` into the DB at `dbPath`. Opens the DB, delegates to
 * scanInto(), closes the DB. Convenience wrapper for the CLI.
 *
 * `try/finally` guarantees the DB closes even if scanInto throws —
 * otherwise a failed scan would leak a DB handle and lock the file.
 */
export async function scanDirectory(
  root: string,
  dbPath: string
): Promise<ScanResult> {
  const db = openDb(dbPath)
  try {
    return await scanInto(db, root)
  } finally {
    db.close()
  }
}