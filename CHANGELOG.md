# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-06

### Added
- **SCIP Integration (Compiler-Grade Accuracy):** If a project has a `tsconfig.json`, `varch scan` will automatically run `scip-typescript` and upgrade `likely` edges to `exact` by matching compiler references. Pure JavaScript projects gracefully fall back to Tree-sitter-only resolution.

### Fixed
- SCIP symbol extraction now correctly ignores function parameters and local variables, preventing them from overwriting the actual function definitions.
- Edge upgrades now match on symbol names and file IDs rather than exact line numbers, resolving conflicts between Tree-sitter and SCIP line offsets.

## [0.1.1] - 2026-11-05

### Fixed
- **CRITICAL:** Fixed an N+1 database query bottleneck and a WebAssembly memory leak that caused hangs and crashes on massive monorepos (tested successfully on Next.js with 25,807 files).
- **CRITICAL:** Capped `varch impact` output to 15 results to prevent overflowing LLM context windows when used via the MCP server.

## [0.1.0] - 2026-11-04

Pre-alpha release. Parser, indexer, search, impact analysis, local HTTP daemon, and MCP server.

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
- Two-pass scan: symbols extracted first, then edges resolved. Enables forward-reference resolution.
- Parser supports JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`) and TypeScript (`.ts`, `.tsx`) via separate grammars
- MCP server (`dist/mcp-server.js`): exposes the local index to MCP hosts (Cursor, VS Code, Claude Desktop) over stdio
  - Tools: `varch_search` (symbol lookup), `varch_impact` (callers with confidence tiers), `varch_status` (watcher/index freshness)
  - Forwards to the running daemon via `.archeologist/port`; project root set by `VARCH_ROOT`
  - Returns readable `isError` results when the daemon isn't running, so the model can tell the user to start `varch serve`

### Fixed

- Parser now extracts assignment expressions like `app.set = function() {}` and `module.exports = function() {}`. This dramatically improves symbol coverage on older, prototype-based codebases like Express.
- `varch` binary has a shebang (`#!/usr/bin/env node`), so it runs correctly after `npm link` / `npm install -g`
- Duplicate test runs eliminated via explicit `include` in `vitest.config.ts` (compiled test files in `dist/` were also being picked up)
- Function expressions (`const x = function() {}`) are now extracted as symbols. Async variants work too.
- File watcher auto-enables polling on WSL `/mnt/*` paths. Detection uses `resolve(root).startsWith("/mnt/")` so relative roots like `.` are resolved first.

### Known limitations

- **JavaScript and TypeScript only.** Python, Go, C++, and others are planned.
- **No import-aware resolution.** `likely` means "unique name match in the index," not "verified via import graph." This is why `exact` never appears in practice yet.
- **Transitive impact confidence reflects the last hop, not the weakest link.**
- **Test files (`.test.ts`, `.spec.ts`) are indexed alongside source.** No file-level include/exclude filtering yet.
- **No incremental indexing.** `varch scan` clears and rebuilds the full index each run.
- **Anonymous arrow functions attribute calls to the outer function.** The arrow has no name to attach calls to.
- **Dynamically created methods are invisible to static analysis.** Varch reports only statically-declared symbols.
- **Real-world accuracy lower than 100%.** Expect 50-75% precision on medium repos with name-based resolution.
- **Schema changes require deleting `.archeologist/`** and re-scanning. No migration system yet.
- **`varch serve` runs in the foreground.** True background mode is deferred.
- **Concurrent scan during serve.** Running `varch scan .` while `varch serve` is active can race with the watcher's own re-scan. Avoid running both at once.
- **Polling overhead on WSL `/mnt/*` paths.** Move the project to WSL's native filesystem (`~/repos/`) to use inotify.
- **Watcher fires on non-source changes.** Editing `README.md` triggers a re-scan that does nothing useful.
- **`varch stop` PID reuse risk.** Mitigated by verifying `/health` before SIGTERM.
- **Pinned to chokidar v3.** v4+ removed glob support from the `ignored` option.
- **MCP server requires the daemon.** `varch serve` must be running for MCP tools to work.
- **MCP tools return plain text, not structured content.**
- **MCP tool list is 3 tools.** `search`, `impact`, `status` cover the core questions.

### Planned

- Import-aware resolution: promotes `likely` -> `exact` where provable via import graph (SCIP)
- File-level filtering: `--exclude "**/*.test.ts"` or config-file equivalent
- Python support
- Incremental scanning: only re-parse changed files instead of full rebuild
- Background daemon mode: detach from terminal, survive terminal close
- Schema migration system (blocking for v1.0.0 stable release)
- Go port of the parser (only if real users complain about performance at scale)

[Unreleased]: https://github.com/voltroniq/voltroniq-arch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/voltroniq/voltroniq-arch/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/voltroniq/voltroniq-arch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/voltroniq/voltroniq-arch/releases/tag/v0.1.0