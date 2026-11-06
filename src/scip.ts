import { execSync } from "node:child_process"
import { readFileSync, existsSync, unlinkSync } from "node:fs"
import { fromBinary } from "@bufbuild/protobuf"
import { IndexSchema } from "@scip-code/scip"
import { type DB, updateSymbolScipId, upgradeEdgeToExact } from "./storage.js"

export async function runScipIndex(db: DB, root: string): Promise<number> {
  if (!existsSync(`${root}/tsconfig.json`)) {
    console.log("[varch] No tsconfig.json found. Skipping SCIP.")
    return 0
  }

  console.log("[varch] Running SCIP indexer...")
  try {
    execSync("scip-typescript index", { cwd: root, stdio: "ignore" })
  } catch {
    console.warn("[varch] SCIP indexing failed. Falling back to Tree-sitter only.")
    return 0
  }

  const scipPath = `${root}/index.scip`
  if (!existsSync(scipPath)) return 0

  const buffer = readFileSync(scipPath)
  const index = fromBinary(IndexSchema, buffer)
  
  const fileRow = db.prepare("SELECT id, path FROM files").all() as { id: number; path: string }[]
  const fileMap = new Map(fileRow.map((f) => [f.path.replace(/\\/g, "/"), f.id]))

  let updatedSymbolsCount = 0
  let upgradedEdgesCount = 0

  // ── Pass 1: Definitions ──
  for (const doc of index.documents) {
    const filePath = doc.relativePath.replace(/\\/g, "/")
    const fileId = fileMap.get(filePath)
    if (!fileId) continue

    for (const occ of doc.occurrences) {
      if (occ.symbolRoles !== 1) continue

      const symbolString = occ.symbol
      if (symbolString.startsWith("local ")) continue

      const parts = symbolString.split("/")
      const descriptor = parts[parts.length - 1]
      if (!descriptor) continue

      // Skip parameters (they end with ')' but not '().')
      if (descriptor.includes("(") && !descriptor.endsWith("().")) continue

      let name = descriptor
      if (descriptor.includes("#")) {
        name = descriptor.split("#").pop() || descriptor
      } else if (descriptor.includes("().")) {
        name = descriptor.split("().")[0]!
      }
      name = name.replace(/[.()#]/g, "")

      if (name) {
        const line = (occ as any).range[0]! + 1
        const changes = updateSymbolScipId(db, fileId, name, line, symbolString)
        updatedSymbolsCount += changes
      }
    }
  }

  // ── Pass 2: References (Edge Upgrades) ──
  for (const doc of index.documents) {
    const filePath = doc.relativePath.replace(/\\/g, "/")
    const fileId = fileMap.get(filePath)
    if (!fileId) continue

    for (const occ of doc.occurrences) {
      // If it is exactly a definition (Role 1), we skip it.
      // We want Imports (2) and Reads/Calls (8).
      if (occ.symbolRoles === 1) continue

      // Skip local variables in references too
      if (occ.symbol.startsWith("local ")) continue

      const line = (occ as any).range[0]! + 1
      const changes = upgradeEdgeToExact(db, fileId, line, occ.symbol)
      upgradedEdgesCount += changes
    }
  }

  unlinkSync(scipPath)
  console.log(`[varch] SCIP: Applied ${updatedSymbolsCount} exact symbol IDs, upgraded ${upgradedEdgesCount} edges.`)

  return updatedSymbolsCount
}