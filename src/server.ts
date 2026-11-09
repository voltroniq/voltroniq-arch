// HTTP server that exposes the varch index as JSON over localhost.
// Read-only: opens a DB connection, serves queries, never writes.
//
// Endpoints:
//   GET /health                     → { ok, files, symbols, edges }
//   GET /api/stats                  → confidence distribution
//   GET /api/search?q=...           → SearchResult[]
//   GET /api/impact?name=...&depth= → ImpactResult
//   GET /api/status                 → daemon status (watcher state, scan count)
//
// Lesson 4b added /api/status. The status is provided by the caller via
// an optional `getStatus` callback so this module stays agnostic about
// how the daemon tracks its own state.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { searchSymbols, type DB } from "./storage.js"
import { impactAnalysis } from "./impact.js"
import { findSymbolsByName } from "./storage.js"

/**
 * Snapshot of the daemon's current state. Populated by cmdServe,
 * read by GET /api/status. Kept in this file so the shape is shared
 * between server and index.ts.
 */
export interface ServerStatus {
  watcher: "starting" | "watching" | "scanning" | "stopped"
  lastScanAt: string | null
  scanCount: number
  lastDurationMs: number | null
}

export interface ServeOptions {
  db: DB
  // Port 0 = let the OS pick an available port. Preferred.
  port?: number
  // Default 127.0.0.1 = localhost only. Do not set to 0.0.0.0.
  host?: string
  // Optional status provider. If absent, /api/status returns a stub.
  getStatus?: () => ServerStatus
}

export interface RunningServer {
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * Start the HTTP server on the given DB. Returns once the server is
 * accepting connections. The caller is responsible for calling close()
 * on shutdown.
 */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1"
  const port = opts.port ?? 0

  // The request handler is a closure over `opts`. Every request sees
  // the same DB connection and the same getStatus callback. That's
  // safe because better-sqlite3 is synchronous — a request either
  // completes before another starts or waits its turn.
  const server = createServer((req, res) => {
    try {
      handleRequest(opts.db, opts.getStatus, req, res)
    } catch (err) {
      // Last-resort catch: any error inside handler produces a 500
      // instead of crashing the daemon.
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: msg })
    }
  })

  // Wait for the `listening` event before returning. Otherwise the
  // caller might try to curl the URL before the socket is bound.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === "string") {
    throw new Error("server.address() returned unexpected value")
  }

  return {
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

/**
 * Route a request to the right handler. Only GET is supported.
 */
function handleRequest(
  db: DB,
  getStatus: (() => ServerStatus) | undefined,
  req: IncomingMessage,
  res: ServerResponse
): void {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "method not allowed" })
  }

  // ── SECURITY FIX: DNS Rebinding Defense ──
  // Reject requests that don't originate from localhost.
  // req.socket.localPort dynamically gets the port the server is running on.
  const host = req.headers.host
  const localPort = req.socket.localPort
  const expectedHost1 = `127.0.0.1:${localPort}`
  const expectedHost2 = `localhost:${localPort}`
  
  if (host !== expectedHost1 && host !== expectedHost2) {
    return sendJson(res, 403, { error: "Forbidden: Invalid Host header" })
  }
  // ────────────────────────────────────────

  // `new URL(path, base)` parses path + query. Base is required even
  // though it's unused for parsing — it lets relative paths resolve.
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const path = url.pathname

  switch (path) {
    case "/health":
      return handleHealth(db, res)
    case "/api/stats":
      return handleStats(db, res)
    case "/api/status":
      return handleStatus(getStatus, res)
    case "/api/search":
      return handleSearch(db, url, res)
    case "/api/impact":
      return handleImpact(db, url, res)
    default:
      return sendJson(res, 404, { error: "not found", path })
  }
}

function handleHealth(db: DB, res: ServerResponse): void {
  const files = (db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }).n
  const symbols = (db.prepare("SELECT COUNT(*) as n FROM symbols").get() as { n: number }).n
  const edges = (db.prepare("SELECT COUNT(*) as n FROM edges").get() as { n: number }).n
  sendJson(res, 200, { ok: true, files, symbols, edges })
}

function handleStats(db: DB, res: ServerResponse): void {
  const confidence = db
    .prepare("SELECT confidence, COUNT(*) as n FROM edges GROUP BY confidence")
    .all() as Array<{ confidence: string; n: number }>
  sendJson(res, 200, { confidence })
}

function handleStatus(
  getStatus: (() => ServerStatus) | undefined,
  res: ServerResponse
): void {
  // If no status provider was passed, return a clear stub rather than
  // an error. This makes /api/status safe to call from tests or from
  // a bare server started without a daemon.
  if (!getStatus) {
    return sendJson(res, 200, { status: "not tracked" })
  }
  sendJson(res, 200, getStatus())
}

function handleSearch(db: DB, url: URL, res: ServerResponse): void {
  const q = url.searchParams.get("q")
  if (!q) {
    return sendJson(res, 400, { error: "missing required param: q" })
  }
  const limit = Number(url.searchParams.get("limit")) || 20
  const results = searchSymbols(db, q, limit)
  sendJson(res, 200, { query: q, count: results.length, results })
}

function handleImpact(db: DB, url: URL, res: ServerResponse): void {
  const name = url.searchParams.get("name")
  if (!name) {
    return sendJson(res, 400, { error: "missing required param: name" })
  }
  const depth = Number(url.searchParams.get("depth")) || 3
  
  // NEW: Look up the ID. If unique, pass it.
  const matches = findSymbolsByName(db, name)
  const targetId = matches.length === 1 ? matches[0]!.id : null
  
  const result = impactAnalysis(db, name, depth, targetId)
  sendJson(res, 200, result)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  })
  res.end(text)
}