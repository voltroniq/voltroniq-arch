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

  const fileIdByPath = new Map<string, number>()
  const symbolIndex = new Map<string, { id: number; file_id: number }[]>()

  // Prepare statements ONCE
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

  // Array to hold all calls in memory for Pass 2
  const allCalls: { 
    callerFileId: number; 
    caller: string; 
    callee: string; 
    line: number 
  }[] = []

  const runScan = db.transaction(() => {
    // ── Pass 1: Parse ONCE, insert symbols, store calls in memory ─────
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

        // CRITICAL: Free the WASM memory immediately
        tree.delete()

        const fileId = insertFile(db, filePath, language)
        fileIdByPath.set(filePath, fileId)

        for (const sym of symbols) {
          const result = insertSymbolStmt.run(fileId, sym.name, sym.kind, sym.line)
          const symId = Number(result.lastInsertRowid)
          insertFtsStmt.run(symId, sym.name)
          
          symbolsIndexed++
          
          const existing = symbolIndex.get(sym.name) || []
          existing.push({ id: symId, file_id: fileId })
          symbolIndex.set(sym.name, existing)
        }

        // Store calls for Pass 2
        for (const call of calls) {
          if (call.caller) {
            allCalls.push({
              callerFileId: fileId,
              caller: call.caller,
              callee: call.callee,
              line: call.line
            })
          }
        }

        filesIndexed++
      } catch (err) {
        filesSkipped++
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[varch]   skipped ${filePath}: ${msg}`)
      }
    }

    // ── Pass 2: Resolve edges in memory and insert ────────────────────
    console.log(`[varch] Pass 2: Resolving ${allCalls.length} calls into edges...`)

    for (const call of allCalls) {
      const callerMatches = (symbolIndex.get(call.caller) || []).filter(
        (s) => s.file_id === call.callerFileId
      )
      if (callerMatches.length === 0) continue
      const callerId = callerMatches[0]!.id

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

  console.log(`[varch] Tree-sitter pass complete. Upgrading with SCIP...`)
  const scipSymbols = await runScipIndex(db, root)
  if (scipSymbols > 0) {
    console.log(`[varch] Applied ${scipSymbols} exact SCIP symbol IDs.`)
  }

  return {
    filesIndexed,
    filesSkipped,
    symbolsIndexed,
    edgesIndexed,
    durationMs: Date.now() - startedAt,
  }
}

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