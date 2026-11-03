// Manages the daemon state files: .archeologist/port and .archeologist/pid.
// These allow external tools (and our own `stop`/`status` commands) to
// find and control the daemon without having to parse its stdout.
//
// Lifecycle:
//   - Files written on daemon startup (after server binds to a port)
//   - Files deleted on clean shutdown (SIGINT, SIGTERM)
//   - Files may remain after a crash — probeDaemon() detects this
//   - varch stop verifies before killing, to avoid PID reuse attacks

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"

export const STATE_DIR = ".archeologist"
const PORT_FILE = join(STATE_DIR, "port")
const PID_FILE = join(STATE_DIR, "pid")

export function writePortFile(port: number): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PORT_FILE, String(port), "utf8")
}

export function writePidFile(pid: number): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PID_FILE, String(pid), "utf8")
}

export function readPortFile(): number | null {
  if (!existsSync(PORT_FILE)) return null
  try {
    const raw = readFileSync(PORT_FILE, "utf8").trim()
    const port = Number(raw)
    // Sanity check: reject garbage values from stale or corrupted files
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return port
  } catch {
    return null
  }
}

export function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim()
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) return null
    return pid
  } catch {
    return null
  }
}

export function cleanupDaemonFiles(): void {
  // Best-effort cleanup. If a file is already gone or permissions block
  // us, there's nothing actionable — just move on.
  try {
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE)
  } catch {}
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
  } catch {}
}

/**
 * Check if a daemon is running by probing /health on the port file.
 * If the port file exists but the daemon isn't responding (crash leftover),
 * cleans up the stale files and returns null.
 *
 * Returns { port } if a live daemon responds, null otherwise.
 */
export async function probeDaemon(): Promise<{ port: number } | null> {
  const port = readPortFile()
  if (port === null) return null

  try {
    // 1-second timeout in case something is listening but hung.
    // ECONNREFUSED (port closed) fails immediately, so the timeout
    // only matters for genuinely stuck processes.
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return null
    return { port }
  } catch {
    // Connection refused / timeout / DNS error. The daemon that wrote
    // this port file is gone. Clean up its leftovers.
    cleanupDaemonFiles()
    return null
  }
}

/**
 * Check if a process ID is currently running.
 * Sends signal 0 (which does nothing) — if it throws, the process
 * doesn't exist or we don't have permission to signal it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}