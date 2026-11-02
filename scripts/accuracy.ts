// Measures precision, recall, and F1 of the tool's edge extraction against
// a hand-labeled ground truth. Run with: npm run accuracy
//
// Two perspectives on the truth set:
//   - All edges      — measures how completely the tool captures call sites
//   - Internal edges — edges where the callee is IN the index (likely/heuristic/exact)
//                      measures how accurately the tool maps YOUR codebase

import { execSync } from "node:child_process"
import { readFileSync, rmSync, existsSync } from "node:fs"
import { basename } from "node:path"
import Database from "better-sqlite3"

const FIXTURE_DIR = "testdata/accuracy"
const LABELS_PATH = "testdata/accuracy/labels.json"
const DB_PATH = ".archeologist/db.sqlite"

type Confidence = "exact" | "likely" | "heuristic" | "unknown"

interface LabeledEdge {
  callerFile: string
  caller: string
  callee: string
  confidence: Confidence
}

interface FoundEdge {
  source_file: string
  source_name: string
  target_name: string
  confidence: Confidence
}

// Edge key: (basename of caller file, caller name, callee name).
// Using basename lets us compare `/abs/path/fixture-a.ts` (DB) with
// `fixture-a.ts` (labels) without path-matching headaches.
function key(e: { callerFile: string; caller: string; callee: string }): string {
  return `${basename(e.callerFile)}::${e.caller}::${e.callee}`
}

function keyFound(e: FoundEdge): string {
  return `${basename(e.source_file)}::${e.source_name}::${e.target_name}`
}

interface Metrics {
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
}

function compute(
  truth: Set<string>,
  found: Set<string>
): Metrics {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const k of found) {
    if (truth.has(k)) tp++
    else fp++
  }
  for (const k of truth) {
    if (!found.has(k)) fn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

function fmt(n: number): string {
  return (n * 100).toFixed(1) + "%"
}

function printReport(title: string, m: Metrics, missing: string[], extra: string[]): void {
  console.log()
  console.log(`── ${title} ──`)
  console.log(`  True positives:  ${m.tp}`)
  console.log(`  False positives: ${m.fp}  (tool invented)`)
  console.log(`  False negatives: ${m.fn}  (tool missed)`)
  console.log(`  Precision: ${fmt(m.precision)}`)
  console.log(`  Recall:    ${fmt(m.recall)}`)
  console.log(`  F1:        ${fmt(m.f1)}`)

  if (missing.length > 0) {
    console.log()
    console.log(`  Missed (${missing.length}):`)
    for (const k of missing) console.log(`    - ${k}`)
  }
  if (extra.length > 0) {
    console.log()
    console.log(`  Invented (${extra.length}):`)
    for (const k of extra) console.log(`    + ${k}`)
  }
}

function main(): void {
  // ── 1. Reset and scan the fixture ──────────────────────────────────
  console.log("Scanning fixture...")
  if (existsSync(".archeologist")) rmSync(".archeologist", { recursive: true })
  execSync(`npx tsx src/index.ts scan ${FIXTURE_DIR}`, { stdio: "inherit" })

  // ── 2. Load ground truth ──────────────────────────────────────────
  const labels = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as {
    edges: LabeledEdge[]
  }
  const truthAll = new Set(labels.edges.map(key))
  const truthInternal = new Set(
    labels.edges.filter((e) => e.confidence !== "unknown").map(key)
  )

  // ── 3. Load tool output ───────────────────────────────────────────
  const db = new Database(DB_PATH)
  const foundRows = db
    .prepare(
      `SELECT f.path AS source_file, s.name AS source_name,
              e.target_symbol_name AS target_name, e.confidence
       FROM edges e
       JOIN symbols s ON s.id = e.source_symbol_id
       JOIN files f   ON f.id = s.file_id`
    )
    .all() as FoundEdge[]
  db.close()

  const foundAll = new Set(foundRows.map(keyFound))
  const foundInternal = new Set(
    foundRows
      .filter((e) => e.confidence !== "unknown")
      .map(keyFound)
  )

  // ── 4. Compute metrics ────────────────────────────────────────────
  const mAll = compute(truthAll, foundAll)
  const mInternal = compute(truthInternal, foundInternal)

  // Missing = in truth but not found. Extra = found but not in truth.
  const missingAll = [...truthAll].filter((k) => !foundAll.has(k))
  const extraAll = [...foundAll].filter((k) => !truthAll.has(k))
  const missingInternal = [...truthInternal].filter((k) => !foundInternal.has(k))
  const extraInternal = [...foundInternal].filter((k) => !truthInternal.has(k))

  // ── 5. Confidence accuracy on matched edges ───────────────────────
  // For edges where the tool found the right edge, did it also get the
  // right confidence tier?
  const truthConfByKey = new Map<string, Confidence>()
  for (const e of labels.edges) truthConfByKey.set(key(e), e.confidence)

  let confidenceMatches = 0
  let confidenceMismatches = 0
  for (const row of foundRows) {
    const k = keyFound(row)
    if (!truthAll.has(k)) continue // skip FPs
    const expected = truthConfByKey.get(k)
    if (!expected) continue
    if (expected === row.confidence) confidenceMatches++
    else confidenceMismatches++
  }

  // ── 6. Print report ───────────────────────────────────────────────
  console.log()
  console.log("=".repeat(60))
  console.log("ACCURACY REPORT")
  console.log("=".repeat(60))

  printReport("All edges (internal + external)", mAll, missingAll, extraAll)
  printReport("Internal edges only (callee is in the index)", mInternal, missingInternal, extraInternal)

  console.log()
  console.log(`── Confidence accuracy (on correctly-matched edges) ──`)
  const totalMatched = confidenceMatches + confidenceMismatches
  const confAcc = totalMatched === 0 ? 0 : confidenceMatches / totalMatched
  console.log(`  Correct tier: ${confidenceMatches}/${totalMatched} (${fmt(confAcc)})`)

  console.log()
}

main()