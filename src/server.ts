// HTTP server that exposes the varch index as JSON over localhost.
// Read-only: opens a DB connection, serves queries, never writes.
//
// Endpoints:
//   GET /health                     → { ok, port, files, symbols, edges }
//   GET /api/search?q=...           → SearchResult[]
//   GET /api/impact?name=...&depth= → ImpactResult
//   GET /api/stats                  → counts for files/symbols/edges

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import {
  searchSymbols,
  type DB,
} from "./storage.js"
import { impactAnalysis } from "./impact.js"

export interface ServeOptions {
  db: DB
  // Port 0 = let the OS pick an available port. Preferred.
  port?: number
  // Default 127.0.0.1 = localhost only. Do not set to 0.0.0.0.
  host?: string
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

  // The request handler is a closure over `opts.db`. Every request
  // sees the same connection. That's safe because better-sqlite3 is
  // synchronous — a request either completes before another starts or
  // waits its turn. No race conditions on the DB handle.
  const server = createServer((req, res) => {
    try {
      handleRequest(opts.db, req, res)
    } catch (err) {
      // Last-resort catch: any error inside handler produces a 500
      // instead of crashing the daemon. If handleRequest itself is
      // broken, the daemon keeps running with degraded behavior.
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
 * Route a request to the right handler. Only GET is supported —
 * this is a read-only query API.
 */
function handleRequest(
  db: DB,
  req: IncomingMessage,
  res: ServerResponse
): void {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "method not allowed" })
  }

  // `new URL(path, base)` parses path + query. Base is required even
  // though it's unused for parsing — it lets relative paths resolve.
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const path = url.pathname

  switch (path) {
    case "/health":
      return handleHealth(db, res)
    case "/api/stats":
      return handleStats(db, res)
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
  // Confidence distribution + top-level counts. Useful for
  // dashboards and for "is my index healthy?" spot checks.
  const confidence = db
    .prepare("SELECT confidence, COUNT(*) as n FROM edges GROUP BY confidence")
    .all() as Array<{ confidence: string; n: number }>

  sendJson(res, 200, { confidence })
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
  const result = impactAnalysis(db, name, depth)
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