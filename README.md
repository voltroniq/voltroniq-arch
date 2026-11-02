# voltroniq-arch

> **Status: Pre-alpha (active development).** Parser, indexer, and search
> work for JavaScript and TypeScript. MCP integration coming next.

A local-first code intelligence tool for legacy and unfamiliar codebases.

## What works today

- Tree-sitter–based parsing of JavaScript and TypeScript files
- Extracts functions, classes, and methods (ignores strings/comments)
- `scan` command: indexes an entire folder into SQLite
- `search` command: fast symbol search via FTS5 trigram
- 12 passing tests

## Usage

    git clone git@github.com:voltroniq/voltroniq-arch.git
    cd voltroniq-arch
    npm install

    # Index a directory (creates .archeologist/db.sqlite)
    npx tsx src/index.ts scan .

    # Search indexed symbols
    npx tsx src/index.ts search openDb

Example output:

    1 result(s) for "openDb":
      function openDb                 src/storage.ts:49

## What's coming

- MCP server for Cursor / Claude Desktop
- Cross-file symbol resolution
- Impact analysis ("what breaks if I change X?")

## Known limitations

- JavaScript and TypeScript only (Python and others planned)
- No cross-file call graph yet — search finds definitions, not callers
- No incremental indexing — `scan` rebuilds the full index each run

## Development

    npm test               # run tests
    npx tsc --noEmit       # type-check
    npx tsx src/index.ts   # CLI

## License

MIT