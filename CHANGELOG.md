# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-alpha development. First public release (v0.1.0) targeted once the MCP server ships.

### Added

- `varch scan` command: indexes a folder of JS/TS files into SQLite
- `varch search` command: symbol lookup via FTS5 trigram, with LIKE fallback for queries under 3 chars
- `varch impact` command: finds direct and transitive callers of a symbol, with `--depth N` to control traversal depth
- `varch serve` command: HTTP query server on an ephemeral localhost port, with a built-in file watcher
  - Endpoints: `GET /health`, `GET /api/search`, `GET /api/impact`, `GET /api/stats`, `GET /api/status`
  - File watcher re-scans the index on file changes (debounced 500ms)
  - Auto-enables polling on WSL `/mnt/*` paths for reliable change detection
  - Read-only query endpoints; clean shutdown on Ctrl+C or SIGTERM
- `varch stop` command: stops the running daemon from any terminal (verifies via `/health` before sending SIGTERM to avoid stale-PID kills)
- `varch status` command: human-readable daemon state (running/not running, watcher state, last scan time, scan count, last duration)
- Daemon state files: `.archeologist/port` and `.archeologist/pid`, written on startup and cleaned up on shutdown
- `varch serve` refuses to start if a daemon is already running in the current directory
- Accuracy measurement: `npm run accuracy` reports precision/recall on a hand-labeled fixture
- `VARCH_DB` env var: allows placing the index outside the scanned directory (useful for testing on external repos)
- Confidence tiers on edges:
  - `exact` - reserved for future import-aware resolution (not yet emitted)
  - `likely` - callee name uniquely matches one symbol in the index
  - `heuristic` - callee name matches multiple symbols (ambiguous)
  - `unknown` - callee not in the index (external call)
- Two-pass scan: symbols extracted first, then edges resolved. Enables forward-reference resolution - a caller in `file-a.ts` can resolve a callee defined in `file-z.ts` scanned later.
- Parser supports JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`) and TypeScript (`.ts`, `.tsx`) via separate grammars

### Fixed

- `varch` binary has a shebang (`#!/usr/bin/env node`), so it runs correctly after `npm link` / `npm install -g`
- Duplicate test runs eliminated via explicit `include` in `vitest.config.ts` (compiled test files in `dist/` were also being picked up)
- Function expressions (`const x = function() {}`) are now extracted as symbols. Async variants work too. Only arrow functions were handled before.
- File watcher auto-enables polling on WSL `/mnt/*` paths. Detection uses `resolve(root).startsWith("/mnt/")` so relative roots like `.` are resolved first. Windows-side file edits don't generate inotify events visible to WSL, so polling is required for correctness there. Native Linux/macOS paths still use inotify.

### Known limitations

- **JavaScript and TypeScript only.** Python, Go, C++, and others are planned.
- **No import-aware resolution.** `likely` means "unique name match in the index," not "verified via import graph." This is why `exact` never appears in practice yet.
- **Transitive impact confidence reflects the last hop, not the weakest link.** A transitive caller reached via a `heuristic` edge may still display as `likely`.
- **Test files (`.test.ts`, `.spec.ts`) are indexed alongside source.** No file-level include/exclude filtering yet. `impact` output will show test caller paths.
- **No incremental indexing.** `varch scan` clears and rebuilds the full index each run. The file watcher does the same on every save - fine for small repos (~160-250ms on 20 files), slow for large ones.
- **Anonymous arrow functions attribute calls to the outer function.** Calls inside `setTimeout(() => { deep(); })` are attributed to the enclosing function, not the arrow itself. The arrow has no name to attach calls to.
- **Dynamically created methods are invisible to static analysis.** Chalk, for example, creates hundreds of style getters via `Object.defineProperty` in loops. These have no static declaration - no parser can find them. Varch reports only statically-declared symbols.
- **Real-world accuracy lower than 100%.** The fixture is deliberately clean. Expect 50-75% precision on medium repos with name-based resolution.
- **Schema changes require deleting `.archeologist/`** and re-scanning. No migration system yet.
- **`varch serve` runs in the foreground.** Closing the terminal stops the daemon. Use `varch stop` from another terminal to stop it without closing the terminal. True background mode is deferred.
- **Concurrent scan during serve.** Running `varch scan .` while `varch serve` is active can race with the watcher's own re-scan. Both clear and rebuild the DB. Usually works via WAL, but avoid running both at once.
- **Polling overhead on WSL `/mnt/*` paths.** ~200ms poll interval means saves trigger a re-scan in 200-700ms instead of near-instant. Higher CPU than inotify. Move the project to WSL's native filesystem (`~/repos/`) to use inotify.
- **Watcher fires on non-source changes.** Editing `README.md` triggers a re-scan that does nothing useful (the scan ignores non-source files). Minor inefficiency.
- **`varch stop` PID reuse risk.** Before sending SIGTERM, `varch stop` verifies via `/health` that the daemon is actually alive. This mitigates the rare case where a stale PID was reused by an unrelated process. Low risk on modern Linux (PIDs take days to reuse).
- **Pinned to chokidar v3.** v4, v5, and v6 removed glob support from the `ignored` option. Our watcher relies on glob patterns (`**/node_modules/**`) to skip directories. Upgrading requires rewriting the ignore logic with `picomatch` or an `ignored` predicate.

### Planned

- MCP server: query the local index from Cursor / Claude Desktop
- Import-aware resolution: promotes `likely` -> `exact` where provable via import graph
- File-level filtering: `--exclude "**/*.test.ts"` or config-file equivalent
- SCIP ingestion: consume SCIP indexes for exact resolution
- Python support
- Incremental scanning: only re-parse changed files instead of full rebuild
- Background daemon mode: detach from terminal, survive terminal close
- Schema migration system (blocking for v0.1.0 public release)
- Go port of the parser (only if real users complain about performance at scale)