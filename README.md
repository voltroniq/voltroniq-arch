# voltroniq-arch

> **Status: Pre-alpha (active development).** Parser, indexer, search,
> impact analysis, local HTTP daemon, and MCP integration work for JavaScript and
> TypeScript.

A local-first code intelligence tool for legacy and unfamiliar codebases.

## What works today

- Tree-sitter-based parsing of JavaScript and TypeScript files
- Extracts functions, classes, methods, arrow functions, function expressions, and prototype assignments (`app.set = function() {}`)
- `varch scan` - indexes an entire folder into SQLite
- `varch search` - fast symbol lookup via FTS5 trigram with LIKE fallback
- `varch impact` - find direct and transitive callers (depth-limited)
- `varch serve` - local HTTP daemon with a file watcher (index updates on save)
- `varch stop` / `varch status` - manage the running daemon from any terminal
- Confidence tiers: `likely` (unique match), `heuristic` (ambiguous), `unknown` (external)
- Two-pass scan: symbols first, then edges - resolves forward references correctly
- 34 passing tests
- `npm run accuracy` reports precision/recall on a hand-labeled fixture (100% baseline)
- MCP server - exposes search, impact, and status as tools for Cursor / VS Code / Claude Desktop

## Install

    git clone git@github.com:voltroniq/voltroniq-arch.git
    cd voltroniq-arch
    npm install
    npm run build
    npm link        # makes `varch` available globally on your machine

## Usage

    # Index a directory (creates .archeologist/db.sqlite)
    varch scan .

    # Search indexed symbols
    varch search openDb

    # Find callers of a symbol
    varch impact scanDirectory
    varch impact walk --depth 4

    # Start the daemon (watches for file changes and re-indexes on save)
    varch serve

    # From another terminal: check status, stop when done
    varch status
    varch stop

Example output:

    $ varch impact stringReplaceAll

    Impact analysis for "stringReplaceAll"
    ======================================

    Direct callers (1):
      applyStyle           source/index.js:216  [likely]

    Transitive callers (1, up to depth 3):
      [d2] builder          source/index.js:178  via applyStyle  [likely]

## HTTP API

When `varch serve` is running, it exposes the index as JSON on localhost:

    GET /health                     - { ok, files, symbols, edges }
    GET /api/search?q=...           - symbol search
    GET /api/impact?name=...&depth= - impact analysis
    GET /api/stats                  - edge confidence distribution
    GET /api/status                 - daemon state (watcher, last scan, scan count)

The daemon port is written to `.archeologist/port` on startup. Any tool can
read that file to discover the running daemon. The process ID is written to
`.archeologist/pid` for `varch stop` to use.

## Using with Cursor / Claude Desktop (MCP)

varch exposes its index to AI hosts via the Model Context Protocol (MCP). 
To use it, you need to tell your AI host how to launch the varch MCP server.

**Prerequisite:** You must have run `npm run build` in this repo, and `varch serve` must be running in your project directory.

### For Cursor

1. Create a file at `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global access).
2. Add the following configuration, **replacing `/absolute/path/to/voltroniq-arch` with the actual path to this repository**:

    ```json
    {
      "mcpServers": {
        "varch": {
          "command": "node",
          "args": ["/absolute/path/to/voltroniq-arch/dist/mcp-server.js"],
          "env": {
            "VARCH_ROOT": "/absolute/path/to/your/project"
          }
        }
      }
    }
    ```

Tools exposed: `varch_search`, `varch_impact`, `varch_status`.

### For Windows / WSL Users (Important)

If you are running Cursor as a Windows application but your code lives inside WSL (e.g., `/mnt/c/...`), you **must** use Windows-style paths with double backslashes in the JSON file. WSL paths will fail:

    ```json
    {
      "mcpServers": {
        "varch": {
          "command": "node",
          "args": ["C:\\path\\to\\voltroniq-arch\\dist\\mcp-server.js"],
          "env": {
            "VARCH_ROOT": "C:\\path\\to\\your\\project"
          }
        }
      }
    }
    ```

## What's coming

- Import-aware resolution (promotes `likely` -> `exact` where provable)
- Python and additional language support

## Known limitations

- JavaScript and TypeScript only (Python and others planned)
- No import-aware resolution yet - "likely" means "unique name match," not "verified import." AI agents may need to filter out false positives.
- Transitive impact confidence reflects the last hop, not the weakest link in the chain
- Test files (.test.ts, .spec.ts) are indexed alongside source - no file-level filtering yet
- No incremental indexing - varch scan rebuilds the full index each run
- varch serve runs in the foreground - closing the terminal stops the daemon. Use varch stop from another terminal to stop it without closing.
- Polling overhead on WSL /mnt/* paths - move the project to ~/repos/ for faster inotify-based watching

## Development

    npm test               # run tests
    npm run accuracy       # precision/recall on fixture
    npx tsc --noEmit       # type-check
    varch                  # CLI (after npm link)

## Testing on another repository

If you have `varch` installed (via `npm link` or `npm install -g`):

    cd ~/repos/some-project
    varch scan .
    varch search someFunction
    varch impact someFunction

The index is written to `.archeologist/db.sqlite` in the current directory.

To keep the index outside the target repo:

    VARCH_DB=~/varch-scratch.sqlite varch scan .
    VARCH_DB=~/varch-scratch.sqlite varch impact someFunction

## License

MIT