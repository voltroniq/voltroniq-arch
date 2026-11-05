// MCP (Model Context Protocol) server for varch.
//
// This process is launched by an AI host (Cursor, VS Code, Claude Desktop)
// and talks JSON-RPC over stdin/stdout. It does NOT open the SQLite DB —
// it forwards every request to the running varch daemon via HTTP. That
// keeps this file small and ensures tool results are always fresh (the
// daemon's file watcher keeps the index up to date).
//
// Requires the daemon to be running:
//   cd <project> && varch serve
//
// CRITICAL: stdout is the MCP protocol channel. Never console.log() here —
// only console.error(). One stray log line corrupts the JSON-RPC stream.

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"

// ─────────────────────────────────────────────────────────────────────
// Daemon discovery
// ─────────────────────────────────────────────────────────────────────

/**
 * The project root the MCP server should talk to. MCP hosts don't
 * necessarily launch us with the project as CWD, so we read it from
 * the VARCH_ROOT env var (set in the host's MCP config). Falls back to
 * the current working directory if unset.
 */
function getProjectRoot(): string {
  return resolve(process.env.VARCH_ROOT ?? process.cwd())
}

/**
 * Read the daemon port from `<root>/.archeologist/port`. Returns null if
 * the file is missing or contains garbage — both mean "daemon not running".
 */
function readDaemonPort(root: string): number | null {
  const portFile = join(root, ".archeologist", "port")
  if (!existsSync(portFile)) return null
  const raw = readFileSync(portFile, "utf8").trim()
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

class DaemonNotRunningError extends Error {
  constructor(root: string) {
    super(
      `varch daemon is not running for ${root}. ` +
        `Start it with 'varch serve' in that directory, then retry.`,
    )
  }
}

/**
 * Call a daemon HTTP endpoint and return parsed JSON.
 * Throws DaemonNotRunningError if the port file is missing, or a plain
 * Error if the daemon responds with a non-2xx status or times out.
 */
async function callDaemon<T>(pathAndQuery: string): Promise<T> {
  const root = getProjectRoot()
  const port = readDaemonPort(root)
  if (port === null) throw new DaemonNotRunningError(root)

  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`varch daemon returned HTTP ${res.status}: ${body}`)
  }
  return (await res.json()) as T
}

// ─────────────────────────────────────────────────────────────────────
// Response shapes (mirrors the daemon's JSON)
// ─────────────────────────────────────────────────────────────────────

interface SearchResponse {
  query: string
  count: number
  results: {
    id: number
    name: string
    kind: string
    line: number
    path: string
  }[]
}

interface EdgeResult {
  source_name: string
  source_path: string
  source_line: number
  target_name: string
  target_id: number | null
  confidence: string
  call_line: number
}

interface ImpactResponse {
  target: string
  definitionsFound: number
  direct: EdgeResult[]
  transitive: (EdgeResult & { depth: number; via: string })[]
  selfRecursive: boolean
  truncated: boolean
  maxDepth: number
}

interface StatusResponse {
  watcher: string
  lastScanAt: string | null
  scanCount: number
  lastDurationMs: number | null
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

type ToolResult = {
  content: { type: "text"; text: string }[]
  isError?: true
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] }
}

/**
 * Convert any thrown error into an MCP tool result with isError: true.
 * The model sees the message and can react (e.g. tell the user to run
 * 'varch serve'). This is better than letting the error escape as a
 * protocol-level failure.
 */
function errorResult(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err)
  return { content: [{ type: "text", text: msg }], isError: true }
}

function formatImpact(r: ImpactResponse): string {
  const lines: string[] = []
  const defs =
    r.definitionsFound > 1
      ? ` (${r.definitionsFound} definitions — results may over-report)`
      : ""
  lines.push(`Impact analysis for "${r.target}"${defs}`)

  if (r.direct.length === 0 && r.transitive.length === 0) {
    lines.push("No callers found.")
  } else {
    if (r.direct.length > 0) {
      lines.push("")
      lines.push(`Direct callers (${r.direct.length} total, showing top 15):`)
      // Take the first 15
      for (const d of r.direct.slice(0, 15)) {
        lines.push(
          `  ${d.source_name} (${d.source_path}:${d.call_line}) [${d.confidence}]`,
        )
      }
      if (r.direct.length > 15) {
        lines.push(`  ... and ${r.direct.length - 15} more (ask for a specific file or use the CLI to see all).`)
      }
    }
    if (r.transitive.length > 0) {
      lines.push("")
      lines.push(
        `Transitive callers (${r.transitive.length} total, showing top 15):`,
      )
      // Take the first 15
      for (const t of r.transitive.slice(0, 15)) {
        lines.push(
          `  [d${t.depth}] ${t.source_name} via ${t.via} ` +
            `(${t.source_path}:${t.call_line}) [${t.confidence}]`,
        )
      }
      if (r.transitive.length > 15) {
        lines.push(`  ... and ${r.transitive.length - 15} more.`)
      }
    }
  }

  if (r.selfRecursive) lines.push("", "Note: function is self-recursive.")
  if (r.truncated) {
    lines.push(
      "",
      `Note: truncated at depth ${r.maxDepth} — call again with a higher depth to see more.`,
    )
  }
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────────
// Server factory
// ─────────────────────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "varch", version: "0.1.0" })

  // Tool 1: symbol search — "where is X defined?"
  server.registerTool(
    "varch_search",
    {
      description:
        "Search indexed code symbols by name in the local varch index. " +
        "Use this to find where a function, class, or method is defined. " +
        "Returns each match's kind, name, file path, and line number.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Substring to match against symbol names (e.g. 'openDb' or 'User')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum results to return (default 20)"),
      }),
    },
    async ({ query, limit }) => {
      try {
        const data = await callDaemon<SearchResponse>(
          `/api/search?q=${encodeURIComponent(query)}&limit=${limit ?? 20}`,
        )
        if (data.count === 0) {
          return text(`No symbols matching "${query}".`)
        }
        const rows = data.results.map(
          (r) => `${r.kind.padEnd(8)} ${r.name}  (${r.path}:${r.line})`,
        )
        return text(
          `${data.count} result(s) for "${query}":\n${rows.join("\n")}`,
        )
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  // Tool 2: impact analysis — "what breaks if I change X?"
  server.registerTool(
    "varch_impact",
    {
      description:
        "Find what calls a symbol in the local varch index (direct and " +
        "transitive callers). Use this before suggesting a change to a " +
        "function: it shows which code depends on it. Confidence tiers: " +
        "'likely' = unique name match, 'heuristic' = ambiguous name, " +
        "'unknown' = external call.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe("Exact symbol name to analyze (e.g. 'openDb')"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How many hops of transitive callers to traverse (default 3)"),
      }),
    },
    async ({ name, depth }) => {
      try {
        const data = await callDaemon<ImpactResponse>(
          `/api/impact?name=${encodeURIComponent(name)}&depth=${depth ?? 3}`,
        )
        if (data.definitionsFound === 0) {
          return text(`No symbol named "${name}" in the index.`)
        }
        return text(formatImpact(data))
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  // Tool 3: daemon status — "is the index fresh?"
  server.registerTool(
    "varch_status",
    {
      description:
        "Check the varch daemon's status: whether the file watcher is " +
        "active, when the index was last updated, and how many re-scans " +
        "have run. Use this to verify the index is fresh before trusting " +
        "search or impact results.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const s = await callDaemon<StatusResponse>("/api/status")
        const lines = [
          `Watcher:    ${s.watcher}`,
          `Last scan:  ${s.lastScanAt ?? "never"}`,
          `Scan count: ${s.scanCount}`,
        ]
        if (s.lastDurationMs !== null) {
          lines.push(`Duration:   ${s.lastDurationMs}ms`)
        }
        return text(lines.join("\n"))
      } catch (err) {
        return errorResult(err)
      }
    },
  )

  return server
}

// ─────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────

void serveStdio(createServer)
console.error("varch MCP server running on stdio")