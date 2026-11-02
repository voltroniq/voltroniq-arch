# voltroniq-arch

> **Status: Pre-alpha (active development).** Parser, indexer, search, and
> impact analysis work for JavaScript and TypeScript. MCP integration coming next.

A local-first code intelligence tool for legacy and unfamiliar codebases.

## What works today

- Tree-sitter–based parsing of JavaScript and TypeScript files
- Extracts functions, classes, methods, and arrow functions (ignores strings/comments)
- `scan` command: indexes an entire folder into SQLite
- `search` command: fast symbol lookup via FTS5 trigram with LIKE fallback
- `impact` command: find direct and transitive callers (depth-limited)
- Confidence tiers: `likely` (unique match), `heuristic` (ambiguous), `unknown` (external)
- Two-pass scan: symbols first, then edges — resolves forward references correctly
- 32 passing tests
- `npm run accuracy` reports precision/recall on a hand-labeled fixture (100% baseline)

## Usage

    # Index a directory (creates .archeologist/db.sqlite)
    varch scan .

    # Search indexed symbols
    varch search openDb

    # Find callers of a symbol
    varch impact scanDirectory
    varch impact walk --depth 4

Example output:

    $ varch impact stringReplaceAll

    Impact analysis for "stringReplaceAll"
    ======================================

    Direct callers (1):
      applyStyle           source/index.js:216  [likely]

    Transitive callers (1, up to depth 3):
      [d2] builder          source/index.js:178  via applyStyle  [likely]

## What's coming

- MCP server for Cursor / Claude Desktop
- File watcher daemon (auto-update index on save)
- Import-aware resolution (promotes `likely` → `exact` where provable)
- Python and additional language support

## Known limitations

- JavaScript and TypeScript only (Python and others planned)
- No import-aware resolution yet — "likely" means "unique name match," not "verified import"
- Transitive impact confidence reflects the last hop, not the weakest link in the chain
- Test files (`.test.ts`, `.spec.ts`) are indexed alongside source — no file-level filtering yet
- No incremental indexing — `scan` rebuilds the full index each run
- `const x = function() {}` (function expression) not yet extracted; only `const x = () => {}` (arrow)

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

## If you're developing varch locally

    git clone git@github.com:voltroniq/voltroniq-arch.git
    cd voltroniq-arch
    npm install
    npm run build
    npm link        # makes `varch` available globally on your machine

Then, from any project:

    varch scan .
    varch search myFunc

## License

MIT