// Watches a directory for file changes and triggers a debounced
// re-scan. Uses chokidar for cross-platform consistency.
//
// Design: we do a FULL RE-SCAN on every change (debounced).
// That's correct but slower than incremental. For small-medium
// repos (<500 files), the re-scan is 250ms-2s, which is fine.
// For larger repos, we'd need incremental — deferred.
//
// WSL /mnt/c note: inotify events from Windows-side edits don't
// reliably propagate into WSL when the project lives under /mnt/.
// When the RESOLVED (absolute) root path starts with /mnt/, we
// switch to polling mode automatically. Slower (200ms poll interval)
// but correct. Native Linux/macOS paths still use inotify.

import chokidar from "chokidar"
import { resolve } from "node:path"
import { SKIP_DIRS } from "./constants.js"

export interface WatcherOptions {
  root: string
  // Fired after debounce when files have changed. Can be async;
  // the watcher waits for it to finish before allowing another fire.
  onChange: () => Promise<void> | void
  // How long to wait after the last change event before firing.
  debounceMs?: number
}

export interface RunningWatcher {
  close: () => Promise<void>
}

// Convert the Set of directory names to chokidar glob patterns
const IGNORED = Array.from(SKIP_DIRS).map(dir => `**/${dir}/**`)

export async function startWatcher(
  opts: WatcherOptions
): Promise<RunningWatcher> {
  const debounceMs = opts.debounceMs ?? 500

  // Resolve to an absolute path FIRST. The caller may pass "." or a
  // relative path, and the WSL check below must look at where the
  // path actually points, not the string prefix. ".".startsWith("/mnt/")
  // is false even when "." resolves to /mnt/c/...
  const absoluteRoot = resolve(opts.root)

  // Auto-detect WSL /mnt/* paths. On those filesystems, inotify events
  // from Windows-side editors don't reach WSL, so chokidar sees nothing.
  // Polling checks file contents on a timer instead. Native Linux/macOS
  // paths still get inotify, which is cheaper and faster.
  const usePolling = absoluteRoot.startsWith("/mnt/")

  console.log(
    `[watcher] root=${absoluteRoot} polling=${usePolling ? "yes (WSL /mnt)" : "no (inotify)"}`
  )

  const watcher = chokidar.watch(absoluteRoot, {
    ignored: IGNORED,
    // Don't fire `add` for every file already present when watch
    // starts. We just scanned — those files are already indexed.
    ignoreInitial: true,
    // Wait for the file to stop changing before firing. Editors
    // (especially on Windows/WSL) write in multiple steps.
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    // Report errors instead of crashing.
    persistent: true,
    usePolling,
    // Poll every 200ms when polling is on. Fast enough to feel instant,
    // slow enough to not burn CPU. Only used when usePolling is true.
    interval: usePolling ? 200 : undefined,
  })

  let timer: NodeJS.Timeout | null = null
  let inProgress = false
  let pending = false

  // The debounced trigger. Multiple events within debounceMs
  // coalesce into one call to opts.onChange.
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      timer = null
      // If a scan is already running, remember that another one
      // is needed after it finishes. Prevents overlap.
      if (inProgress) {
        pending = true
        return
      }
      inProgress = true
      try {
        await opts.onChange()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`watcher re-scan failed: ${msg}`)
      } finally {
        inProgress = false
        if (pending) {
          pending = false
          schedule()
        }
      }
    }, debounceMs)
  }

  watcher.on("add", schedule)
  watcher.on("change", schedule)
  watcher.on("unlink", schedule)
  watcher.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[watcher] error: ${msg}`)
  })

  // Wait until initial scan of the watch tree completes before
  // returning. Otherwise callers might think it's ready before
  // chokidar has finished enumerating the folder.
  await new Promise<void>((resolveReady) => {
    watcher.once("ready", () => {
      console.log("[watcher] ready")
      resolveReady()
    })
  })

  return {
    close: async () => {
      if (timer) clearTimeout(timer)
      await watcher.close()
    },
  }
}