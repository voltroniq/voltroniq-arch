#!/usr/bin/env node

// CLI entry point. Parses argv and dispatches to the right command.
// All the actual logic lives in scan.ts, storage.ts, symbols.ts.

import { scanDirectory, scanInto } from "./scan.js"
import { openDb, searchSymbols } from "./storage.js"
import { impactAnalysis } from "./impact.js"
import { startServer, type ServerStatus } from "./server.js"
import { startWatcher } from "./watcher.js"
import {
  writePortFile,
  writePidFile,
  readPortFile,
  readPidFile,
  cleanupDaemonFiles,
  probeDaemon,
  isProcessAlive,
  STATE_DIR,
} from "./daemon.js"

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
    case "stop":
      await cmdStop()
      break
    case "status":
      await cmdStatus()
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
    // ONLY PRINT THE FIRST 15
    for (const d of result.direct.slice(0, 15)) {
      console.log(`  ${d.source_name.padEnd(20)} ${d.source_path}:${d.call_line}  [${d.confidence}]`)
    }
    if (result.direct.length > 15) console.log(`  ... and ${result.direct.length - 15} more.`)
    console.log()
  }

  if (result.transitive.length > 0) {
    console.log(`Transitive callers (${result.transitive.length}, up to depth ${result.maxDepth}):`)
    // ONLY PRINT THE FIRST 15
    for (const t of result.transitive.slice(0, 15)) {
      console.log(`  [d${t.depth}] ${t.source_name.padEnd(16)} ${t.source_path}:${t.call_line}  via ${t.via}  [${t.confidence}]`)
    }
    if (result.transitive.length > 15) console.log(`  ... and ${result.transitive.length - 15} more.`)
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
  // Refuse to start if a daemon is already running in this directory.
  // probeDaemon() also cleans up stale files from a previous crash.
  const existing = await probeDaemon()
  if (existing) {
    console.error(`Daemon already running on port ${existing.port}.`)
    console.error("Run `varch stop` first, or use a different directory.")
    process.exit(1)
  }

  const db = openDb(DB_PATH)

  const fileCount = (
    db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }
  ).n
  if (fileCount === 0) {
    db.close()
    console.error("Index is empty. Run `varch scan .` first.")
    process.exit(1)
  }

  const status: ServerStatus = {
    watcher: "starting",
    lastScanAt: null,
    scanCount: 0,
    lastDurationMs: null,
  }

  const server = await startServer({ db, getStatus: () => status })

  // Write state files AFTER the server is accepting connections.
  // That way, any tool that reads the port file and connects
  // immediately won't hit a "connection refused" window.
  try {
    writePortFile(server.port)
    writePidFile(process.pid)
  } catch (err) {
    // State files are how other tools find us. If we can't write them,
    // the daemon is functionally invisible. Fail loudly rather than
    // run in a degraded state.
    await server.close()
    db.close()
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Failed to write daemon state files: ${msg}`)
    process.exit(1)
  }

  console.log(`varch daemon listening on ${server.url}`)
  console.log(`  PID: ${process.pid}`)
  console.log(`  Port: ${STATE_DIR}/port`)
  console.log(`  PID:  ${STATE_DIR}/pid`)
  console.log(`  Try: curl ${server.url}/health`)
  console.log(`  Watching for file changes... (Ctrl+C or 'varch stop' to stop)`)

  const watcher = await startWatcher({
    root: ".",
    onChange: async () => {
      status.watcher = "scanning"
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
      }
    },
  })
  status.watcher = "watching"

  // Graceful shutdown on either Ctrl+C (SIGINT) or SIGTERM (from
  // `varch stop`). Both paths must clean up the daemon files.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })

  console.log("\nShutting down...")
  await watcher.close()
  await server.close()
  db.close()
  cleanupDaemonFiles()
  console.log("Stopped.")
}

async function cmdStop(): Promise<void> {
  const port = readPortFile()
  const pid = readPidFile()

  if (port === null && pid === null) {
    console.error("No daemon running in this directory.")
    process.exit(1)
  }

  // Verify the daemon is actually responding before sending signals.
  // This prevents killing a wrong process if a stale PID got reused.
  if (port !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (!res.ok) {
        cleanupDaemonFiles()
        console.log("Cleaned up stale files (daemon not responding).")
        return
      }
    } catch {
      cleanupDaemonFiles()
      console.log("Cleaned up stale files (daemon not responding).")
      return
    }
  }

  if (pid === null) {
    // Port responded but no PID file. Unusual. Cleanup only.
    cleanupDaemonFiles()
    console.log("Daemon found but no PID file. Cleaned up.")
    return
  }

  if (!isProcessAlive(pid)) {
    cleanupDaemonFiles()
    console.log(`Daemon (PID ${pid}) is not running. Cleaned up stale files.`)
    return
  }

  console.log(`Stopping daemon (PID ${pid})...`)
  try {
    process.kill(pid, "SIGTERM")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Failed to send SIGTERM: ${msg}`)
    process.exit(1)
  }

  // Poll for process exit, up to 5 seconds. 100ms interval is fine —
  // no need to busy-wait tighter.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      cleanupDaemonFiles()
      console.log("Stopped.")
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  console.error(`Daemon (PID ${pid}) did not exit within 5s.`)
  console.error(`Try: kill -9 ${pid}`)
  process.exit(1)
}

async function cmdStatus(): Promise<void> {
  const probe = await probeDaemon()
  if (!probe) {
    console.log("Daemon: not running")
    return
  }

  try {
    const res = await fetch(`http://127.0.0.1:${probe.port}/api/status`)
    if (!res.ok) {
      console.error(`Daemon responded with status ${res.status}`)
      process.exit(1)
    }
    const data = (await res.json()) as ServerStatus
    console.log(`Daemon: running on port ${probe.port}`)
    console.log(`  Watcher:    ${data.watcher}`)
    console.log(`  Last scan:  ${data.lastScanAt ?? "never"}`)
    console.log(`  Scan count: ${data.scanCount}`)
    if (data.lastDurationMs !== null) {
      console.log(`  Duration:   ${data.lastDurationMs}ms`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Failed to query daemon: ${msg}`)
    process.exit(1)
  }
}

function printUsage(): void {
  console.error(`
varch — local-first code intelligence

Usage:
  varch scan [directory]            Index a directory (default: current)
  varch search <query>              Search indexed symbols
  varch impact <symbol> [--depth N] Show what calls a symbol (default depth: 3)
  varch serve                       Start local HTTP daemon on ephemeral port
  varch stop                        Stop the running daemon
  varch status                      Show daemon status
`)
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err)
  process.exit(1)
})