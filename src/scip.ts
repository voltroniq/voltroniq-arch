import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fromBinary } from "@bufbuild/protobuf"
import { IndexSchema } from "@scip-code/scip"
import { 
  type DB, 
  updateSymbolScipId, 
  upgradeEdgeToExact, 
  type UpgradeOutcome 
} from "./storage.js"

// createRequire lets us use Node's CommonJS `require` inside an ESM module.
const require = createRequire(import.meta.url)

// Promisify execFile so we can await it without blocking the event loop.
// We use execFileSync only for the `hasBinary` check (which is instantaneous).
const execFileAsync = promisify(execFile)

/**
 * Resolve the scip-typescript binary. Tries the main entry first (exports-safe),
 * then walks up to the package root if the package blocks direct resolution.
 */
function resolveScipBin(): string {
  let pkgPath: string | undefined
  
  try {
    pkgPath = require.resolve("@sourcegraph/scip-typescript/package.json")
  } catch {
    const mainEntry = require.resolve("@sourcegraph/scip-typescript")
    let dir = dirname(mainEntry)
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json")
      if (existsSync(candidate)) {
        pkgPath = candidate
        break
      }
      dir = dirname(dir)
    }
  }

  if (!pkgPath) {
    throw new Error("Could not locate scip-typescript package.json")
  }

  const pkgDir = dirname(pkgPath)
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin: string | Record<string, string>
  }
  
  const binRelPath = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0]!
  return join(pkgDir, binRelPath)
}

/**
 * Check if a binary (pnpm or yarn) is installed and available in PATH.
 */
function hasBinary(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Detect workspace mode from the repo root. Returns extra CLI flags.
 * We MUST check if pnpm/yarn actually exists, otherwise scip-typescript
 * will crash and fall back to Tree-sitter unnecessarily.
 */
function detectWorkspaceFlag(root: string): string | null {
  if (existsSync(join(root, "pnpm-workspace.yaml"))) {
    if (hasBinary("pnpm")) return "--pnpm-workspaces"
    console.warn("[varch] pnpm-workspace.yaml found, but pnpm is not installed. Proceeding without workspace mode.")
    return null
  }
  
  const pkgJsonPath = join(root, "package.json")
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { workspaces?: unknown }
      if (pkg.workspaces) {
        if (hasBinary("yarn")) return "--yarn-workspaces"
        console.warn("[varch] Workspaces found, but yarn is not installed. Proceeding without workspace mode.")
        return null
      }
    } catch { /* ignore parse errors */ }
  }
  return null
}

export async function runScipIndex(db: DB, root: string): Promise<number> {
  // 1. Resolve the bundled SCIP binary
  let scipBin: string
  try {
    scipBin = resolveScipBin()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[varch] scip-typescript unavailable (${msg}). Skipping SCIP.`)
    return 0
  }

  // 2. Read the root package.json to separate internal vs external references
  let rootPkgName = ""
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    rootPkgName = pkg.name || ""
  } catch { /* ignore */ }

  // 3. Create an isolated temp directory for the output file.
  // This ensures we NEVER overwrite a user's existing index.scip file.
  const scipTmp = mkdtempSync(join(tmpdir(), "varch-scip-"))
  const scipPath = join(scipTmp, "index.scip")

  try {
    const workspaceFlag = detectWorkspaceFlag(root)
    const args = [
      scipBin,
      "index",
      "--infer-tsconfig", // Tells SCIP to guess configs for pure JS projects
      "--no-progress-bar", // Keeps stdout clean
      "--output",
      scipPath,
    ]
    if (workspaceFlag) args.push(workspaceFlag)

    console.log("[varch] Running SCIP indexer (this can take a minute on large repos)...")
    try {
      // CRITICAL: Use execFileAsync instead of execFileSync so we don't block
      // the Node event loop. This keeps the HTTP server responsive during re-scans.
      await execFileAsync(process.execPath, args, {
        cwd: root, 
        // REMOVED: stdio: "pipe" (execFile always pipes and captures output)
        timeout: 10 * 60 * 1000, // 10-minute hard cap
        maxBuffer: 64 * 1024 * 1024, // 64MB buffer
      })
    } catch (err) {
      const e = err as { message?: string; stderr?: Buffer | string }
      // Extract just the first non-empty stderr line to avoid dumping a stack trace
      const stderrLine = e.stderr ? String(e.stderr).split("\n").find(l => l.trim().length > 0) : ""
      console.warn(
        `[varch] SCIP indexing failed.${stderrLine ? ` (${stderrLine})` : ""} Falling back to Tree-sitter only.`
      )
      return 0
    }

    if (!existsSync(scipPath)) return 0

    // 4. Read and decode the binary SCIP file
    const buffer = readFileSync(scipPath)
    const index = fromBinary(IndexSchema, buffer)

    // 5. Map file paths from the DB so we can link SCIP paths to our DB IDs
    const fileRow = db.prepare("SELECT id, path FROM files").all() as {
      id: number
      path: string
    }[]
    const fileMap = new Map(
      fileRow.map((f) => [resolve(f.path).replace(/\\/g, "/"), f.id])
    )

    let updatedSymbolsCount = 0
    
    // Funnel tally to see exactly what happens to every SCIP reference
    const outcomes: Record<UpgradeOutcome, number> = { 
      upgraded: 0, no_target: 0, no_edge: 0, ambiguous: 0 
    }
    
    // Diagnostics to figure out WHY things fail
    const noTargetInternalSamples: string[] = []
    const noTargetExternalCount = { count: 0 }
    const noEdgeSamples: string[] = []

    // 6. Wrap both passes in a single transaction.
    // If anything throws, better-sqlite3 rolls back the entire SCIP update, 
    // leaving the Tree-sitter data completely intact.
    const applyScip = db.transaction(() => {
      // ── Pass 1: Definitions ──
      for (const doc of index.documents) {
        const absolutePath = resolve(root, doc.relativePath).replace(/\\/g, "/")
        const fileId = fileMap.get(absolutePath)
        if (!fileId) continue

        for (const occ of doc.occurrences) {
          // Roles are a bitmask. 1 is Definition. 5 is Def+Write.
          if (((occ.symbolRoles ?? 0) & 1) === 0) continue

          const symbolString = occ.symbol
          if (symbolString.startsWith("local ")) continue

          const parts = symbolString.split("/")
          const descriptor = parts[parts.length - 1]
          if (!descriptor) continue
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
            updatedSymbolsCount += updateSymbolScipId(db, fileId, name, line, symbolString)
          }
        }
      }

      // ── Pass 2: References ──
      for (const doc of index.documents) {
        const absolutePath = resolve(root, doc.relativePath).replace(/\\/g, "/")
        const fileId = fileMap.get(absolutePath)
        if (!fileId) continue

        for (const occ of doc.occurrences) {
          if (((occ.symbolRoles ?? 0) & 1) !== 0) continue
          if (occ.symbol.startsWith("local ")) continue

          const line = (occ as any).range[0]! + 1
          const outcome = upgradeEdgeToExact(db, fileId, line, occ.symbol)
          outcomes[outcome]++

          // DIAGNOSTIC: Split internal vs external failures
          if (outcome === "no_target") {
            // SCIP symbol format: "scheme manager package version descriptors"
            const pkgName = occ.symbol.split(" ")[2]
            if (pkgName === rootPkgName) {
              if (noTargetInternalSamples.length < 15) {
                noTargetInternalSamples.push(`${doc.relativePath}:${line} -> ${occ.symbol}`)
              }
            } else {
              noTargetExternalCount.count++
            }
          } else if (outcome === "no_edge" && noEdgeSamples.length < 10) {
            noEdgeSamples.push(`${doc.relativePath}:${line} -> ${occ.symbol}`)
          }
        }
      }
    })

    try {
      applyScip()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[varch] SCIP results discarded (${msg}). Using Tree-sitter only.`)
      return 0
    }

    // 7. Print the final results and diagnostics
    console.log(`[varch] SCIP: Applied ${updatedSymbolsCount} exact symbol IDs.`)
    console.log(`[varch] SCIP Funnel: ${JSON.stringify(outcomes)}`)
    console.log(`[varch] Funnel Split -> Internal no_target: ${noTargetInternalSamples.length} samples shown, External no_target: ${noTargetExternalCount.count}`)
    
    if (noTargetInternalSamples.length > 0) {
      console.log(`\n--- SAMPLES: Internal no_target (Parser missed these?) ---`)
      noTargetInternalSamples.forEach(s => console.log(`  ${s}`))
    }
    
    if (noEdgeSamples.length > 0) {
       console.log(`\n--- SAMPLES: no_edge (Tree-sitter missed the call?) ---`)
       noEdgeSamples.forEach(s => console.log(`  ${s}`))
    }

    return updatedSymbolsCount
  } finally {
    // Always clean up the temp directory
    rmSync(scipTmp, { recursive: true, force: true })
  }
}