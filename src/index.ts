#!/usr/bin/env node

// CLI entry point. Parses argv and dispatches to the right command.
// All the actual logic lives in scan.ts, storage.ts, symbols.ts.

import { scanDirectory, scanInto } from "./scan.js"
import { openDb, searchSymbols } from "./storage.js"
import { startServer } from "./server.js"
import { impactAnalysis } from "./impact.js"
import { startWatcher } from "./watcher.js"

const DB_PATH = process.env.VARCH_DB ?? ".archeologist/db.sqlite"

async function main(): Promise<void> {
  const command = process.argv[2]
  const arg = process.argv[3]

  switch (command) {
    case "scan":
      await cmdScan(arg ?? ".")
      break
    case "search":
      await cmdSearch(arg)
      break
    case "impact":
      await cmdImpact(arg)
      break
    case "serve":
      await cmdServe()
      break
    default:
      printUsage()
      process.exit(1)
  }
}

async function cmdScan(root: string): Promise<void> {
  console.log(`Scanning ${root}...`)
  const result = await scanDirectory(root, DB_PATH)
  console.log(
    `Done in ${result.durationMs}ms. ` +
      `Files: ${result.filesIndexed} indexed, ${result.filesSkipped} skipped. ` +
      `Symbols: ${result.symbolsIndexed}. ` +
      `Edges: ${result.edgesIndexed}.`
  )
}

async function cmdSearch(query: string | undefined): Promise<void> {
  if (!query) {
    console.error("usage: varch search <query>")
    process.exit(1)
  }
  const db = openDb(DB_PATH)
  const results = searchSymbols(db, query)
  db.close()

  if (results.length === 0) {
    console.log(`No symbols matching "${query}".`)
    return
  }

  console.log(`${results.length} result(s) for "${query}":`)
  for (const r of results) {
    console.log(
      `${r.kind.padEnd(8)} ${r.name.padEnd(20)} ${r.path}:${r.line}`
    )
  }
}

async function cmdImpact(symbol: string | undefined): Promise<void> {
  if (!symbol) {
    console.error("usage: varch impact <symbol> [--depth N]")
    process.exit(1)
  }

  // Minimal --depth parsing. Full flag parsing (yargs/commander) is
  // overkill for one optional flag. Default depth is 3.
  const depthIdx = process.argv.indexOf("--depth")
  const maxDepth =
    depthIdx > 0 ? Number(process.argv[depthIdx + 1]) || 3 : 3

  const db = openDb(DB_PATH)
  const result = impactAnalysis(db, symbol, maxDepth)
  db.close()

  if (result.definitionsFound === 0) {
    console.log(`No symbol named "${symbol}" in the index.`)
    return
  }

  const header =
    result.definitionsFound > 1
      ? `Impact analysis for "${symbol}" (${result.definitionsFound} definitions — results may over-report)`
      : `Impact analysis for "${symbol}"`

  console.log(header)
  console.log("=".repeat(header.length))
  console.log()

  if (result.direct.length === 0 && result.transitive.length === 0) {
    console.log("No callers found.")
    if (result.selfRecursive) console.log("(Function is self-recursive — calls itself.)")
    return
  }

  if (result.direct.length > 0) {
    console.log(`Direct callers (${result.direct.length}):`)
    for (const d of result.direct) {
      console.log(
        `  ${d.source_name.padEnd(20)} ${d.source_path}:${d.call_line}  [${d.confidence}]`
      )
    }
    console.log()
  }

  if (result.transitive.length > 0) {
    console.log(
      `Transitive callers (${result.transitive.length}, up to depth ${result.maxDepth}):`
    )
    for (const t of result.transitive) {
      console.log(
        `  [d${t.depth}] ${t.source_name.padEnd(16)} ${t.source_path}:${t.call_line}  via ${t.via}  [${t.confidence}]`
      )
    }
    console.log()
  }

  if (result.selfRecursive) {
    console.log("Note: function is self-recursive (calls itself).")
  }
  if (result.truncated) {
    console.log(
      `Note: truncated at depth ${result.maxDepth} — more callers exist deeper. Use --depth N to expand.`
    )
  }
}

async function cmdServe(): Promise<void> {
  const db = openDb(DB_PATH)

  const fileCount = (
    db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }
  ).n
  if (fileCount === 0) {
    db.close()
    console.error("Index is empty. Run `varch scan .` first.")
    process.exit(1)
  }

  // Status object mutated by the watcher and read by /api/status.
  const status: {
    watcher: "starting" | "watching" | "scanning" | "stopped"
    lastScanAt: string | null
    scanCount: number
    lastDurationMs: number | null
  } = {
    watcher: "starting",
    lastScanAt: null,
    scanCount: 0,
    lastDurationMs: null,
  }

  const server = await startServer({ db, getStatus: () => status })
  console.log(`varch daemon listening on ${server.url}`)
  console.log(`  Try: curl ${server.url}/health`)
  console.log(`  Watching for file changes... (Ctrl+C to stop)`)

  const watcher = await startWatcher({
    root: ".",
    onChange: async () => {
      status.watcher = "scanning"
      const t0 = Date.now()
      try {
        const result = await scanInto(db, ".")
        status.lastScanAt = new Date().toISOString()
        status.lastDurationMs = result.durationMs
        status.scanCount++
        console.log(
          `[${status.lastScanAt}] re-scan complete in ${result.durationMs}ms ` +
            `(${result.filesIndexed} files, ${result.symbolsIndexed} symbols, ${result.edgesIndexed} edges)`
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`re-scan failed: ${msg}`)
      } finally {
        status.watcher = "watching"
        void t0
      }
    },
  })
  status.watcher = "watching"

  // Graceful shutdown. Order matters: close watcher first
  // (stop producing change events), then server, then DB.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })

  console.log("\nShutting down...")
  await watcher.close()
  await server.close()
  db.close()
  console.log("Stopped.")
}

function printUsage(): void {
  console.error(`
varch — local-first code intelligence

Usage:
  varch scan [directory]            Index a directory (default: current)
  varch search <query>              Search indexed symbols
  varch impact <symbol> [--depth N] Show what calls a symbol (default depth: 3)
  varch serve                       Start local HTTP daemon on ephemeral port
`)
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err)
  process.exit(1)
})