// CLI entry point. Parses argv and dispatches to the right command.
// All the actual logic lives in scan.ts, storage.ts, symbols.ts.

import { scanDirectory } from "./scan.js"

const DB_PATH = ".archeologist/db.sqlite"

async function main(): Promise<void> {
  const command = process.argv[2]
  const arg = process.argv[3]

  switch (command) {
    case "scan":
      await cmdScan(arg ?? ".")
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
      `Symbols: ${result.symbolsIndexed}.`
  )
}

function printUsage(): void {
  console.error(`
varch — local-first code intelligence

Usage:
  varch scan [directory]    Index a directory (default: current)
  varch search <query>      Search indexed symbols (coming next)
`)
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err)
  process.exit(1)
})