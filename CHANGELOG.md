# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-alpha development. First public release (v0.1.0) targeted once the MCP server ships.

### Added

- `scan` command: indexes a folder of JS/TS files into SQLite
- `search` command: symbol lookup via FTS5 trigram, with LIKE fallback for queries under 3 chars
- `impact` command: finds direct and transitive callers of a symbol, with `--depth N` to control traversal depth
- `serve` command: HTTP query server on an ephemeral localhost port
  - Endpoints: `GET /health`, `GET /api/search`, `GET /api/impact`, `GET /api/stats`, `GET /api/status`
  - Read-only query endpoints; Ctrl+C exits cleanly
- File watcher: `varch serve` watches the current directory and re-scans on file changes (debounced 500ms)
- `GET /api/status` endpoint: shows watcher state (`watching` / `scanning`), last scan time, scan count, last duration
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

- `varch` binary now has a shebang (`#!/usr/bin/env node`), so it runs correctly after `npm link` / `npm install -g`
- Duplicate test runs eliminated via explicit `include` in `vitest.config.ts` (compiled test files in `dist/` were also being picked up)
- Function expressions (`const x = function() {}`) are now extracted as symbols. Async variants (`async function() {}`) work too. Only arrow functions were handled before.
- File watcher auto-enables polling on WSL `/mnt/*` paths. Detection uses `resolve(root).startsWith("/mnt/")` so relative roots like `.` are resolved first. Windows-side file edits don't generate inotify events visible to WSL, so polling is required for correctness there. Native Linux/macOS paths still use inotify.

### Known limitations

- **JavaScript and TypeScript only.** Python, Go, C++, and others are planned.
- **No import-aware resolution.** `likely` means "unique name match in the index," not "verified via import graph." This is why `exact` never appears in practice yet.
- **Transitive impact confidence reflects the last hop, not the weakest link.** A transitive caller reached via a `heuristic` edge may still display as `likely`. Fix is tracked in GitHub Issues.
- **Test files (`.test.ts`, `.spec.ts`) are indexed alongside source.** No file-level include/exclude filtering yet. `impact` output will show test caller paths.
- **No incremental indexing.** `scan` clears and rebuilds the full index each run. The file watcher does the same on every save - fine for small repos (~160-250ms on 20 files), slow for large ones.
- **Anonymous arrow functions attribute calls to the outer function.** Calls inside `setTimeout(() => { deep(); })` are attributed to the enclosing function, not the arrow itself. The arrow has no name to attach calls to.
- **Dynamically created methods are invisible to static analysis.** Chalk, for example, creates hundreds of style getters via `Object.defineProperty` in loops (`styles.red`, `styles.bold`, etc.). These have no static declaration - no parser can find them. Varch reports only statically-declared symbols. Verified on chalk: 38 symbols found in `source/index.js`, matching what `grep` finds and exceeding hand-verified getter/setter extraction.
- **Real-world accuracy lower than 100%.** The fixture is deliberately clean. Expect 50-75% precision on medium repos with name-based resolution.
- **Schema changes require deleting `.archeologist/`** and re-scanning. No migration system yet.
- **No port file.** Clients must know the daemon URL from stdout. Port file lands in Lesson 4c.
- **No background/daemon mode.** `varch serve` runs in the foreground; closing the terminal stops it. Background mode lands in Lesson 4c.
- **Concurrent scan during serve.** Running `varch scan .` while `varch serve` is active (with watcher) can race with the watcher's own re-scan. Both clear and rebuild the DB. Usually works via WAL, but avoid running both at once.
- **Polling overhead on WSL /mnt paths.** ~200ms poll interval means saves trigger a re-scan in 200-700ms instead of near-instant. Higher CPU than inotify. Move project to WSL's native filesystem (`~/repos/`) to use inotify.
- **Watcher fires on non-source changes.** Editing `README.md` triggers a re-scan that does nothing useful (the scan ignores non-source files). Minor inefficiency.
- **Pinned to chokidar v3.** v4, v5, and v6 removed glob support from the `ignored` option. Our watcher relies on glob patterns (`**/node_modules/**`) to skip directories. Upgrading requires rewriting the ignore logic with `picomatch` or an `ignored` predicate. v6 (Oct 2026) also adds a new observation backend that hasn't had time to prove itself in production. Upgrade when the ignore rewrite is done and v6 has 6+ months of real-world use.

### Planned

- MCP server: query the local index from Cursor / Claude Desktop (Lesson 5)
- Port file + background/PID mode + `varch stop`/`varch status` commands (Lesson 4c)
- Import-aware resolution: promotes `likely` -> `exact` where provable via import graph (Lesson 6)
- File-level filtering: `--exclude "**/*.test.ts"` or config-file equivalent
- SCIP ingestion: consume SCIP indexes for exact resolution (Lesson 6)
- Python support (after MCP)
- Incremental scanning: only re-parse changed files instead of full rebuild
- Schema migration system (blocking for v0.1.0 public release)
- Go port of the parser (only if real users complain about performance at scale)